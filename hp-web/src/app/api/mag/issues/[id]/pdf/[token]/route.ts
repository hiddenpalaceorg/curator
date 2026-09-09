import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { requireModerator } from "@/lib/auth";
import { readBody } from "@/lib/request-body";
import { storeBlobFromFile } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { hashFile, withMediaSession } from "@/lib/media";
import { setIssuePdf } from "@/lib/mag/queries";
import { ensureIssueAssets, MAG_NS } from "@/lib/mag/store";
import {
  dropMagSession,
  finishMagSession,
  isMagToken,
  magStagingPath,
  PDF_MAX_CHUNK,
  readMagSession,
} from "@/lib/mag/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/mag/issues/<id>/pdf/<token>?offset=N — append one chunk of the
// issue's source PDF; the build-media chunk protocol verbatim (409 with the
// truth on a stale offset, replayable finalize, one request per token at a
// time). The first chunk must be a PDF; completion hashes, stores under
// mag/, records pdf_sha256 on the issue, and kicks the render job.
export async function PUT(request: NextRequest, ctx: { params: Promise<{ id: string; token: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const { id: rawId, token } = await ctx.params;
  if (!/^\d{1,10}$/.test(rawId)) return Response.json({ error: "invalid issue id" }, { status: 400 });
  if (!isMagToken(token)) return Response.json({ error: "invalid token" }, { status: 400 });
  const id = parseInt(rawId, 10);

  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");

  // Advisory pre-check before pulling the body (see the media route for why).
  const known = await readMagSession(token);
  if (known && known.issue === id) {
    if (known.done) return Response.json({ done: true, sha256: known.done.sha256 });
    const st = await fsp.stat(magStagingPath(token)).catch(() => null);
    if (st && st.size < known.size && offset !== st.size) {
      return Response.json({ offset: st.size }, { status: 409 });
    }
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PDF_MAX_CHUNK) return Response.json({ error: "chunk too large" }, { status: 413 });
  const bytes = await readBody(request, PDF_MAX_CHUNK);
  if (bytes instanceof Response) return bytes;
  const chunk = Buffer.from(bytes);

  return withMediaSession(`magpdf-${token}`, () => append(id, token, chunk, offset));
}

async function append(id: number, token: string, chunk: Buffer, offset: number): Promise<Response> {
  const session = await readMagSession(token);
  if (!session || session.issue !== id) {
    return Response.json({ error: "no such upload session" }, { status: 404 });
  }
  if (session.done) return Response.json({ done: true, sha256: session.done.sha256 });
  const staging = magStagingPath(token);
  const st = await fsp.stat(staging).catch(() => null);
  if (!st) return Response.json({ error: "no such upload session" }, { status: 404 });
  let staged = st.size;
  if (staged > session.size) {
    await dropMagSession(token);
    return Response.json({ error: "corrupt upload session" }, { status: 400 });
  }

  if (staged < session.size) {
    if (!Number.isInteger(offset) || offset < 0) {
      return Response.json({ error: "invalid offset" }, { status: 400 });
    }
    if (offset !== staged) return Response.json({ offset: staged }, { status: 409 });
    if (!chunk.length) return Response.json({ error: "empty chunk" }, { status: 400 });
    if (chunk.length > PDF_MAX_CHUNK) return Response.json({ error: "chunk too large" }, { status: 413 });
    if (staged + chunk.length > session.size) {
      return Response.json({ error: "chunk exceeds the claimed size" }, { status: 400 });
    }
    if (staged === 0 && !chunk.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      await dropMagSession(token);
      return Response.json({ error: "not a pdf" }, { status: 415 });
    }
    await fsp.appendFile(staging, chunk);
    staged = (await fsp.stat(staging)).size;
    if (staged < session.size) return Response.json({ done: false, offset: staged });
    if (staged > session.size) {
      await dropMagSession(token);
      return Response.json({ error: "corrupt upload session" }, { status: 400 });
    }
  }

  // Complete (possibly a retried finalize): hash, store, record, kick render.
  const sha256 = await hashFile(staging);
  await storeBlobFromFile(sha256, staging, { ns: MAG_NS, keepSource: true });
  const pool = getPool();
  await setIssuePdf(pool, id, sha256, session.size);
  await finishMagSession(token, session, sha256);
  ensureIssueAssets(pool, id);
  return Response.json({ done: true, sha256 });
}
