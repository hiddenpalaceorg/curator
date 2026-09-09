import { withBoundedBody } from "@/lib/request-body";
import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db";
import {
  PEER_HEADER,
  isRevalidatePath,
  isRevalidateTag,
  revalidateEverywhere,
} from "@/lib/revalidate";
import { buildHref } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";

// POST /api/refresh: bust caches. Two shapes, and one request may carry both:
//
//   { sha256s: [...] }         re-ingested builds: each one's ISR page
//                              (canonical path, bare-sha redirect, assets
//                              subpage), its tagged tree cache, and the
//                              /builds listing. For scripts/ingest.ts, whose
//                              record updates otherwise sit behind the
//                              hour-long caches; the moderation endpoints
//                              revalidate what they touch on their own.
//   { paths: [...], tags: [] } exactly these. This is how one app slot mirrors
//                              a revalidation to the other (lib/revalidate.ts),
//                              which has to name paths no build sha implies,
//                              the pre-rename slug of a renamed build, say.
//
// Gated by REFRESH_TOKEN from the environment (x-refresh-token header) and
// disabled when the variable is unset. A request that is itself a mirror
// (PEER_HEADER) is not mirrored onward, so two slots cannot ping-pong.
async function boundedPOST(request: Request) {
  const token = process.env.REFRESH_TOKEN;
  if (!token) return Response.json({ error: "not found" }, { status: 404 });
  const given = Buffer.from(request.headers.get("x-refresh-token") ?? "");
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const require = { error: "require { sha256s: [...] } or { paths: [...] }" };
  let body: { sha256s?: unknown; paths?: unknown; tags?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json(require, { status: 400 });
  }
  const shas = Array.isArray(body.sha256s)
    ? [...new Set(body.sha256s.filter((s): s is string => typeof s === "string" && isSha256(s)))]
    : [];
  const paths = new Set(Array.isArray(body.paths) ? body.paths.filter(isRevalidatePath) : []);
  const tags = new Set(Array.isArray(body.tags) ? body.tags.filter(isRevalidateTag) : []);
  if (shas.length === 0 && paths.size === 0 && tags.size === 0) {
    return Response.json(require, { status: 400 });
  }

  let refreshed = 0;
  if (shas.length > 0) {
    const named = (await getPool().query("SELECT sha256, name FROM builds WHERE sha256 = ANY($1)", [
      shas,
    ])) as { rows: { sha256: string; name: string }[] };
    refreshed = named.rows.length;
    paths.add("/builds");
    for (const { sha256, name } of named.rows) {
      const href = buildHref(sha256, name);
      paths.add(href);
      paths.add(`${href}/assets`);
      paths.add(`/builds/${sha256}`);
      tags.add(`build-tree:${sha256}`);
    }
  }

  revalidateEverywhere(paths, tags, { mirror: request.headers.get(PEER_HEADER) !== "1" });
  return Response.json({ refreshed, revalidated: paths.size });
}

export const POST = withBoundedBody(boundedPOST);
