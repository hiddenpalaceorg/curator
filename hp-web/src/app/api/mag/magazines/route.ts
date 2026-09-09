import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { requireModerator } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { validateMagazineInput } from "@/lib/mag/kinds";
import { upsertMagazine } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mag/magazines — upsert a magazine by slug (moderator only; ingest
// tooling calls this before the first issue of a magazine). Optional fields
// left out keep their stored values, so a later ingest can't blank out a
// moderator's edits.
async function boundedPOST(request: NextRequest) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null);
  const v = validateMagazineInput(body);
  if (!v.ok) return Response.json({ error: v.error }, { status: 400 });
  const magazine = await upsertMagazine(getPool(), v.value);
  return Response.json({ magazine });
}

export const POST = withBoundedBody(boundedPOST);
