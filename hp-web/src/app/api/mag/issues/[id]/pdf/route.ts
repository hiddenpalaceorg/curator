import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { requireModerator, getModerator } from "@/lib/auth";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { getPool } from "@/lib/db";
import { PDF_CSP, streamResponse } from "@/lib/http";
import { getIssueById } from "@/lib/mag/queries";
import { MAG_NS } from "@/lib/mag/store";
import { createMagSession, newMagToken, PDF_MAX_BYTES } from "@/lib/mag/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  return /^\d{1,10}$/.test(raw) ? parseInt(raw, 10) : null;
}

// POST /api/mag/issues/<id>/pdf { size } -> { token }: open a chunked upload
// session for the issue's source PDF (moderator only). Chunks go to
// PUT /api/mag/issues/<id>/pdf/<token>?offset=N.
async function boundedPOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return Response.json({ error: "invalid issue id" }, { status: 400 });
  const pool = getPool();
  const issue = await getIssueById(pool, id);
  if (!issue) return Response.json({ error: "no such issue" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { size?: unknown } | null;
  const size = body?.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return Response.json({ error: "size (bytes) is required" }, { status: 400 });
  }
  if (size > PDF_MAX_BYTES) return Response.json({ error: "pdf too large" }, { status: 413 });

  const mod = await getModerator(request);
  const token = newMagToken();
  await createMagSession(token, { issue: id, size, author: mod?.name ?? "token" });
  return Response.json({ token });
}

// GET /api/mag/issues/<id>/pdf — the source PDF, moderator only. Issue PDFs
// are never public: the public surface is page renders and crops.
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const id = parseId((await ctx.params).id);
  if (id === null) return Response.json({ error: "invalid issue id" }, { status: 400 });
  const pool = getPool();
  const issue = await getIssueById(pool, id);
  if (!issue?.pdf_sha256) return Response.json({ error: "no pdf" }, { status: 404 });

  const size = await blobSize(issue.pdf_sha256, MAG_NS);
  const stream = size === null ? null : await openBlobStream(issue.pdf_sha256, undefined, MAG_NS);
  if (size === null || !stream) return Response.json({ error: "pdf blob missing" }, { status: 404 });
  const name = `${issue.magazine_slug}-${issue.slug}.pdf`;
  return streamResponse(stream, size, null, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PDF_CSP,
  });
}

export const POST = withBoundedBody(boundedPOST);
