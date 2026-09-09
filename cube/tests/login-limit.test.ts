import assert from "node:assert/strict";
import test from "node:test";
import { LoginAdmission, CubeLoginRateLimitError } from "../src/auth/login-limit";
import { canonicalUsername, cubeNativeAuth } from "../src/auth/native";
import { createHandlers } from "../src/http";

test("canonical accounts and random names have independent finite admission", () => {
  let now = 0;
  const limit = new LoginAdmission(() => now);
  for (const name of ["a_b", "A b", " A_b ", "A  b", "a\tb"]) limit.admit(canonicalUsername(name));
  assert.throws(() => limit.admit("A b"), (e: any) => e instanceof CubeLoginRateLimitError && e.retryAfter === 60);
  for (let i = 0; i < 15; i++) limit.admit(`random${i}`);
  assert.throws(() => limit.admit("new"), CubeLoginRateLimitError);
  now = 1000;
  limit.admit("new");
  assert.throws(() => limit.admit("newer"), CubeLoginRateLimitError);
  now = 60_000;
  limit.admit("A b");
});

test("native admission precedes lookup across adapter instances", async () => {
  let queries = 0;
  const pool = { query: async () => { queries++; return { rows: [] }; } } as any;
  for (let i = 0; i < 5; i++) {
    const auth = cubeNativeAuth({ pool });
    assert.equal(await auth.login!({ name: i % 2 ? " Rate_test " : "rate test", password: "wrong" }, new Request("http://local")), null);
  }
  await assert.rejects(cubeNativeAuth({ pool }).login!({ name: "Rate test", password: "wrong" }, new Request("http://local", { headers: { "x-forwarded-for": "1.2.3.4" } })), CubeLoginRateLimitError);
  assert.equal(queries, 5);
});

test("HTTP exposes retry information without changing ordinary auth errors", async () => {
  const cube = { config: { site: { apiBasePath: "/cube" }, auth: { getUser: async () => null, login: async () => { throw new CubeLoginRateLimitError(12); } } } } as any;
  const response = await createHandlers(cube).POST(new Request("http://local/cube/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "test", password: "test" }) }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "12");
});
