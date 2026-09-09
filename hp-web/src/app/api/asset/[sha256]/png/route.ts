import type { NextRequest } from "next/server";
import { getAssetMeta } from "@/lib/assets";
import { readBlob } from "@/lib/blobstore";
import { gsAvailable, gsRenderable, gsToPng } from "@/lib/gs";
import { IMMUTABLE_CACHE, contentDisposition } from "@/lib/http";
import { pngConvertible, toPng, WEB_SAFE_IMAGE } from "@/lib/imgpng";
import { psdConvertible, psdToPng } from "@/lib/psd";
import { isSha256 } from "@/lib/validate";
import { conversions, conversionBusyResponse } from "@/lib/conversion-queue";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/png — the asset converted to PNG, for og:image use
// on formats unfurlers won't render and inline display of formats browsers
// won't (today: BMP, TGA, and TIFF in-process, plus EPS/PS and PDF first
// pages through Ghostscript when the server has it). Web-safe formats
// redirect to the raw asset route; content-addressed, so responses cache hard.

// Bound what the in-process decoder will chew on (decoded size is capped
// separately by the converters' MAX_PIXELS). Matches the adapter's
// MAX_ASSET_SIZE so any stored image asset is convertible.
const MAX_CONVERT_BYTES = 64 * 1024 * 1024;

export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getAssetMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  if (WEB_SAFE_IMAGE.test(meta.mime)) {
    return Response.redirect(new URL(`/api/asset/${sha256}`, _request.url), 308);
  }
  const viaGs = gsRenderable(meta.mime) && (await gsAvailable());
  if (
    (!pngConvertible(meta.mime) && !psdConvertible(meta.mime) && !viaGs) ||
    meta.size > MAX_CONVERT_BYTES
  ) {
    return Response.json({ error: `no PNG conversion for ${meta.mime}` }, { status: 415 });
  }

  let png: Buffer | null;
  try {
    png = await conversions.run(`png:${sha256}:${meta.mime}`, async () => {
      const bytes = await readBlob(sha256);
      if (bytes === null) return null;
      return viaGs ? gsToPng(meta.mime, bytes)
        : psdConvertible(meta.mime) ? psdToPng(bytes) : toPng(meta.mime, bytes);
    });
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    return Response.json({ error: "undecodable image" }, { status: 415 });
  }
  if (png === null) return Response.json({ error: "asset bytes not in store" }, { status: 404 });

  const base = (meta.path.split("/").pop() || sha256).replace(/\.[^.]*$/, "");
  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": contentDisposition(`${base}.png`, true),
      "Cache-Control": IMMUTABLE_CACHE,
      ETag: `"${sha256}-png"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
