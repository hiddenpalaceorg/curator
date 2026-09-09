import type { Pool } from "pg";
import fsp from "node:fs/promises";
import { assetBlobPath, assetStagingPath, assetStagingStats, blobSize, reapStaleAssetStaging, s3Enabled, storeIdentity } from "./blobstore";

const totalSql = `SELECT COALESCE(sum(q.bytes - CASE WHEN EXISTS
  (SELECT 1 FROM build_asset a WHERE a.sha256=q.sha256 AND a.size=q.stored_bytes)
  THEN q.stored_bytes ELSE 0 END),0)::text AS bytes FROM upload_quota q`;

async function sizeOnDisk(file: string): Promise<number> {
  try { return (await fsp.stat(file)).size; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0; throw e; }
}

/** Reserve the full possible object before bytes arrive. Approved library
 * assets with the same digest and size do not consume the pending quota. */
export async function withUploadQuota(pool: Pool, sha: string, claimed: number, work: () => Promise<Response>, token?: string): Promise<Response> {
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
      const existing = await c.query("SELECT bytes::text,stored_bytes::text,active FROM upload_quota WHERE sha256=$1", [sha]);
      if (existing.rows[0]?.active) {
        await c.query("ROLLBACK");
        return Response.json({ error: "asset upload busy", retryAfter: 1 }, { status: 429, headers: { "Retry-After": "1" } });
      }
      const total = BigInt((await c.query(totalSql)).rows[0].bytes);
      const old = BigInt(existing.rows[0]?.bytes ?? "0");
      // S3 upload briefly holds both a staged and a final copy. Local storage
      // uses a same-filesystem rename. Reserve the peak before reading input.
      const peak = BigInt(claimed) * (s3Enabled() ? 2n : 1n);
      let wanted = peak > old ? peak : old;
      if (token !== undefined) {
        const ownPart = await sizeOnDisk(assetStagingPath(sha,token));
        if (ownPart === 0 && (await assetStagingStats(sha)).count >= 32) {
          await c.query("ROLLBACK");
          return Response.json({error:"too many pending uploads for this asset",retryAfter:60}, {status:429,headers:{"Retry-After":"60"}});
        }
        const growth = BigInt(Math.max(0, claimed-ownPart)) + (s3Enabled() ? BigInt(claimed) : 0n);
        wanted = old + growth;
      }
      const nextTotal = total + wanted - old;
      if (nextTotal > BigInt(config.rows[0].limit_bytes)) {
        await c.query("ROLLBACK");
        return Response.json({ error: "pending upload quota exceeded" }, { status: 507 });
      }
      await c.query(`INSERT INTO upload_quota(sha256,bytes,active,stored_bytes) VALUES ($1,$2,1,0)
        ON CONFLICT (sha256) DO UPDATE SET bytes=GREATEST(upload_quota.bytes,excluded.bytes),active=1,updated_at=now()`, [sha, wanted.toString()]);
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
    await reconcileLease(pool, sha);
  }
}

/** The durable active lease excludes both writers and reapers until the
 * storage probes AND reconciliation finish. No connection is held while
 * bytes stream. A crash retains the lease and charge for operator recovery. */
async function reconcileLease(pool: Pool, sha: string): Promise<void> {
  const stored = s3Enabled() ? (await blobSize(sha) ?? 0) : await sizeOnDisk(assetBlobPath(sha));
  const staged = (await assetStagingStats(sha)).bytes;
  const actual = stored + staged;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const row = await c.query("SELECT active FROM upload_quota WHERE sha256=$1 FOR UPDATE", [sha]);
    if (row.rows[0]?.active !== 1) throw new Error("upload lease lost");
    if (actual === 0) await c.query("DELETE FROM upload_quota WHERE sha256=$1", [sha]);
    else await c.query("UPDATE upload_quota SET bytes=$2,stored_bytes=$3,active=0,updated_at=now() WHERE sha256=$1", [sha, actual, stored]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); }
}

/** Reap before reserving new quota, so a full budget can still recover stale
 * staging. Never remove a file while an upload or reconciliation owns it. */
export async function reapUploadQuotaStaging(pool: Pool): Promise<void> {
  await reapStaleAssetStaging(async (sha, reap) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const config = await c.query("SELECT initialized,store_identity FROM upload_quota_config WHERE id=true FOR UPDATE");
      const row = await c.query("SELECT active FROM upload_quota WHERE sha256=$1", [sha]);
      if (!config.rows[0]?.initialized || config.rows[0].store_identity !== storeIdentity() || row.rows[0]?.active) {
        await c.query("ROLLBACK");
        return;
      }
      await c.query(`INSERT INTO upload_quota(sha256,bytes,active,stored_bytes) VALUES($1,0,1,0)
        ON CONFLICT(sha256) DO UPDATE SET active=1`, [sha]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; }
    finally { c.release(); }
    try { await reap(); }
    finally { await reconcileLease(pool, sha); }
  });
}

/** One-time inventory, while all old upload workers/import jobs are stopped.
 * Rollback leaves uploads disabled; no blob or staging file is ever deleted. */
export async function initializeUploadQuota(pool: Pool, inventory: AsyncIterable<{ sha256: string; size: number; staged?: boolean }>): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const config = await c.query("SELECT initialized FROM upload_quota_config WHERE id=true FOR UPDATE");
    if (config.rows[0]?.initialized) throw new Error("quota already initialized");
    for await (const item of inventory) {
      if (!/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error("invalid inventory entry");
      await c.query(`INSERT INTO upload_quota(sha256,bytes,stored_bytes) VALUES ($1,$2,$3)
        ON CONFLICT (sha256) DO UPDATE SET bytes=upload_quota.bytes+excluded.bytes,
          stored_bytes=upload_quota.stored_bytes+excluded.stored_bytes`, [item.sha256, item.size, item.staged ? 0 : item.size]);
    }
    await c.query("UPDATE upload_quota_config SET initialized=true,store_identity=$1 WHERE id=true", [storeIdentity()]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); }
}
