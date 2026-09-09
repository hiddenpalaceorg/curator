import type { NextRequest } from "next/server";
import { getModerator, requireModerator } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { isExtractKind, normalizeLang } from "@/lib/mag/kinds";
import {
  AMENDABLE_FIELDS,
  amendExtract,
  getExtract,
  listExtractRevisions,
  type AmendableField,
  type AmendPatch,
} from "@/lib/mag/queries";
import { ensureIssueAssets } from "@/lib/mag/store";
import { MAG_IMAGE_HEADERS } from "@/lib/mag/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mag/extracts/<id> — one extract with regions and links. Rejected
// extracts are visible only to moderators (they stay in the DB as the audit
// substrate, not on the public surface). ?revisions=1 adds the audit trail
// (moderator only).
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) return Response.json({ error: "invalid extract id" }, { status: 400 });
  const pool = getPool();
  const mod = await getModerator(request);
  const extract = await getExtract(pool, parseInt(raw, 10), !!mod);
  if (!extract) return Response.json({ error: "not found" }, { status: 404 });
  if (extract.status === "rejected" && !mod) return Response.json({ error: "not found" }, { status: 404 });
  if (mod && request.nextUrl.searchParams.get("revisions") === "1") {
    const revisions = await listExtractRevisions(pool, extract.id);
    return Response.json({ extract, revisions }, { headers: MAG_IMAGE_HEADERS });
  }
  return Response.json({ extract }, { headers: MAG_IMAGE_HEADERS });
}

// PATCH /api/mag/extracts/<id> — moderator amendment. Body: { fields?,
// regions?, note? }. Every change lands in extract_revision; a bbox change
// resets the affected crops and re-kicks the crop job.
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) return Response.json({ error: "invalid extract id" }, { status: 400 });
  const id = parseInt(raw, 10);

  const body = (await request.json().catch(() => null)) as AmendPatch | null;
  if (!body || typeof body !== "object") return Response.json({ error: "invalid body" }, { status: 400 });

  const patch: AmendPatch = { note: typeof body.note === "string" ? body.note.slice(0, 2000) : undefined };
  if (body.fields) {
    if (typeof body.fields !== "object") return Response.json({ error: "fields must be an object" }, { status: 400 });
    patch.fields = {};
    for (const [k, v] of Object.entries(body.fields)) {
      if (!(AMENDABLE_FIELDS as readonly string[]).includes(k)) {
        return Response.json({ error: `field not amendable: ${k}` }, { status: 400 });
      }
      patch.fields[k as AmendableField] = v;
    }
    if ("kind" in patch.fields && !isExtractKind(patch.fields.kind)) {
      return Response.json({ error: `unknown kind: ${String(patch.fields.kind)}` }, { status: 400 });
    }
    if ("language" in patch.fields) {
      const lang = normalizeLang(patch.fields.language);
      if (!lang) return Response.json({ error: "language must be a bcp47 code" }, { status: 400 });
      patch.fields.language = lang;
    }
  }
  if (body.regions) {
    if (
      !Array.isArray(body.regions) ||
      body.regions.length === 0 ||
      body.regions.some(
        (r) =>
          typeof r !== "object" ||
          !Number.isInteger(r.pdf_index) ||
          r.pdf_index < 1 ||
          [r.x, r.y, r.w, r.h].some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
      )
    ) {
      return Response.json({ error: "regions must be [{pdf_index, x, y, w, h}] in 0..1" }, { status: 400 });
    }
    patch.regions = body.regions;
  }
  if (!patch.fields && !patch.regions) {
    return Response.json({ error: "nothing to amend" }, { status: 400 });
  }

  const pool = getPool();
  const mod = await getModerator(request);
  const updated = await amendExtract(pool, id, patch, mod?.name ?? "token");
  if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  if (patch.regions) ensureIssueAssets(pool, updated.issue_id);
  return Response.json({ extract: updated });
}
