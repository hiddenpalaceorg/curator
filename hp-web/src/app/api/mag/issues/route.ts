import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { requireModerator } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { validateIssueInput } from "@/lib/mag/kinds";
import { getMagazineBySlug, upsertIssue } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mag/issues — upsert an issue by (magazine slug, issue slug),
// moderator only. The magazine must already exist (POST /api/mag/magazines
// first); a typo'd magazine slug must not silently mint a new magazine.
async function boundedPOST(request: NextRequest) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  const v = validateIssueInput(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const pool = getPool();
  const magazine = await getMagazineBySlug(pool, v.value.magazine);
  if (!magazine) {
    return Response.json({ error: `no such magazine: ${v.value.magazine}` }, { status: 404 });
  }
  const issue = await upsertIssue(pool, magazine.id, v.value);
  return Response.json({ issue: { ...issue, magazine_slug: magazine.slug } });
}

export const POST = withBoundedBody(boundedPOST);
