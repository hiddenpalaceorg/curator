import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import {
  assetStagingPath,
  blobExists,
  hasStagingHeadroom,
  reapStaleAssetStaging,
  storeBlobFromFile,
} from "@/lib/blobstore";
import { referencedAssets, MAX_BUILD_ASSET_BYTES } from "@/lib/submission-assets";
import { rateLimitCheck, clientKey } from "@/lib/ratelimit";
import { isSha256 } from "@/lib/validate";
import { releaseReapedUploadQuota, withUploadQuota } from "@/lib/upload-quota";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/submissions/<sha256>/assets/<assetSha>[?offset=N] — upload one asset
// blob, in one shot or chunked (raw body). Accepted only when <assetSha> is
// referenced by the submission's (or an ingested build's) record; nothing else
// about the request is trusted — the content address is the authority.
//
// Chunk protocol: each request appends at `offset` (default 0; 0 restarts) to
// a staging file. A wrong offset answers 409 with the staged size so the
// client can resume; a short append answers 202 with the new offset. When the
// staged size reaches the record's claimed size the file must hash to
// <assetSha> — then it lands in the store (201) — or staging is dropped (422).
// The final hash makes interleaved/duplicate chunk writes harmless: they can
// only cost a retry, never store wrong bytes. Idempotent by construction.
//
// Staging abandoned by a crashed client is bounded (referenced assets only)
// and reclaimed the next time that blob's upload restarts at offset 0.
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ sha256: string; assetSha: string }> }
) {
  // Generous: a bulk desktop upload is many chunk PUTs, a few in parallel (a
  // 4096-asset build is legitimate). On limit, answer 429 with `retryAfter`
  // (seconds) so the clients can wait out the window and resume.
  const rl = rateLimitCheck(`assets-put:${clientKey(request)}`, 6000, 60_000);
  if (!rl.ok) {
    const retryAfter = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
    return Response.json(
      { error: "rate limit exceeded", retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } }
    );
  }
  const { sha256, assetSha } = await ctx.params;
  if (!isSha256(sha256) || !isSha256(assetSha)) {
    return Response.json({ error: "invalid sha256" }, { status: 400 });
  }

  const refs = await referencedAssets(getPool(), sha256);
  if (!refs) return Response.json({ error: "not found" }, { status: 404 });
  const claimed = refs.sizes.get(assetSha);
  if (claimed === undefined) {
    return Response.json({ error: "asset not referenced by this build" }, { status: 404 });
  }
  if (refs.totalBytes > MAX_BUILD_ASSET_BYTES) {
    return Response.json({ error: "build's total asset bytes exceed the cap" }, { status: 413 });
  }

  return withUploadQuota(getPool(), assetSha, claimed, async () => {
  if (await blobExists(assetSha)) return Response.json({ sha256: assetSha, status: "exists" });

  const rawOffset = new URL(request.url).searchParams.get("offset") ?? "0";
  const offset = Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > claimed) {
    return Response.json({ error: "invalid offset" }, { status: 400 });
  }
  if (!request.body) return Response.json({ error: "missing body" }, { status: 400 });

  // Reap abandoned staging, then refuse to grow it when the disk is low: the
  // endpoint is unauthenticated, so a partial-upload flood must never fill the
  // store out from under Postgres and the transcode caches. The reserve is kept
  // regardless of how many distinct blobs are in flight.
  await releaseReapedUploadQuota(getPool(), await reapStaleAssetStaging());
  if (!(await hasStagingHeadroom(claimed - offset))) {
    return Response.json({ error: "insufficient storage" }, { status: 507 });
  }

  // A non-zero offset must continue exactly where the staging file ends.
  const part = assetStagingPath(assetSha);
  if (offset !== 0) {
    let staged = 0;
    try {
      staged = (await fsp.stat(part)).size;
    } catch {}
    if (offset !== staged) {
      return Response.json({ error: "offset mismatch", offset: staged }, { status: 409 });
    }
  }

  // Append the chunk as it streams in, dying early past the claimed size.
  await fsp.mkdir(path.dirname(part), { recursive: true });
  const fh = await fsp.open(part, offset === 0 ? "w" : "a");
  let received = 0;
  let overrun = false;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (offset + received > claimed) {
        overrun = true;
        reader.cancel().catch(() => {});
        break;
      }
      await fh.write(value);
    }
  } finally {
    await fh.close();
  }
  if (overrun) {
    await fsp.rm(part, { force: true }).catch(() => {});
    return Response.json({ error: "body exceeds the record's claimed size" }, { status: 413 });
  }

  const size = offset + received;
  if (size < claimed) {
    return Response.json({ sha256: assetSha, status: "partial", offset: size }, { status: 202 });
  }

  // Complete: the staged bytes must hash to the content address.
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(part)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== assetSha) {
    await fsp.rm(part, { force: true }).catch(() => {});
    return Response.json({ error: "staged bytes do not hash to the asset sha256" }, { status: 422 });
  }

  // A concurrent upload of the same blob may have finalized first — same
  // bytes either way, so "exists" is as good as "stored".
  const outcome = await storeBlobFromFile(assetSha, part);
  if (outcome === "exists") return Response.json({ sha256: assetSha, status: "exists" });
  return Response.json({ sha256: assetSha, status: "stored" }, { status: 201 });
  });
}
