import assert from "node:assert/strict";
import { test } from "node:test";
import type { Cube, Page } from "../src/index";
import { createHandlers } from "../src/http/index";

test("resolution and page responses authorize both redirect endpoints", async () => {
  const source = { ns: "main", slug: "Source", visibility: "public", protection: {} } as Page;
  const target = { ns: "main", slug: "Target", visibility: "public", protection: {} } as Page;
  let denied: string | null = null;
  const cube = {
    slug: { namespacePrefixes: {}, capitalLinks: true },
    config: { auth: { getUser: async () => null, can: (_user: unknown, _action: unknown, page: Page) => page.slug !== denied } },
    api: {
      resolve: async () => ({ ...target, redirectedFrom: { ns: source.ns, slug: source.slug } }),
      getPage: async (ref: { slug: string }) => ref.slug === source.slug ? source : target,
    },
  } as unknown as Cube;
  const handlers = createHandlers(cube);
  for (denied of ["Source", "Target", null]) {
    for (const path of ["/resolve?title=Source", "/page?title=Source"]) {
      const res = await handlers.GET(new Request(`http://test/api/cube${path}`));
      assert.equal(res.status, denied ? 404 : 200);
      if (denied) assert.doesNotMatch(await res.text(), /Target|Source/);
    }
  }
  denied = "Target";
  assert.equal((await handlers.GET(new Request("http://test/api/cube/page?title=Source&redirect=no"))).status, 200);
});
