import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { requireContributor, revalidateBuildPages } from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { MAX_NOTE_LEN, insertNote } from "@/lib/media";
import { clientKey, rateLimitCheck } from "@/lib/ratelimit";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOTE_LIMIT = 30;
const NOTE_WINDOW_MS = 600_000;

// POST /api/build/<sha256>/notes { body }: add one plain-text note, for any
// logged-in wiki user who can see the build. Attributed to the wiki username.
async function boundedPOST(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const pool = getPool();
  const gate = await requireContributor(request, pool, sha256);
  if (!gate.ok) return gate.response;
  const { contributor, target } = gate;

  const rl = rateLimitCheck(`notes:${contributor.name}:${clientKey(request)}`, NOTE_LIMIT, NOTE_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "too many notes, slow down" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

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

  const note = await insertNote(pool, sha256, body, contributor.name);
  await revalidateBuildPages(sha256, target.name);
  return Response.json({ note });
}

export const POST = withBoundedBody(boundedPOST);
