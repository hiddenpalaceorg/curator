import { readBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures, semanticDoc } from "@/lib/fingerprint";
import { findSimilar, findByEmbedding, logCheck } from "@/lib/queries";
import { getModerator } from "@/lib/auth";
import { embed, toPgVector } from "@/lib/embed";
import { MAX_BODY_BYTES, validateBuildRecord } from "@/lib/validate";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST a canonical BuildRecord; returns fused similar-build neighbors. Read-only:
// the submitted build is logged (by sha256) but not ingested.
export async function POST(request: NextRequest) {
  if (!rateLimit(`similarity:${clientKey(request)}`, 30, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  const bytes = await readBody(request, MAX_BODY_BYTES);
  if (bytes instanceof Response) return bytes;
  const text = new TextDecoder().decode(bytes);
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const v = validateBuildRecord(parsed);
  if (!v.ok) {
    return Response.json({ error: v.error }, { status: 422 });
  }
  const record: BuildRecord = v.record;

  try {
    const pool = getPool();
    const includePrivate = !!(await getModerator(request));
    const q = deriveQueryFeatures(record);
    await logCheck(pool, q.sha256);
    const result = await findSimilar(pool, q, 20, includePrivate);

    // Text: semantic neighbors via the text embedding (build identity, not the
    // filename-heavy text_doc — must match what the ingester embedded).
    let text_neighbors: Awaited<ReturnType<typeof findByEmbedding>> = [];
    const sdoc = semanticDoc(record);
    if (sdoc) {
      const vec = toPgVector(await embed(sdoc));
      text_neighbors = await findByEmbedding(pool, vec, q.sha256 ?? "", 20, includePrivate);
    }

    return Response.json({ query: { sha256: q.sha256, name: q.name }, ...result, text_neighbors });
  } catch (e) {
    // This path does embedding inference + multi-tier SQL; a silent 500 is very
    // hard to diagnose in production, so log server-side (generic to the client).
    console.error("similarity check failed:", e);
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
