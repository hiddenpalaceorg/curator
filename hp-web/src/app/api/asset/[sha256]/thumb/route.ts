import fs from "node:fs";
import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { getAssetMeta } from "@/lib/assets";
import { ensureThumb } from "@/lib/ffmpeg";
import { conversionBusyResponse } from "@/lib/conversion-queue";
import { IMMUTABLE_CACHE, SANDBOX_CSP, streamResponse } from "@/lib/http";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/thumb — a poster still (JPEG) pulled out of a video
// asset, for gallery cards and <video poster>. Produced by ffmpeg on first
// use and cached in the store under .thumb/. The URL is content-addressed, so
// responses cache hard; clients treat a failure (no ffmpeg on the server, or
// a stream with no decodable frame) as "no poster" and degrade.

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getAssetMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });
  if (!meta.mime.startsWith("video/")) {
    return Response.json({ error: `no thumbnail for ${meta.mime}` }, { status: 415 });
  }

  // The browser already holds an immutable copy: never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}-thumb"`) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha256}-thumb"` },
    });
  }

  let thumb: string;
  try {
    thumb = await ensureThumb(sha256);
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    // No usable ffmpeg, blob missing from the store, or no decodable frame.
    return Response.json({ error: "no thumbnail" }, { status: 415 });
  }
  const stat = await fsp.stat(thumb);
  const stream = fs.createReadStream(thumb);
  return streamResponse(stream, stat.size, null, {
    "Content-Type": "image/jpeg",
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: `"${sha256}-thumb"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
  });
}
