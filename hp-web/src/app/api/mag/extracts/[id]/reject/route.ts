import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getModerator, requireModerator } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { setExtractRejected } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mag/extracts/<id>/reject { rejected: true|false, note? } —
// hide an extract from the public surface (or restore it). Restoring lands
// on 'amended', not 'auto': a human vouched for it, so re-ingest must not
// overwrite it anymore.
async function boundedPOST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) return Response.json({ error: "invalid extract id" }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { rejected?: unknown; note?: unknown } | null;
  if (!body || typeof body.rejected !== "boolean") {
    return Response.json({ error: "body must carry rejected: true|false" }, { status: 400 });
  }
  const mod = await getModerator(request);
  const extract = await setExtractRejected(
    getPool(),
    parseInt(raw, 10),
    body.rejected,
    mod?.name ?? "token",
    typeof body.note === "string" ? body.note.slice(0, 2000) : undefined
  );
  if (!extract) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ extract });
}

export const POST = withBoundedBody(boundedPOST);
