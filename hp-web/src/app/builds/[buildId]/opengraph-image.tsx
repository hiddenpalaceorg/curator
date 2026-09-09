// Social-preview card for a build (og:image / twitter:image), rendered with
// satori via next/og. Next's file convention wires it into <meta> for this
// segment and everything below it, so asset deep links inherit it too.
//
// Full-canvas row of up to three images with compact shaded metadata bands.
// Front physical media comes first, then one insert (other physical media),
// then PNG/JPEG/BMP/TGA/TIFF assets. Back media is omitted.

import fsp from "node:fs/promises";
import { ImageResponse } from "next/og";
import { readBlob } from "@/lib/blobstore";
import { ConversionBusy, conversions, socialPreviewResponse } from "@/lib/conversion-queue";
import {
  buildOgObjectFit,
  selectBuildOgImages,
  type BuildOgMediaImage,
} from "@/lib/build-og";
import { getPool } from "@/lib/db";
import { ensurePhotoScale } from "@/lib/ffmpeg";
import { pngConvertible, toPng } from "@/lib/imgpng";
import { MEDIA_NS } from "@/lib/media";
import { buildFacts, displayTitle } from "@/lib/meta";
import { getBuildMeta, resolveBuild, type BuildMetaRow } from "@/lib/queries";
import { parseBuildParam, SHORT_SHA_LEN } from "@/lib/slug";

export const runtime = "nodejs";
export const alt = "Build summary card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Satori decodes the screenshot in-process — skip pathological blobs.
const MAX_SHOT_BYTES = 8_000_000;

// Photos over this go through the cached ffmpeg downscale instead of being
// inlined whole — camera shots and scans routinely blow past what's worth
// pushing through satori for a social-preview pane.
const PHOTO_DIRECT_MAX_BYTES = 1_000_000;

interface MediaImageRow {
  sha256: string;
  content_type: string;
  size: number;
  label: string | null;
}

async function loadMediaThumbnail(sha256: string): Promise<string | null> {
  try {
    const base = process.env.SITE_URL ?? "https://hiddenpalace.org";
    const url = new URL(`/api/media/${sha256}/thumb?w=1000`, base);
    const response = await fetch(url, { cache: "force-cache", signal: AbortSignal.timeout(120_000) });
    const contentType = response.headers.get("content-type");
    try {
      if (response.status === 503) throw new ConversionBusy();
      if (!response.ok || !contentType?.startsWith("image/") || !response.body) return null;
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_SHOT_BYTES) return null;
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return `data:${contentType};base64,${Buffer.concat(chunks).toString("base64")}`;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  } catch (error) {
    if (error instanceof ConversionBusy) throw error;
    return null;
  }
}

// Oversized photos (and webp, which the card renderer can't decode) are served
// as 1000px JPEGs via ffmpeg for crisp full-canvas panes. If direct
// storage access fails, use the same thumbnail route that serves the build page.
async function loadMediaImage(row: MediaImageRow): Promise<string | null> {
  try {
    if (row.size > PHOTO_DIRECT_MAX_BYTES || row.content_type === "image/webp") {
      const scaled = await ensurePhotoScale(row.sha256, MEDIA_NS, 1000);
      const bytes = await fsp.readFile(scaled);
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }
    const bytes = await readBlob(row.sha256, MEDIA_NS);
    if (bytes !== null) {
      return `data:${row.content_type};base64,${bytes.toString("base64")}`;
    }
  } catch (error) {
    if (error instanceof ConversionBusy) throw error;
    // Fall through to the public thumbnail path.
  }
  return loadMediaThumbnail(row.sha256);
}

async function findMediaImages(sha256: string): Promise<BuildOgMediaImage<string>[]> {
  const r = await getPool().query(
    `SELECT sha256, content_type, size::float8 AS size, label FROM build_media
     WHERE build_sha256=$1 AND kind='physical'
       AND label IS DISTINCT FROM 'back'
       AND content_type IN ('image/png','image/jpeg','image/gif','image/webp')
     ORDER BY (label IS NOT DISTINCT FROM 'front') DESC, created_at, id LIMIT 16`,
    [sha256]
  );

  const rows = r.rows as MediaImageRow[];
  const images: BuildOgMediaImage<string>[] = [];
  for (const row of rows.filter(({ label }) => label === "front")) {
    const image = await loadMediaImage(row);
    if (image) images.push({ image, label: "front" });
    if (images.length === 3) return images;
  }

  for (const row of rows.filter(({ label }) => label !== "front")) {
    const image = await loadMediaImage(row);
    if (image) {
      images.push({ image, label: row.label });
      break;
    }
  }
  return images;
}

async function findAssetPictures(sha256: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];

  const r = await getPool().query(
    `SELECT sha256, mime FROM build_asset
     WHERE build_sha256=$1 AND kind='image'
       AND mime IN ('image/png','image/jpeg','image/bmp','image/x-tga','image/tiff')
       AND size <= $2
     ORDER BY size DESC LIMIT $3`,
    [sha256, MAX_SHOT_BYTES, Math.max(4, limit * 4)]
  );
  // A row's blob can be missing (metadata ingested before the bundle carrying
  // the bytes) or undecodable — fall through to the next-largest candidate.
  const images: string[] = [];
  for (const row of r.rows as Array<{ sha256: string; mime: string }>) {
    try {
      const image = await conversions.run(`og:${row.sha256}:${row.mime}`, async () => {
        const bytes = await readBlob(row.sha256);
        if (bytes === null) return null;
        return pngConvertible(row.mime)
          ? `data:image/png;base64,${toPng(row.mime, bytes).toString("base64")}`
          : `data:${row.mime};base64,${bytes.toString("base64")}`;
      });
      if (image === null) continue;
      images.push(image);
      if (images.length === limit) break;
    } catch (error) {
      if (error instanceof ConversionBusy) throw error;
      continue;
    }
  }
  return images;
}

function Card({
  meta,
  shots,
  mediaCount,
}: {
  meta: BuildMetaRow;
  shots: string[];
  mediaCount: number;
}) {
  const facts = buildFacts(meta);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "#0a0a0a",
        color: "#fafafa",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          height: 92,
          display: "flex",
          alignItems: "center",
          gap: 24,
          padding: "16px 28px",
          background: "#111111",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            fontSize: 16,
            letterSpacing: 5,
            color: "#b3b3b3",
          }}
        >
          HIDDEN PALACE
        </div>
        <div
          style={{
            minWidth: 0,
            display: "block",
            fontSize: 32,
            lineHeight: 1.05,
            lineClamp: 2,
          }}
        >
          {displayTitle(meta)}
        </div>
      </div>

      <div
        style={{
          width: "100%",
          flex: 1,
          minHeight: 0,
          display: "flex",
          background: "#171717",
        }}
      >
        {shots.map((shot, index) => (
          <div
            key={index}
            style={{
              display: "flex",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              height: "100%",
              overflow: "hidden",
              borderLeft: index === 0 ? "none" : "2px solid rgba(0,0,0,0.5)",
            }}
          >
            <img
              src={shot}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: buildOgObjectFit(index, mediaCount),
              }}
            />
          </div>
        ))}
      </div>

      <div
        style={{
          flexShrink: 0,
          height: 78,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
          padding: "13px 28px",
          background: "#111111",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {facts.map((fact) => (
            <div
              key={fact}
              style={{
                display: "flex",
                border: "1px solid rgba(255,255,255,0.28)",
                borderRadius: 8,
                padding: "5px 12px",
                fontSize: 17,
                color: "#f0f0f0",
              }}
            >
              {fact}
            </div>
          ))}
        </div>
        <div style={{ flexShrink: 0, fontSize: 16, color: "#b3b3b3" }}>
          {`${meta.sha256.slice(0, SHORT_SHA_LEN)} · hiddenpalace.org`}
        </div>
      </div>
    </div>
  );
}

// Materialize the PNG so satori failures (e.g. an undecodable blob) are
// catchable — then retry without images instead of 500ing the unfurl.
async function render(meta: BuildMetaRow, shots: string[], mediaCount: number): Promise<ArrayBuffer> {
  const img = new ImageResponse(<Card meta={meta} shots={shots} mediaCount={mediaCount} />, size);
  return img.arrayBuffer();
}

export default async function OgImage({ params }: { params: Promise<{ buildId: string }> }) {
  const { buildId } = await params;
  const parsed = parseBuildParam(buildId);
  if (!parsed) return new Response("not found", { status: 404 });
  const pool = getPool();
  const resolved = await resolveBuild(pool, parsed.hex, parsed.slug);
  const meta = resolved && (await getBuildMeta(pool, resolved.sha256));
  if (!meta) return new Response("not found", { status: 404 });

  return socialPreviewResponse(`build:${meta.sha256}`, async () => {
    const media = await findMediaImages(meta.sha256);
    const mediaImages = selectBuildOgImages(media, []);
    const assets = await findAssetPictures(meta.sha256, 3 - mediaImages.length);
    const shots = selectBuildOgImages(media, assets);
    try {
      return await render(meta, shots, mediaImages.length);
    } catch {
      return render(meta, [], 0);
    }
  });
}
