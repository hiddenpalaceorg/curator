import type { Pool } from "pg";
import fsp from "node:fs/promises";
import { assetBlobPath, assetStagingPath, blobSize, s3Enabled, storeIdentity } from "./blobstore";

const totalSql = `SELECT COALESCE(sum(q.bytes), 0)::text AS bytes FROM upload_quota q
  WHERE NOT EXISTS (SELECT 1 FROM build_asset a WHERE a.sha256=q.sha256 AND a.size=q.bytes)`;

async function sizeOnDisk(file: string): Promise<number> {
  try { return (await fsp.stat(file)).size; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0; throw e; }
}

/** Reserve the full possible object before bytes arrive. Approved library
 * assets with the same digest and size do not consume the pending quota. */
export async function withUploadQuota(pool: Pool, sha: string, claimed: number, work: () => Promise<Response>): Promise<Response> {
  const c = await pool.connect();
  let reserved = false;
  try {
    await c.query("BEGIN");
    try {
      const config = await c.query("SELECT initialized,store_identity,limit_bytes::text FROM upload_quota_config WHERE id=true FOR UPDATE");
      if (!config.rows[0]?.initialized || config.rows[0].store_identity !== storeIdentity()) {
        await c.query("ROLLBACK");
        return Response.json({ error: "upload quota inventory required" }, { status: 503 });
      }
      const existing = await c.query("SELECT bytes::text FROM upload_quota WHERE sha256=$1", [sha]);
      const total = BigInt((await c.query(totalSql)).rows[0].bytes);
      const old = BigInt(existing.rows[0]?.bytes ?? "0");
      const wanted = BigInt(claimed) > old ? BigInt(claimed) : old;
      const oldApproved = old > 0n && (await c.query("SELECT 1 FROM build_asset WHERE sha256=$1 AND size=$2 LIMIT 1", [sha, old.toString()])).rowCount;
      const wantedApproved = (await c.query("SELECT 1 FROM build_asset WHERE sha256=$1 AND size=$2 LIMIT 1", [sha, wanted.toString()])).rowCount;
      const nextTotal = total - (oldApproved ? 0n : old) + (wantedApproved ? 0n : wanted);
      if (nextTotal > BigInt(config.rows[0].limit_bytes)) {
        await c.query("ROLLBACK");
        return Response.json({ error: "pending upload quota exceeded" }, { status: 507 });
      }
      await c.query(`INSERT INTO upload_quota(sha256,bytes,active) VALUES ($1,$2,1)
        ON CONFLICT (sha256) DO UPDATE SET bytes=GREATEST(upload_quota.bytes,excluded.bytes),active=upload_quota.active+1,updated_at=now()`, [sha, wanted.toString()]);
      await c.query("COMMIT");
      reserved = true;
    } catch (e) { await c.query("ROLLBACK"); throw e; }
  } finally {
    c.release();
  }
  if (!reserved) throw new Error("upload reservation failed");
  try {
    return await work();
  } finally {
    // Do not occupy the shared DB pool while a client streams its body. The
    // active count preserves the reservation through overlapping requests;
    // a process crash conservatively leaves it charged.
    const stored = s3Enabled() ? (await blobSize(sha) ?? 0) : await sizeOnDisk(assetBlobPath(sha));
    const staged = await sizeOnDisk(assetStagingPath(sha));
    const actual = stored + staged;
    const cleanup = await pool.connect();
    try {
      await cleanup.query("BEGIN");
      const row = await cleanup.query("SELECT bytes::text,active FROM upload_quota WHERE sha256=$1 FOR UPDATE", [sha]);
      if (row.rowCount) {
        const active = Math.max(0, row.rows[0].active - 1);
        if (active === 0 && actual === 0) await cleanup.query("DELETE FROM upload_quota WHERE sha256=$1", [sha]);
        else await cleanup.query("UPDATE upload_quota SET bytes=$2,active=$3,updated_at=now() WHERE sha256=$1", [sha, active ? (BigInt(row.rows[0].bytes) > BigInt(actual) ? row.rows[0].bytes : String(actual)) : String(actual), active]);
      }
      await cleanup.query("COMMIT");
    } catch (e) { await cleanup.query("ROLLBACK"); throw e; }
    finally { cleanup.release(); }
  }
}

/** Reconcile staging files removed by the stale-file reaper. Conservative
 * crash reservations with active>0 remain charged for operator review. */
export async function releaseReapedUploadQuota(pool: Pool, shas: string[]): Promise<void> {
  for (const sha of shas) {
    const stored = s3Enabled() ? (await blobSize(sha) ?? 0) : await sizeOnDisk(assetBlobPath(sha));
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = await c.query("SELECT active FROM upload_quota WHERE sha256=$1 FOR UPDATE", [sha]);
      if (row.rows[0]?.active === 0) {
        if (stored) await c.query("UPDATE upload_quota SET bytes=$2,updated_at=now() WHERE sha256=$1", [sha, stored]);
        else await c.query("DELETE FROM upload_quota WHERE sha256=$1", [sha]);
      }
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; }
    finally { c.release(); }
  }
}

/** One-time inventory, while all old upload workers/import jobs are stopped.
 * Rollback leaves uploads disabled; no blob or staging file is ever deleted. */
export async function initializeUploadQuota(pool: Pool, inventory: AsyncIterable<{ sha256: string; size: number }>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const config = await c.query("SELECT initialized FROM upload_quota_config WHERE id=true FOR UPDATE");
    if (config.rows[0]?.initialized) throw new Error("quota already initialized");
    for await (const item of inventory) {
      if (!/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error("invalid inventory entry");
      await c.query(`INSERT INTO upload_quota(sha256,bytes) VALUES ($1,$2)
        ON CONFLICT (sha256) DO UPDATE SET bytes=upload_quota.bytes+excluded.bytes`, [item.sha256, item.size]);
    }
    await c.query("UPDATE upload_quota_config SET initialized=true,store_identity=$1 WHERE id=true", [storeIdentity()]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); }
}
