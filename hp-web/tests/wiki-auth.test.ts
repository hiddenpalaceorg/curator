import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { wikiUserFromCookies } from "../src/lib/wiki-auth";

test("wiki lookups coalesce canonical cookies and bound upstream work", async () => {
  let requests = 0, active = 0, peak = 0;
  const received: string[] = [];
  const server = createServer((req, res) => {
    requests++;
    active++;
    peak = Math.max(peak, active);
    res.on("close", () => active--);
    received.push(req.headers.cookie ?? "");
    if (req.headers.cookie?.includes("oversize")) { res.end("x".repeat(65_537)); return; }
    if (req.headers.cookie?.includes("drip")) {
      const timer = setInterval(() => res.write(" "), 20);
      res.on("close", () => clearInterval(timer));
      return;
    }
    setTimeout(() => res.end(JSON.stringify({ query: { userinfo: { id: 1, name: "User", groups: ["sysop"] } } })), 50);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const old = { url: process.env.WIKI_API_URL, prefix: process.env.WIKI_COOKIE_PREFIX };
  process.env.WIKI_API_URL = `http://127.0.0.1:${(server.address() as any).port}/api.php`;
  process.env.WIKI_COOKIE_PREFIX = "test";
  try {
    const normalApi = process.env.WIKI_API_URL;
    process.env.WIKI_API_URL = "ftp://127.0.0.1/api.php";
    assert.equal(await wikiUserFromCookies("test_session=bad-config"), null);
    process.env.WIKI_API_URL = normalApi;
    const users = await Promise.all(Array.from({ length: 30 }, (_, i) => wikiUserFromCookies(`other=${i}; test_session=one; testUserName=User%20Name`)));
    assert.ok(users.every((u) => u?.id === 1));
    assert.equal(requests, 1);
    assert.equal(received[0], "test_session=one; testUserName=User%20Name");
    assert.equal(await wikiUserFromCookies("prefix_test_session=one"), null);
    assert.equal(await wikiUserFromCookies("test_session=one; test_session=two"), null);
    assert.equal((await wikiUserFromCookies("testToken=remember; testUserID=1"))?.id, 1);
    const random = await Promise.all(Array.from({ length: 40 }, (_, i) => wikiUserFromCookies(`test_session=random${i}`)));
    assert.ok(peak <= 8);
    assert.equal(random.filter(Boolean).length, 8);
    assert.equal(await wikiUserFromCookies("test_session=oversize"), null);
    const started = Date.now();
    assert.equal(await wikiUserFromCookies("test_session=drip"), null);
    assert.ok(Date.now() - started < 5000);
    assert.equal((await wikiUserFromCookies("test_session=after"))?.id, 1);
  } finally {
    if (old.url === undefined) delete process.env.WIKI_API_URL; else process.env.WIKI_API_URL = old.url;
    if (old.prefix === undefined) delete process.env.WIKI_COOKIE_PREFIX; else process.env.WIKI_COOKIE_PREFIX = old.prefix;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
