import fs from "node:fs";
import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { getAssetMeta } from "@/lib/assets";
import { readBlobHead } from "@/lib/blobstore";
import { ensureAudioTranscode } from "@/lib/ffmpeg";
import { conversionBusyResponse } from "@/lib/conversion-queue";
import { IMMUTABLE_CACHE, SANDBOX_CSP, contentDisposition, streamResponse } from "@/lib/http";
import { parseRange } from "@/lib/range";
import { isSha256 } from "@/lib/validate";
import { wavBrowserPlayable } from "@/lib/wav";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/audio — where <audio> should stream a WAV from.
// Console builds carry WAVs whose codec is an ADPCM variant browsers won't
// decode (e.g. Xbox ADPCM, format tag 0x0069). The extractor stamps them all
// audio/wav, so the codec check reads the fmt chunk from the blob itself.
// Natively playable WAVs (PCM, float, A-law, µ-law) redirect to the raw asset
// route, keeping one copy in the browser cache. The rest are transcoded once
// to 16-bit PCM WAV, cached on disk, and streamed with Range support. The URL
// is content-addressed, so responses cache hard.

export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getAssetMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  // Relative Location: request.url behind the reverse proxy is the internal
  // origin (localhost:6800), which must never leak into a redirect target.
  const toRaw = () =>
    new Response(null, {
      status: 308,
      headers: { Location: `/api/asset/${sha256}`, "Cache-Control": IMMUTABLE_CACHE },
    });

  if (meta.mime !== "audio/wav") {
    // Only WAV hides its codec behind one mime. Every other audio format we
    // extract plays as-is.
    if (/^audio\//.test(meta.mime)) return toRaw();
    return Response.json({ error: `no audio transcode for ${meta.mime}` }, { status: 415 });
  }

  // The browser already holds an immutable copy of the transcode (this ETag
  // is only ever set on transcoded responses): never re-send the bytes.
  if (request.headers.get("if-none-match") === `"${sha256}-audio"`) {
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": IMMUTABLE_CACHE, ETag: `"${sha256}-audio"` },
    });
  }

  const head = await readBlobHead(sha256);
  if (head === null) return Response.json({ error: "asset bytes not in store" }, { status: 404 });
  if (wavBrowserPlayable(head)) return toRaw();

  // No soft-wait/202 dance like video: ADPCM to PCM runs far faster than
  // real time, so even the biggest WAVs in the corpus finish within the
  // request.
  let audioPath: string;
  try {
    audioPath = await ensureAudioTranscode(sha256);
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    // No usable ffmpeg, blob missing from the store, or ffmpeg rejected or
    // timed out on the input.
    return Response.json({ error: "untranscodable audio" }, { status: 415 });
  }
  const stat = await fsp.stat(audioPath);

  const name = meta.path.split("/").pop() || `${sha256}.wav`;
  const headers: Record<string, string> = {
    "Content-Type": "audio/wav",
    "Content-Disposition": contentDisposition(name, true),
    "Cache-Control": IMMUTABLE_CACHE,
    ETag: `"${sha256}-audio"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
    "Accept-Ranges": "bytes",
  };

  // Single-range support so <audio> can seek.
  const range = parseRange(request.headers.get("range"), stat.size);
  const stream = fs.createReadStream(audioPath, range ? { start: range.start, end: range.end } : {});
  return streamResponse(stream, stat.size, range, headers);
}
