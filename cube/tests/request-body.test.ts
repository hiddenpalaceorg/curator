import assert from "node:assert/strict";
import test from "node:test";
import { boundedRequest, BodyLimitError } from "../src/http/body";
import { createHandlers } from "../src/http";

test("bounded reader rejects missing or false byte lengths and cancels overflow", async () => {
  for (const length of [undefined, "1"]) {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode("日本")); }, cancel() { cancelled = true; } });
    const req = new Request("http://local", { method: "POST", body, duplex: "half", headers: length ? { "content-length": length } : {} } as RequestInit);
    await assert.rejects(boundedRequest(req, 8), BodyLimitError);
    assert.ok(cancelled);
    assert.ok(pulls <= 3);
  }
  const result = await boundedRequest(new Request("http://local", { method: "POST", body: "日本語" }), 9);
  assert.equal(await result.text(), "日本語");
});

test("HTTP returns 413 before parse-error fallback can perform work", async () => {
  let calls = 0;
  const cube = { config: { auth: { getUser: async () => { calls++; return null; } } } } as any;
  const request = new Request("http://local/api/cube/auth/login", { method: "POST", body: "x".repeat(8 * 1024 * 1024 + 1) });
  assert.equal((await createHandlers(cube).POST(request)).status, 413);
  assert.equal(calls, 0);
});
