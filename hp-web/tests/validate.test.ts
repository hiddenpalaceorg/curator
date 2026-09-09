import { test } from "node:test";
import assert from "node:assert/strict";
import { isSha256, validateBuildRecord } from "../src/lib/validate";

const SHA = "a".repeat(64);

test("isSha256 accepts only 64-char lowercase hex", () => {
  assert.equal(isSha256(SHA), true);
  assert.equal(isSha256("A".repeat(64)), false); // uppercase
  assert.equal(isSha256("a".repeat(63)), false); // too short
  assert.equal(isSha256("a".repeat(65)), false); // too long
  assert.equal(isSha256("g".repeat(64)), false); // non-hex
});

test("validateBuildRecord rejects non-objects and bad image.sha256", () => {
  assert.equal(validateBuildRecord(null).ok, false);
  assert.equal(validateBuildRecord("x").ok, false);
  assert.equal(validateBuildRecord({}).ok, false);
  assert.equal(validateBuildRecord({ image: { sha256: "nope" } }).ok, false);
});

test("validateBuildRecord accepts a minimal valid record", () => {
  const r = validateBuildRecord({ image: { sha256: SHA } });
  assert.equal(r.ok, true);
});

test("structural counts reject malformed values without requiring legacy optional fields", () => {
  for (const count of ["1", {}, [], -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.equal(validateBuildRecord({ image: { sha256: SHA }, structural: { file_count: count } }).ok, false);
  }
  for (const structural of ["bad", [], 1, true]) {
    assert.equal(validateBuildRecord({ image: { sha256: SHA }, structural }).ok, false);
  }
  for (const structural of [undefined, null, {}, { file_count: null }, { file_count: 0 }, { file_count: 200_000 }]) {
    assert.equal(validateBuildRecord({ image: { sha256: SHA }, structural }).ok, true);
  }
});

test("validateBuildRecord walks the contents tree and type-checks arrays", () => {
  const ok = validateBuildRecord({
    image: { sha256: SHA },
    contents: [{ type: "dir", children: [{ type: "file", name: "a" }] }],
  });
  assert.equal(ok.ok, true);

  assert.equal(validateBuildRecord({ image: { sha256: SHA }, contents: "no" }).ok, false);
  assert.equal(validateBuildRecord({ image: { sha256: SHA }, media: "no" }).ok, false);
  assert.equal(validateBuildRecord({ image: { sha256: SHA }, assets: "no" }).ok, false);
});

test("validateBuildRecord enforces the media count cap", () => {
  const media = Array.from({ length: 4097 }, () => ({ kind: "audio" }));
  const r = validateBuildRecord({ image: { sha256: SHA }, media });
  assert.equal(r.ok, false);
});
