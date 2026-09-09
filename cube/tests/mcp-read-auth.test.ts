import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Cube } from "../src/index";
import { createCubeMcpServer } from "../src/mcp/index";

test("read tools enforce source, target, deleted-owner and custom policies", async () => {
  for (const moderator of [false, true]) {
    let hidden = true;
    let deleted = false;
    let sourceHidden = false;
    let customDenied = false;
    const page = (source = false) => ({ ns: "main", slug: source ? "Source" : "Target", title: "Title",
      visibility: (source ? sourceHidden : hidden) ? "moderator" : "public", protection: {},
      markdown: "secret content", revId: 2 });
    const cube = {
      config: {},
      api: {
        resolve: async () => ({ ns: "main", slug: "Target", redirectedFrom: { ns: "main", slug: "Source" } }),
        getPage: async (ref: { slug: string }) => deleted ? null : page(ref.slug === "Source"),
        listRevisions: async () => [{ id: 2, comment: "secret history" }],
        getRevision: async () => ({ ...page(), id: 2, deletedAt: deleted ? new Date() : null, content: "secret content" }),
      },
      pool: () => ({ query: async () => ({ rows: [1, 2].map(id => ({
        id, page_id: id, ns: "main", slug: id === 1 ? "Public" : "Target",
        visibility: id === 2 && hidden ? "moderator" : "public", protection: {},
        deleted_at: id === 2 && deleted ? new Date() : null, content: "secret content", created_at: new Date(),
      })) }) }),
    } as unknown as Cube;
    const server = createCubeMcpServer(cube, moderator ? { user: { id: 0, name: "moderator", roles: ["moderator"] } } : {});
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    try {
      for (const [name, args] of [["get_page", { title: "Source" }], ["get_revision", { id: 2 }], ["diff_revisions", { from: 1, to: 2 }]] as const) {
        assert.equal(!!(await call(name, args)).error, !moderator);
      }
      hidden = false; sourceHidden = true;
      assert.equal(!!(await call("get_page", { title: "Source" })).error, !moderator);
      assert.equal(!!(await call("list_revisions", { title: "Source" })).error, !moderator);
      sourceHidden = false; deleted = true;
      for (const [name, args] of [["get_revision", { id: 2 }], ["diff_revisions", { from: 1, to: 2 }]] as const) {
        assert.equal(!!(await call(name, args)).error, !moderator);
      }
      deleted = false;
      assert.equal((await call("get_page", { title: "Source" })).markdown, "secret content");
      cube.config.auth = { getUser: async () => null, can() { customDenied = true; return false; } };
      assert.ok((await call("get_revision", { id: 2 })).error);
      assert.ok(customDenied);
    } finally {
      await client.close();
      await server.close();
    }
  }
});
