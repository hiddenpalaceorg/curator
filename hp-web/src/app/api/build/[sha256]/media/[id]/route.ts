import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import {
  getContributor,
  contributionTarget,
  revalidateBuildPages,
  type ContributionTarget,
  type Contributor,
} from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { deleteMedia, getMediaById, isMediaLabel, mediaView, updateMediaLabel, type BuildMediaRow } from "@/lib/media";
import { isSha256 } from "@/lib/validate";
import type { Pool } from "pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared gate for both verbs: the entry must exist and the caller must be its
// uploader or a moderator.
async function requireOwnMedia(
  request: NextRequest,
  sha256: string,
  id: string
): Promise<
  | { ok: true; pool: Pool; target: ContributionTarget; contributor: Contributor; row: BuildMediaRow }
  | { ok: false; response: Response }
> {
  const fail = (status: number, error: string) => ({
    ok: false as const,
    response: Response.json({ error }, { status }),
  });
  if (!isSha256(sha256)) return fail(400, "invalid sha256");
  const mediaId = Number(id);
  if (!Number.isInteger(mediaId) || mediaId <= 0) return fail(400, "invalid id");

  const contributor = await getContributor(request);
  if (!contributor) return fail(401, "log in to the wiki first");
  const pool = getPool();
  const target = await contributionTarget(pool, sha256);
  if (!target) return fail(404, "not found");

  const row = await getMediaById(pool, sha256, mediaId);
  if (!row) return fail(404, "not found");
  if (row.author !== contributor.name && !contributor.moderator) {
    return fail(403, "only the uploader or a moderator can change this");
  }
  return { ok: true, pool, target, contributor, row };
}

// PATCH /api/build/<sha256>/media/<id> { label }: relabel one physical photo
// (front/back/other), by its own author or a moderator.
async function boundedPATCH(request: NextRequest, ctx: { params: Promise<{ sha256: string; id: string }> }) {
  const { sha256, id } = await ctx.params;
  const gate = await requireOwnMedia(request, sha256, id);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!isMediaLabel(body.label)) {
    return Response.json({ error: "label must be front, back, or other" }, { status: 400 });
  }
  if (gate.row.kind !== "physical") {
    return Response.json({ error: "only physical photos take a label" }, { status: 400 });
  }

  const row = await updateMediaLabel(gate.pool, sha256, gate.row.id, body.label);
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  await revalidateBuildPages(sha256, gate.target.name);
  return Response.json({ media: mediaView(row) });
}

// DELETE /api/build/<sha256>/media/<id>: remove one media entry, by its own
// author or a moderator. The blob stays in the store (content-addressed and
// possibly shared); only the record goes.
async function boundedDELETE(request: NextRequest, ctx: { params: Promise<{ sha256: string; id: string }> }) {
  const { sha256, id } = await ctx.params;
  const gate = await requireOwnMedia(request, sha256, id);
  if (!gate.ok) return gate.response;

  await deleteMedia(gate.pool, sha256, gate.row.id);
  await revalidateBuildPages(sha256, gate.target.name);
  return Response.json({ deleted: true });
}

export const PATCH = withBoundedBody(boundedPATCH);
export const DELETE = withBoundedBody(boundedDELETE);
