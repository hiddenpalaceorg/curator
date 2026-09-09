import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { readBody, withBoundedBody } from "../src/lib/request-body";
import { POST as submit } from "../src/app/api/submissions/route";
import { POST as similarity } from "../src/app/api/similarity/route";
import { rateLimit } from "../src/lib/ratelimit";
import { MAX_BATCH, MAX_EXTRACT_BODY_BYTES, validateExtractInput } from "../src/lib/mag/kinds";

test("body cap counts actual UTF-8 bytes and cancels a lying stream", async () => {
  for (const declared of [undefined, "1"]) {
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new TextEncoder().encode("日本")); },
      cancel() { cancelled = true; },
    });
    const request = new Request("http://local", { method: "POST", body, duplex: "half", headers: declared ? { "content-length": declared } : {} } as RequestInit);
    const result = await readBody(request, 8);
    assert.ok(result instanceof Response);
    assert.equal(result.status, 413);
    assert.ok(cancelled);
    assert.ok(pulls <= 3);
  }
});

test("bounded route rejects before mutation and preserves ordinary request context", async () => {
  let calls = 0;
  const handler = withBoundedBody(async (req, context: { id: number }) => {
    calls++;
    assert.equal(req.nextUrl.searchParams.get("a"), "b");
    assert.equal(req.headers.get("cookie"), "session=test");
    return Response.json({ value: await req.json().catch(() => null), id: context.id });
  }, 32);
  const normal = new NextRequest("http://local/path?a=b", { method: "POST", headers: { cookie: "session=test" }, body: '{"name":"日本語"}' });
  assert.deepEqual(await (await handler(normal, { id: 3 })).json(), { value: { name: "日本語" }, id: 3 });
  const over = new NextRequest("http://local/path?a=b", { method: "POST", body: " ".repeat(33) });
  assert.equal((await handler(over, { id: 4 })).status, 413);
  assert.equal(calls, 1);
});

test("public admission happens before any body read", async () => {
  for (const [prefix, handler] of [["submissions", submit], ["similarity", similarity]] as const) {
    for (let i = 0; i < 30; i++) rateLimit(`${prefix}:body-test`, 30, 60_000);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(4)); } }, { highWaterMark: 0 });
    const req = new NextRequest(`http://local/api/${prefix}`, { method: "POST", headers: { "x-forwarded-for": "body-test" }, body, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
    assert.equal((await handler(req)).status, 429);
    assert.equal(pulls, 0);
    await body.cancel();
  }
});

test("supported multi-extract batches fit the route byte budget", async () => {
  const extracts = Array.from({ length: MAX_BATCH }, (_, i) => ({ client_key: `test-${i}`, kind: "review", language: "en", text_original: "a".repeat(25_000), regions: [{ pdf_index: 1, x: 0, y: 0, w: 1, h: 1 }] }));
  for (const item of extracts) assert.ok(validateExtractInput(item).ok);
  const bytes = await readBody(new Request("http://local", { method: "POST", body: JSON.stringify(extracts) }), MAX_BATCH * MAX_EXTRACT_BODY_BYTES);
  assert.ok(!(bytes instanceof Response));
  assert.ok(bytes.byteLength > 1024 * 1024);
});
