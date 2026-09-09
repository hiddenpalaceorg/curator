import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { requireContributor } from "@/lib/contrib";
import {
  createMediaSession,
  isMediaKind,
  isMediaLabel,
  kindMaxBytes,
  MAX_FILENAME_LEN,
  newMediaToken,
} from "@/lib/media";
import { clientKey, rateLimitCheck } from "@/lib/ratelimit";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Uploads per contributor per hour. Generous for a photo session of one
// build, tight enough to stop a script hosing the bucket. A real session is a
// disc's worth of screenshots plus front/back/media scans, and a retried file
// spends another slot, so this sits well above what one sitting needs: the
// client cannot recover from a 429 the way it recovers from a dropped chunk.
const CREATE_LIMIT = 240;
const CREATE_WINDOW_MS = 3600_000;

// POST /api/build/<sha256>/media/upload { kind, filename, size, label? }:
// open a chunked upload session for one media file, for any logged-in wiki
// user who can see the build. label (front/back/other) applies to physical
// photos only and defaults to other. Returns { token }; the client PUTs chunks to
// ./upload/<token>?offset=N until the claimed size is reached, at which point
// the server sniffs, stores, and records the file (see the token route).
async function boundedPOST(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const pool = getPool();
  const gate = await requireContributor(request, pool, sha256);
  if (!gate.ok) return gate.response;
  const { contributor } = gate;

  const rl = rateLimitCheck(`media:${contributor.name}:${clientKey(request)}`, CREATE_LIMIT, CREATE_WINDOW_MS);
  if (!rl.ok) {
    return Response.json(
      { error: "too many uploads, slow down" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const kind = body.kind;
  if (!isMediaKind(kind)) {
    return Response.json({ error: "kind must be screenshot, video, or physical" }, { status: 400 });
  }
  let label;
  if (body.label !== undefined) {
    if (kind !== "physical") {
      return Response.json({ error: "only physical photos take a label" }, { status: 400 });
    }
    if (!isMediaLabel(body.label)) {
      return Response.json({ error: "label must be front, back, or other" }, { status: 400 });
    }
    label = body.label;
  }
  const size = body.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) {
    return Response.json({ error: "size must be a positive integer" }, { status: 400 });
  }
  if (size > kindMaxBytes(kind)) {
    return Response.json(
      { error: `${kind} uploads are capped at ${Math.round(kindMaxBytes(kind) / 1024 / 1024)} MB` },
      { status: 413 }
    );
  }
  const rawName = typeof body.filename === "string" ? body.filename : "";
  const filename =
    rawName
      .split(/[/\\]/)
      .pop()!
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, MAX_FILENAME_LEN) || "upload";

  const token = newMediaToken();
  await createMediaSession(token, { build: sha256, kind, filename, size, author: contributor.name, label });
  return Response.json({ token });
}

export const POST = withBoundedBody(boundedPOST);
