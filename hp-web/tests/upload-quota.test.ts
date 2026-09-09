import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { assetBlobPath, inventoryAssetBytes, storeIdentity } from "../src/lib/blobstore";
import { initializeUploadQuota, withUploadQuota } from "../src/lib/upload-quota";

test("durable quota includes old objects and serializes reservations", { skip: !process.env.PGHOST }, async () => {
  // Explicit local-test opt-in, never inherit DATABASE_URL into a fixture.
  const database = `prism_quota_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ database: "postgres" });
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = new pg.Pool({ database });
  const oldStore = process.env.ASSET_STORE_DIR;
  process.env.ASSET_STORE_DIR = await mkdtemp(join(tmpdir(), "prism-quota-test-"));
  const a = "aa".repeat(32), b = "bb".repeat(32), approved = "cc".repeat(32), orphan = "dd".repeat(32);
  const store = async (sha: string, size: number) => {
    await mkdir(dirname(assetBlobPath(sha)), { recursive: true });
    await writeFile(assetBlobPath(sha), Buffer.alloc(size));
    return Response.json({ status: "stored" });
  };
  try {
    assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name, database);
    await pool.query("CREATE TABLE build_asset(sha256 text,size bigint)");
    await pool.query(readFileSync(new URL("../db/migrations/013-upload-quota.sql", import.meta.url), "utf8"));
    assert.equal((await withUploadQuota(pool, a, 5, () => assert.fail("not initialized"))).status, 503);
    await store(orphan, 5);
    await store(approved, 20);
    await pool.query("INSERT INTO build_asset VALUES ($1,$2)", [approved, 20]);
    await initializeUploadQuota(pool, inventoryAssetBytes());
    assert.equal((await pool.query("SELECT store_identity FROM upload_quota_config")).rows[0].store_identity, storeIdentity());
    await pool.query("UPDATE upload_quota_config SET limit_bytes=10");
    assert.equal((await withUploadQuota(pool, a, 5, () => store(a, 5))).status, 200);
    assert.equal((await withUploadQuota(pool, b, 1, () => assert.fail("quota exceeded"))).status, 507);
    assert.equal((await withUploadQuota(pool, approved, 20, () => store(approved, 20))).status, 200);
    assert.equal((await withUploadQuota(pool, a, 5, async () => Response.json({ status: "exists" }))).status, 200);
    await assert.rejects(initializeUploadQuota(pool, inventoryAssetBytes()), /already initialized/);

    // Independent digests cannot both reserve six bytes of a ten-byte budget.
    await pool.query("DELETE FROM upload_quota");
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = withUploadQuota(pool, a, 6, async () => { entered(); await waiting; return store(a, 6); });
    await started;
    assert.equal((await withUploadQuota(pool, b, 6, () => assert.fail("concurrent over-reservation"))).status, 507);
    assert.equal((await withUploadQuota(pool, a, 6, async () => Response.json({ status: "parallel" }))).status, 200);
    // Streaming work does not retain one of the shared pool's connections.
    assert.equal((await Promise.race([pool.query("SELECT 1 AS ok").then(() => "ok"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 500))])), "ok");
    release();
    await first;
    await assert.rejects(withUploadQuota(pool, b, 4, async () => { throw new Error("failed before storage"); }), /failed before storage/);
    assert.equal((await pool.query("SELECT 1 FROM upload_quota WHERE sha256=$1", [b])).rowCount, 0);
    assert.equal((await pool.query("SELECT bytes::text FROM upload_quota WHERE sha256=$1", [a])).rows[0].bytes, "6");
  } finally {
    if (oldStore === undefined) delete process.env.ASSET_STORE_DIR; else process.env.ASSET_STORE_DIR = oldStore;
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
});
