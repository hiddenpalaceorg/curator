import { withBoundedBody, readBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { requireModerator } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { MAX_BATCH, MAX_EXTRACT_BODY_BYTES, validateExtractInput } from "@/lib/mag/kinds";
import {
  deleteAutoExtracts,
  getIssueById,
  ingestExtract,
  setIssueStatus,
  type IngestResult,
} from "@/lib/mag/queries";
import { ensureIssueAssets } from "@/lib/mag/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mag/issues/<id>/extracts — ingest a batch of up to MAX_BATCH
// extracts (moderator only). Each item validates independently and lands (or
// fails) independently: one malformed capsule review must not sink the other
// 49. Idempotent by (issue, client_key): re-posting updates 'auto' rows and
// leaves moderated rows untouched (reported as skipped: "moderated").
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) return Response.json({ error: "invalid issue id" }, { status: 400 });
  const id = parseInt(raw, 10);
  const pool = getPool();
  const issue = await getIssueById(pool, id);
  if (!issue) return Response.json({ error: "no such issue" }, { status: 404 });

  const bytes = await readBody(request, MAX_BATCH * MAX_EXTRACT_BODY_BYTES);
  if (bytes instanceof Response) return bytes;
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
  const list = Array.isArray(body) ? body : Array.isArray((body as { extracts?: unknown[] })?.extracts) ? (body as { extracts: unknown[] }).extracts : null;
  if (!list) return Response.json({ error: "body must be an array of extracts" }, { status: 400 });
  if (list.length === 0) return Response.json({ results: [] });
  if (list.length > MAX_BATCH) {
    return Response.json({ error: `batch too large (max ${MAX_BATCH})` }, { status: 413 });
  }

  const results: IngestResult[] = [];
  for (const [i, item] of list.entries()) {
    const v = validateExtractInput(item);
    if (!v.ok) {
      const key = (item as { client_key?: unknown })?.client_key;
      results.push({
        client_key: typeof key === "string" ? key : `#${i}`,
        skipped: "error",
        error: v.error,
      });
      continue;
    }
    results.push(await ingestExtract(pool, id, v.value));
  }

  if (results.some((r) => "id" in r)) {
    if (issue.status === "new" || issue.status === "rendering") await setIssueStatus(pool, id, "extracted");
    ensureIssueAssets(pool, id); // crop the new regions in the background
  }
  return Response.json({ results });
}

// DELETE /api/mag/issues/<id>/extracts?only=auto — reset for re-ingest.
// The only=auto parameter is required on purpose: the route that deletes
// must say out loud that it cannot touch moderated rows.
async function boundedDELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) return Response.json({ error: "invalid issue id" }, { status: 400 });
  if (request.nextUrl.searchParams.get("only") !== "auto") {
    return Response.json({ error: "pass only=auto (moderated extracts are never deleted)" }, { status: 400 });
  }
  const deleted = await deleteAutoExtracts(getPool(), parseInt(raw, 10));
  return Response.json({ deleted });
}

export const DELETE = withBoundedBody(boundedDELETE);
