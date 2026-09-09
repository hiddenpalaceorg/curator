import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db";
import { submissionStatus, setSubmissionStatus } from "@/lib/queries";
import { ingestRecord, refreshAudioIdf } from "@/lib/ingest";
import { requireModerator } from "@/lib/auth";
import { revalidateEverywhere } from "@/lib/revalidate";
import { buildHref } from "@/lib/slug";
import { isSha256 } from "@/lib/validate";
import type { BuildRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/submissions/<sha256> — submission status (params is a Promise in Next 16).
export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  const status = await submissionStatus(getPool(), sha256);
  if (!status) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(status);
}

// POST /api/submissions/<sha256> { action: "accept" | "reject" } — moderate.
// Accept ingests the stored record into the library, then marks it accepted.
async function boundedPOST(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  let action: string | undefined;
  try {
    ({ action } = await request.json());
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (action !== "accept" && action !== "reject") {
    return Response.json({ error: 'action must be "accept" or "reject"' }, { status: 400 });
  }

  const pool = getPool();

  if (action === "reject") {
    const record = await setSubmissionStatus(pool, sha256, "rejected");
    if (!record) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ sha256, status: "rejected" });
  }

  // Accept: ingest and flip status to accepted in ONE transaction so a failed
  // ingest never leaves the submission marked accepted.
  let name = "";
  let kind = "build";
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Transaction-scoped: moderation is token-gated and rare, and the corpus-wide
    // audio-IDF refresh below outlives the pool's page-query statement_timeout on
    // slower hosts. Page queries keep their cap.
    await c.query("SET LOCAL statement_timeout = 0");
    const r = await c.query<{ record: BuildRecord; kind: string; nickname: string }>(
      "SELECT record, kind, nickname FROM submission_queue WHERE sha256=$1 FOR UPDATE",
      [sha256]
    );
    if (!r.rowCount) {
      await c.query("ROLLBACK");
      return Response.json({ error: "not found" }, { status: 404 });
    }
    kind = r.rows[0].kind;
    if (kind === "duplicate") {
      // Duplicate-name submission: the image is already a live build. Accepting
      // records the submitted name as a known duplicate — the build itself
      // (record, derived tables, any moderator rename) stays untouched.
      const b = await c.query<{ name: string }>("SELECT name FROM builds WHERE sha256=$1", [sha256]);
      if (!b.rowCount) {
        await c.query("ROLLBACK");
        return Response.json(
          { error: "original build no longer exists; reject and have it resubmitted" },
          { status: 409 }
        );
      }
      name = b.rows[0].name;
      const dupName = r.rows[0].record.image?.name ?? "";
      if (dupName && dupName !== name) {
        await c.query(
          `INSERT INTO build_duplicate (build_sha256, name, nickname) VALUES ($1,$2,$3)
           ON CONFLICT (build_sha256, name) DO NOTHING`,
          [sha256, dupName, r.rows[0].nickname]
        );
      }
    } else {
      name = r.rows[0].record.image?.name ?? "";
      // Force: an accept must replace the live build wholesale — record, row
      // columns, and derived tables — even when the record looks unchanged.
      // New submissions start private (unlisted) until a moderator publishes
      // them; re-accepting an existing build keeps its current visibility.
      await ingestRecord(c, r.rows[0].record, { force: true, asPrivate: true });
    }
    await c.query(
      "UPDATE submission_queue SET status='accepted', reviewed_at=now() WHERE sha256=$1",
      [sha256]
    );
    // Keep the audio-hash corpus frequencies in step with the new build so the
    // similarity tier's IDF weighting stays accurate; atomic with the accept.
    // A duplicate accept changes no corpus rows, so it skips the refresh.
    if (kind !== "duplicate") await refreshAudioIdf(c);
    await c.query("COMMIT");
  } catch (e) {
    console.error(`accept ${sha256}: ingest failed:`, e);
    await c.query("ROLLBACK");
    return Response.json({ error: "ingest failed" }, { status: 500 });
  } finally {
    c.release();
  }
  // Build pages are cached (revalidate = 3600); make the new build visible now.
  // The canonical slug path is what everything links to; the bare-sha path
  // serves a cached redirect, so refresh both (plus the assets subpage).
  const canonical = buildHref(sha256, name);
  revalidateEverywhere([canonical, `${canonical}/assets`, `/builds/${sha256}`]);
  return Response.json({ sha256, status: "accepted", kind });
}

export const POST = withBoundedBody(boundedPOST);
