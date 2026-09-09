import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getContributor, contributionTarget, revalidateBuildPages, type Contributor } from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { MAX_NOTE_LEN, deleteNote, getNoteById, updateNote, type BuildNoteRow } from "@/lib/media";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Author-or-moderator gate shared by edit and delete.
async function resolveNote(
  request: NextRequest,
  ctx: { params: Promise<{ sha256: string; id: string }> }
): Promise<
  | { ok: true; sha256: string; noteId: number; note: BuildNoteRow; name: string; contributor: Contributor }
  | { ok: false; response: Response }
> {
  const { sha256, id } = await ctx.params;
  const fail = (error: string, status: number) => ({
    ok: false as const,
    response: Response.json({ error }, { status }),
  });
  if (!isSha256(sha256)) return fail("invalid sha256", 400);
  const noteId = Number(id);
  if (!Number.isInteger(noteId) || noteId <= 0) return fail("invalid id", 400);

  const contributor = await getContributor(request);
  if (!contributor) return fail("log in to the wiki first", 401);
  const pool = getPool();
  const target = await contributionTarget(pool, sha256);
  if (!target) return fail("not found", 404);
  const note = await getNoteById(pool, sha256, noteId);
  if (!note) return fail("not found", 404);
  if (note.author !== contributor.name && !contributor.moderator) {
    return fail("only the author or a moderator can change this note", 403);
  }
  return { ok: true, sha256, noteId, note, name: target.name, contributor };
}

// PATCH /api/build/<sha256>/notes/<id> { body }: edit a note (author or
// moderator), stamps edited_at.
async function boundedPATCH(request: NextRequest, ctx: { params: Promise<{ sha256: string; id: string }> }) {
  const r = await resolveNote(request, ctx);
  if (!r.ok) return r.response;

  let parsed: Record<string, unknown>;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!body) return Response.json({ error: "note body must be a non-empty string" }, { status: 400 });
  if (body.length > MAX_NOTE_LEN) {
    return Response.json({ error: `note exceeds ${MAX_NOTE_LEN} characters` }, { status: 400 });
  }

  const note = await updateNote(getPool(), r.sha256, r.noteId, body);
  if (!note) return Response.json({ error: "not found" }, { status: 404 });
  await revalidateBuildPages(r.sha256, r.name);
  return Response.json({ note });
}

// DELETE /api/build/<sha256>/notes/<id>: remove a note (author or moderator).
async function boundedDELETE(request: NextRequest, ctx: { params: Promise<{ sha256: string; id: string }> }) {
  const r = await resolveNote(request, ctx);
  if (!r.ok) return r.response;
  await deleteNote(getPool(), r.sha256, r.noteId);
  await revalidateBuildPages(r.sha256, r.name);
  return Response.json({ deleted: true });
}

export const PATCH = withBoundedBody(boundedPATCH);
export const DELETE = withBoundedBody(boundedDELETE);
