import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createCube } from "../src/index";
import { defaultCan } from "../src/auth/native";
import { CubeAuthorizationError } from "../src/issues";

test("locked page policy protects restores, no-ops and conflicts", { skip: !process.env.PGHOST }, async () => {
  const admin = new pg.Pool({ database: "postgres" });
  const db = "cube_policy_" + randomUUID().replaceAll("-", "");
  await admin.query('CREATE DATABASE "' + db + '"');
  const pool = new pg.Pool({ database: db });
  let cleanup = async () => {};
  try {
    await pool.query(readFileSync(new URL("../db/migrations/001-init.sql", import.meta.url), "utf8"));
    const user = { id: 1, name: "user", roles: [] as string[] };
    const cube = createCube({ db: { pool }, auth: { getUser: async () => user, can: defaultCan } });
    const ref = { ns: "main", slug: "Protected_page" };
    const author = { name: "local" };
    const original = await cube.api.savePage({ ...ref, markdown: "secret\n", author });
    await pool.query("UPDATE cube_page SET protection = $1, visibility = 'moderator' WHERE id = $2",
      [JSON.stringify({ edit: "moderator" }), original.pageId]);
    await assert.rejects(cube.api.savePage({ ...ref, markdown: "secret\n", author, authorize: () => false }), CubeAuthorizationError);
    await assert.rejects(cube.api.savePage({ ...ref, markdown: "different\n", author, baseRevId: -1, authorize: () => false }), CubeAuthorizationError);

    const write = async (title: string, markdown: string, baseRevision?: number) => {
      const result = await cube.handlers.PUT(new Request("http://test/api/cube/page?title=" + encodeURIComponent(title), {
        method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ markdown, baseRevision }),
      }));
      return result.json() as Promise<{ error?: unknown; revision?: number }>;
    };

    const deniedLive = await write("protected page", "different\n", original.revId);
    assert.ok(deniedLive.error);
    assert.doesNotMatch(JSON.stringify(deniedLive), /secret/);
    await cube.api.deletePage({ ...ref, actor: author });
    for (const markdown of ["secret\n", "replacement\n"]) {
      const denied = await write("protected page", markdown);
      assert.ok(denied.error);
      assert.equal(await cube.api.getPage(ref), null);
    }
    const state = await pool.query("SELECT protection, visibility, deleted_at FROM cube_page WHERE id = $1", [original.pageId]);
    assert.ok(state.rows[0].deleted_at);
    assert.deepEqual(state.rows[0].protection, { edit: "moderator" });
    assert.equal(state.rows[0].visibility, "moderator");
    user.roles = ["moderator"];
    const restored = await write("protected page", "replacement\n");
    assert.ok(restored.revision);
    assert.equal((await cube.api.listRevisions(ref)).length, 2);
    assert.equal((await cube.api.getPage(ref))?.visibility, "moderator");
    user.roles = [];
    const ordinary = await write("Ordinary", "hello\n");
    assert.ok(ordinary.revision);
    assert.ok((await write("Ordinary", "hello again\n", ordinary.revision)).revision);
    // Trusted local callers retain the pre-existing import/restore contract.
    await cube.api.deletePage({ ...ref, actor: author });
    await cube.api.savePage({ ...ref, markdown: "local restore\n", author });
    assert.equal((await cube.api.getPage(ref))?.markdown, "local restore\n");
  } finally {
    await cleanup();
    await pool.end();
    await admin.query('DROP DATABASE "' + db + '" WITH (FORCE)');
    await admin.end();
  }
});
