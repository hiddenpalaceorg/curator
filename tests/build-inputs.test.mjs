import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("workflow actions and executable generators use immutable inputs", () => {
  const directory = new URL("../.github/workflows/", import.meta.url);
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".yml"))) {
    const source = readFileSync(new URL(name, directory), "utf8");
    for (const match of source.matchAll(/uses:\s+([^\s#]+)/g)) assert.match(match[1], /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, name);
    assert.doesNotMatch(source, /cargo install[^\n]*--tag/);
    assert.doesNotMatch(source, /--with (?:pycdlib|numpy|pytest)(?=\s)/);
  }
  const ci = readFileSync(new URL("ci.yml", directory), "utf8");
  const setupUvCount = [...ci.matchAll(/uses: astral-sh\/setup-uv@/g)].length;
  assert.ok(setupUvCount > 0);
  assert.equal([...ci.matchAll(/uses: astral-sh\/setup-uv@[0-9a-f]{40}[^]*?version: "0\.11\.2"/g)].length, setupUvCount);
  const revision = ci.match(/--rev ([0-9a-f]{40})/)[1];
  assert.ok(ci.includes(`key: uniffi-bindgen-cs-${revision}`));
  const local = readFileSync(new URL("../windows/build.ps1", import.meta.url), "utf8");
  assert.ok(local.includes(revision));
  assert.doesNotMatch(local, /--tag/);
  assert.match(local, /--root \$bindgenRoot --force/);
  assert.match(local, /& \$bindgenExe --library/);
  assert.match(readFileSync(new URL("../rust-toolchain.toml", import.meta.url), "utf8"), /channel = "\d+\.\d+\.\d+"/);
});
