import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { listSubmissions } from "../src/lib/queries";

test("legacy malformed counts cannot break the moderation queue", { skip: !process.env.PRISM_TEST_DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.PRISM_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE submission_queue (
      sha256 text, nickname text, status text, kind text, submitted_at timestamp,
      reviewed_at timestamp, record jsonb);
      CREATE TEMP TABLE builds (sha256 text, lot text);
      CREATE TEMP TABLE build_media (id int, build_sha256 text, kind text,
        label text, sha256 text, content_type text, created_at timestamp);`);
    const counts = ["not-a-number", "9".repeat(100), {}, [], null, 0, 42];
    for (let i = 0; i < counts.length; i++) {
      await client.query("INSERT INTO submission_queue (sha256, record) VALUES ($1, $2)",
        [String(i), JSON.stringify({ structural: { file_count: counts[i] } })]);
    }
    const rows = await listSubmissions(client as unknown as pg.Pool);
    assert.equal(rows.length, counts.length);
    const byId = new Map(rows.map(row => [row.sha256, row.file_count]));
    assert.deepEqual(counts.map((_, i) => byId.get(String(i))), [null, null, null, null, null, 0, 42]);
  } finally {
    await client.end();
  }
});
