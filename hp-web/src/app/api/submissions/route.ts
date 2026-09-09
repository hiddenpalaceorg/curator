import { readBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { enqueueSubmission, listSubmissions } from "@/lib/queries";
import { requireModerator } from "@/lib/auth";
import { MAX_BODY_BYTES, MAX_NICKNAME_LEN, validateBuildRecord } from "@/lib/validate";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions?status=queued — the moderation queue. Requires moderator auth.
export async function GET(request: NextRequest) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const status = request.nextUrl.searchParams.get("status") ?? undefined;
  const items = await listSubmissions(getPool(), status);
  return Response.json({ submissions: items });
}

// POST { nickname, record } — enqueue a build for moderation/ingest (dedup by sha256).
export async function POST(request: NextRequest) {
  if (!rateLimit(`submissions:${clientKey(request)}`, 30, 60_000)) {
    return Response.json({ error: "rate limit exceeded" }, { status: 429 });
  }
  // Reject an oversized body by its declared length before buffering it whole
  // into memory; the post-read check still guards chunked requests that omit it.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }
  const bytes = await readBody(request, MAX_BODY_BYTES);
  if (bytes instanceof Response) return bytes;
  const text = new TextDecoder().decode(bytes);
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "request body too large" }, { status: 413 });
  }
  let body: { nickname?: string; record?: BuildRecord };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { nickname } = body;
  if (!nickname || typeof nickname !== "string") {
    return Response.json({ error: "require { nickname, record(with image.sha256) }" }, { status: 400 });
  }
  if (nickname.length > MAX_NICKNAME_LEN) {
    return Response.json({ error: `nickname exceeds ${MAX_NICKNAME_LEN} characters` }, { status: 400 });
  }
  const v = validateBuildRecord(body.record);
  if (!v.ok) {
    return Response.json({ error: v.error }, { status: 422 });
  }
  try {
    const { sha256, kind } = await enqueueSubmission(getPool(), nickname, v.record);
    return Response.json({ sha256, status: "queued", kind }, { status: 202 });
  } catch {
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
