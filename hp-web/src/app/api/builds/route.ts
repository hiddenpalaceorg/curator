import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { bulkUpdateBuilds } from "@/lib/queries";
import { requireModerator } from "@/lib/auth";
import { revalidateEverywhere } from "@/lib/revalidate";
import { buildHref } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

const MAX_BATCH = 500;
const MAX_GAME_LEN = 200;
const MAX_LOT_LEN = 200;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/builds { sha256s: [...], game?, gameSystem?, lot? } — bulk
// moderator edit: assign or clear the game and/or lot of many builds at
// once (the mass-apply bar on the build tables). Semantics per field match
// PATCH /api/build/<sha256>; unknown sha256s are skipped, the response
// carries how many rows actually changed.
async function boundedPOST(request: NextRequest) {
  const denied = await requireModerator(request);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const sha256s = body.sha256s;
  if (!Array.isArray(sha256s) || sha256s.length === 0 || !sha256s.every((s) => typeof s === "string" && isSha256(s))) {
    return Response.json({ error: "sha256s must be a non-empty array of sha256 strings" }, { status: 400 });
  }
  if (sha256s.length > MAX_BATCH) {
    return Response.json({ error: `at most ${MAX_BATCH} builds per request` }, { status: 400 });
  }

  const fields: { game?: string | null; gameSystem?: string; lot?: string | null } = {};
  if (body.game !== undefined) {
    if (body.game !== null && typeof body.game !== "string") {
      return Response.json({ error: "game must be a string or null" }, { status: 400 });
    }
    if (typeof body.game === "string" && body.game.length > MAX_GAME_LEN) {
      return Response.json({ error: `game exceeds ${MAX_GAME_LEN} characters` }, { status: 400 });
    }
    fields.game = ((body.game as string | null) ?? "").trim() || null;
  }
  if (body.gameSystem !== undefined && typeof body.gameSystem !== "string") {
    return Response.json({ error: "gameSystem must be a string" }, { status: 400 });
  }
  fields.gameSystem = ((body.gameSystem as string | undefined) ?? "").trim();
  if (fields.gameSystem.length > MAX_GAME_LEN) {
    return Response.json({ error: `gameSystem exceeds ${MAX_GAME_LEN} characters` }, { status: 400 });
  }
  if (body.lot !== undefined) {
    if (body.lot !== null && typeof body.lot !== "string") {
      return Response.json({ error: "lot must be a string or null" }, { status: 400 });
    }
    if (typeof body.lot === "string" && body.lot.length > MAX_LOT_LEN) {
      return Response.json({ error: `lot exceeds ${MAX_LOT_LEN} characters` }, { status: 400 });
    }
    fields.lot = (body.lot ?? "").trim() || null;
  }
  if (fields.game === undefined && fields.lot === undefined) {
    return Response.json({ error: "nothing to update (game and/or lot required)" }, { status: 400 });
  }

  const pool = getPool();
  const { updated, game } = await bulkUpdateBuilds(pool, sha256s as string[], fields);

  // Build pages are ISR-cached; surface the new chips now. The game pages
  // themselves are dynamic and need no revalidation.
  const touched = new Set(["/builds"]);
  for (const b of updated) {
    for (const path of [buildHref(b.sha256, b.name), `/builds/${b.sha256}`]) {
      touched.add(path);
      touched.add(`${path}/assets`);
    }
  }
  revalidateEverywhere(touched);

  return Response.json({
    updated: updated.length,
    ...(fields.game !== undefined ? { game: game?.name ?? null, gameSlug: game?.slug ?? null } : {}),
    ...(fields.lot !== undefined ? { lot: fields.lot } : {}),
  });
}

export const POST = withBoundedBody(boundedPOST);
