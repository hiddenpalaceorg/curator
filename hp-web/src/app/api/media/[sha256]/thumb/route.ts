import fs from "node:fs";
import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { ensurePhotoScale, isPhotoScaleWidth } from "@/lib/ffmpeg";
import { conversionBusyResponse } from "@/lib/conversion-queue";
import { IMMUTABLE_CACHE, SANDBOX_CSP, streamResponse } from "@/lib/http";
import { MEDIA_NS, mediaContentType, mediaUrl } from "@/lib/media";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/media/<sha256>/thumb?w=<500|1000> — a scaled-down JPEG (default
// ≤1000px wide) of one image media blob, from the same ffmpeg cache the OG
// card draws on. Camera photos and scans run to many MB; inline previews
// shouldn't. Content-addressed, so responses cache hard.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const wParam = request.nextUrl.searchParams.get("w");
  const width = wParam === null ? 1000 : Number(wParam);
  if (!isPhotoScaleWidth(width)) return Response.json({ error: "w must be 500 or 1000" }, { status: 400 });

  const contentType = await mediaContentType(getPool(), sha256);
  if (!contentType) return Response.json({ error: "not found" }, { status: 404 });
  if (!contentType.startsWith("image/")) {
    return Response.json({ error: `no thumbnail for ${contentType}` }, { status: 415 });
  }

  // The browser already holds an immutable copy: never re-send the bytes.
  const etag = `"${sha256}-photothumb-${width}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: etag },
    });
  }

  let scaled: string;
  try {
    scaled = await ensurePhotoScale(sha256, MEDIA_NS, width);
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    // No usable ffmpeg or undecodable bytes — the original still renders.
    return Response.redirect(new URL(mediaUrl(sha256, contentType), request.url), 307);
  }
  const stat = await fsp.stat(scaled);
  const stream = fs.createReadStream(scaled);
  return streamResponse(stream, stat.size, null, {
    "Content-Type": "image/jpeg",
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
  });
}
