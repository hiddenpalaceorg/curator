import fs from "node:fs";
import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { ensurePhotoScale, isPhotoScaleWidth } from "@/lib/ffmpeg";
import { conversionBusyResponse } from "@/lib/conversion-queue";
import { IMMUTABLE_CACHE, SANDBOX_CSP, streamResponse } from "@/lib/http";
import { MAG_NS } from "@/lib/mag/store";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mag/blob/<sha256>/thumb?w=<500|1000> — scaled JPEG of a magazine
// page render or crop, from the shared ffmpeg photo-scale cache. Page strips
// and extract cards draw hundreds of images; full renders are ~2200px.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const wParam = request.nextUrl.searchParams.get("w");
  const width = wParam === null ? 500 : Number(wParam);
  if (!isPhotoScaleWidth(width)) return Response.json({ error: "w must be 500 or 1000" }, { status: 400 });

  const etag = `"${sha256}-magthumb-${width}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: etag } });
  }

  let scaled: string;
  try {
    scaled = await ensurePhotoScale(sha256, MAG_NS, width);
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    // No usable ffmpeg or missing blob — the original still renders.
    return Response.redirect(new URL(`/api/mag/blob/${sha256}`, request.url), 307);
  }
  const stat = await fsp.stat(scaled);
  return streamResponse(fs.createReadStream(scaled), stat.size, null, {
    "Content-Type": "image/jpeg",
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
  });
}
