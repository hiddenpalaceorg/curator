import fs from "node:fs";
import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { getAssetMeta } from "@/lib/assets";
import { ensureTranscode, transcodable } from "@/lib/ffmpeg";
import { conversionBusyResponse } from "@/lib/conversion-queue";
import { IMMUTABLE_CACHE, SANDBOX_CSP, contentDisposition, streamResponse } from "@/lib/http";
import { parseRange } from "@/lib/range";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/video — the asset transcoded to a browser-playable
// format (H.264/AAC MP4, or VP9/Opus WebM when the server's ffmpeg lacks
// libx264), for video formats browsers won't play natively: today MPEG-1/2
// program streams (.mpg, DVD .vob) and AVI. Native formats redirect to the raw
// asset route. The transcode is produced once, cached on disk, and streamed
// with Range support so the player can seek. The URL is content-addressed, so
// responses cache hard.
//
// Small inputs finish within the soft wait and stream from this same request.
// A DVD-sized input keeps transcoding in the background while this request
// answers 202 — the client polls ./video/status and comes back when ready.

// How long one request holds on for a transcode before handing off to the
// status-poll flow. Long enough for the short clips that dominate the corpus.
const SOFT_WAIT_MS = 25_000;

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getAssetMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  if (meta.mime === "video/mp4" || meta.mime === "video/webm") {
    // Relative Location: request.url behind the reverse proxy is the internal
    // origin (localhost:6800), which must never leak into a redirect target.
    return new Response(null, {
      status: 308,
      headers: { Location: `/api/asset/${sha256}`, "Cache-Control": IMMUTABLE_CACHE },
    });
  }
  if (!transcodable(meta.mime)) {
    return Response.json({ error: `no video transcode for ${meta.mime}` }, { status: 415 });
  }

  // The browser already holds an immutable copy: never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}-video"`) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha256}-video"` },
    });
  }

  let video: { path: string; mime: string };
  try {
    const job = ensureTranscode(sha256);
    const soft = await Promise.race([
      job,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SOFT_WAIT_MS).unref?.()),
    ]);
    if (soft === null) {
      // Still transcoding — it finishes in the background (the eventual
      // rejection, if any, surfaces through the status probe, not here).
      job.catch(() => {});
      return Response.json(
        { state: "transcoding" },
        { status: 202, headers: { "Cache-Control": "no-store" } }
      );
    }
    video = soft;
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    // No usable ffmpeg, blob missing from the store, or ffmpeg rejected or
    // timed out on the input.
    return Response.json({ error: "untranscodable video" }, { status: 415 });
  }
  const stat = await fsp.stat(video.path);

  const base = (meta.path.split("/").pop() || sha256).replace(/\.[^.]*$/, "");
  const ext = video.mime === "video/webm" ? "webm" : "mp4";
  const headers: Record<string, string> = {
    "Content-Type": video.mime,
    "Content-Disposition": contentDisposition(`${base}.${ext}`, true),
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: `"${sha256}-video"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
    "Accept-Ranges": "bytes",
  };

  // Single-range support so <video> can seek.
  const range = parseRange(request.headers.get("range"), stat.size);
  const stream = fs.createReadStream(video.path, range ? { start: range.start, end: range.end } : {});
  return streamResponse(stream, stat.size, range, headers);
}
