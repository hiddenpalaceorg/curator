import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { deriveQueryFeatures } from "@/lib/fingerprint";
import { getBuild, findSimilar, findByEmbeddingOf, getLotBuilds, updateBuildMeta, setLotPrivate, setBuildGame } from "@/lib/queries";
import { getModerator, requireModerator } from "@/lib/auth";
import { revalidateEverywhere } from "@/lib/revalidate";
import { buildHref } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

const MAX_NAME_LEN = 300;
const MAX_LOT_LEN = 200;
const MAX_GAME_LEN = 200;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/build/<sha256> — the stored build plus its similar neighbors
// (same fusion as /api/similarity, computed from the stored record). The
// build itself resolves for anyone holding its sha (private = unlisted, not
// blocked); the neighbor lists hide private builds from non-moderators.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const pool = getPool();

  const build = await getBuild(pool, sha256);
  if (!build) return Response.json({ error: "not found" }, { status: 404 });

  const includePrivate = !!(await getModerator(request));
  const q = deriveQueryFeatures(build.record);
  const similar = await findSimilar(pool, q, 20, includePrivate);

  // Use the build's STORED embedding (pgvector) rather than re-running the
  // transformers model on its text_doc at request time — same neighbors, no
  // model load/inference on the hot path (the GUIs hit this endpoint).
  const text_neighbors = await findByEmbeddingOf(pool, sha256, 20, includePrivate);

  return Response.json({ build, similar: { ...similar, text_neighbors } });
}

// PATCH /api/build/<sha256> { name?, lot?, private?, lotPrivate?, game?, gameSystem? }
// — moderator metadata edit. `name` renames the build; `lot` assigns it to a
// display group ("" or null clears); `private` hides the build from public
// list/search/similar; `lotPrivate` hides/unhides the build's whole lot
// (current and future members); `game` (+ optional `gameSystem`) names the
// game the build belongs to (created if new; "" or null clears).
async function boundedPATCH(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const fields: { name?: string; lot?: string | null; private?: boolean } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return Response.json({ error: "name must be a non-empty string" }, { status: 400 });
    }
    if (body.name.length > MAX_NAME_LEN) {
      return Response.json({ error: `name exceeds ${MAX_NAME_LEN} characters` }, { status: 400 });
    }
    fields.name = body.name.trim();
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
  if (body.private !== undefined) {
    if (typeof body.private !== "boolean") {
      return Response.json({ error: "private must be a boolean" }, { status: 400 });
    }
    fields.private = body.private;
  }
  const lotPrivate = body.lotPrivate;
  if (lotPrivate !== undefined && typeof lotPrivate !== "boolean") {
    return Response.json({ error: "lotPrivate must be a boolean" }, { status: 400 });
  }
  let game: string | null | undefined;
  if (body.game !== undefined) {
    if (body.game !== null && typeof body.game !== "string") {
      return Response.json({ error: "game must be a string or null" }, { status: 400 });
    }
    if (typeof body.game === "string" && body.game.length > MAX_GAME_LEN) {
      return Response.json({ error: `game exceeds ${MAX_GAME_LEN} characters` }, { status: 400 });
    }
    game = ((body.game as string | null) ?? "").trim() || null;
  }
  if (body.gameSystem !== undefined && typeof body.gameSystem !== "string") {
    return Response.json({ error: "gameSystem must be a string" }, { status: 400 });
  }
  const gameSystem = ((body.gameSystem as string | undefined) ?? "").trim();
  if (gameSystem.length > MAX_GAME_LEN) {
    return Response.json({ error: `gameSystem exceeds ${MAX_GAME_LEN} characters` }, { status: 400 });
  }
  const hasFields = fields.name !== undefined || fields.lot !== undefined || fields.private !== undefined;
  if (!hasFields && lotPrivate === undefined && game === undefined) {
    return Response.json({ error: "nothing to update (name, lot, private, lotPrivate and/or game required)" }, { status: 400 });
  }

  const pool = getPool();
  // Validate lotPrivate against the lot the build will be in BEFORE writing
  // anything, so a rejected request never leaves a partial update behind.
  const r = await pool.query("SELECT name, lot FROM builds WHERE sha256=$1", [sha256]);
  const prev = (r.rows[0] as { name: string; lot: string | null }) ?? null;
  if (!prev) return Response.json({ error: "not found" }, { status: 404 });
  const effectiveLot = fields.lot !== undefined ? fields.lot : prev.lot;
  if (lotPrivate !== undefined && !effectiveLot) {
    return Response.json({ error: "lotPrivate requires the build to have a lot" }, { status: 400 });
  }

  if (hasFields) {
    const updated = await updateBuildMeta(pool, sha256, fields);
    if (!updated) return Response.json({ error: "not found" }, { status: 404 });
  }
  if (lotPrivate !== undefined && effectiveLot) {
    await setLotPrivate(pool, effectiveLot, lotPrivate);
  }
  let gameRow: { id: number; name: string; system: string; slug: string | null } | null | undefined;
  if (game !== undefined) {
    gameRow = await setBuildGame(pool, sha256, game, gameSystem);
    if (gameRow === undefined) return Response.json({ error: "not found" }, { status: 404 });
  }

  // Build pages are ISR-cached (revalidate = 3600); surface the edit now. A
  // rename changes the canonical slug path, so refresh the old one (it now
  // serves a redirect) and the new one, plus their assets subpages and the
  // bare-sha redirect. Lot moves and privacy toggles also alter the lot
  // section on every sibling page (in the lot joined and the one left), so
  // refresh those too — including private siblings, whose pages stay
  // reachable by direct URL.
  const touched = new Set([
    buildHref(sha256, prev.name),
    buildHref(sha256, fields.name ?? prev.name),
    `/builds/${sha256}`,
  ]);
  const lotsTouched = new Set<string>();
  if (fields.lot !== undefined && fields.lot !== prev.lot) {
    for (const lot of [fields.lot, prev.lot]) if (lot != null) lotsTouched.add(lot);
  }
  if ((lotPrivate !== undefined || fields.private !== undefined) && effectiveLot) {
    lotsTouched.add(effectiveLot);
  }
  for (const lot of lotsTouched) {
    for (const b of await getLotBuilds(pool, lot, true)) touched.add(buildHref(b.sha256, b.name));
  }
  const paths = new Set(["/builds"]);
  for (const path of touched) {
    paths.add(path);
    paths.add(`${path}/assets`);
  }
  revalidateEverywhere(paths);
  return Response.json({
    sha256,
    name: fields.name ?? prev.name,
    lot: effectiveLot,
    ...(fields.private !== undefined ? { private: fields.private } : {}),
    ...(lotPrivate !== undefined ? { lotPrivate } : {}),
    ...(game !== undefined
      ? { game: gameRow?.name ?? null, gameSystem: gameRow?.system ?? null, gameSlug: gameRow?.slug ?? null }
      : {}),
  });
}

export const PATCH = withBoundedBody(boundedPATCH);
