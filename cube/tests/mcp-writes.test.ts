import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { createCube } from "../src/index";
import { defaultCan } from "../src/auth/native";
import { CubeAuthorizationError } from "../src/issues";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCubeMcpServer } from "../src/mcp/index";

test("write tools require an acting identity even when explicitly enabled", async () => {
  const server = createCubeMcpServer(createCube({ db: { pool: {} as pg.Pool } }), { allowWrites: true, user: null });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(ct);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(!names.includes("create_page"));
    assert.ok(!names.includes("update_page"));
    assert.ok(names.includes("get_page"));
  } finally {
    await client.close();
    await server.close();
  }
});

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

    const server = createCubeMcpServer(cube, { user });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    cleanup = async () => { await client.close(); await server.close(); };
    const write = async (title: string, markdown: string, baseRevision?: number) => {
      const result = await client.callTool({ name: baseRevision === undefined ? "create_page" : "update_page",
        arguments: { title, markdown, ...(baseRevision === undefined ? {} : { baseRevision }) } });
      return JSON.parse((result.content as { text: string }[])[0]!.text);
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
