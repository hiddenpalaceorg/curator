/**
 * Media upload + moderation tracks against a dedicated scratch DB
 * (cube_test_media) and a mkdtemp localDirStorage, so parallel suites never
 * collide. Skips without Postgres.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { createUser, cubeNativeAuth } from "../src/auth/native";
import { createCube, type Cube } from "../src/index";
import { localDirStorage } from "../src/storage";
import { testComponents } from "./helpers";

const DB = "cube_test_media";
let pool: pg.Pool;
let cube: Cube;
let cubeNoStorage: Cube;
let dir: string;
let available = true;

before(async () => {
  const admin = new pg.Pool({ database: "postgres" });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
  } catch (err) {
    available = false;
    console.log(`# skipping media/moderation tests: ${(err as Error).message}`);
    return;
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ database: DB });
  await pool.query(readFileSync(new URL("../db/migrations/001-init.sql", import.meta.url), "utf8"));
  dir = await mkdtemp(join(tmpdir(), "cube-media-test-"));
  const auth = cubeNativeAuth({ pool, secure: false });
  cube = createCube({
    db: { pool },
    components: testComponents,
    auth,
    storage: localDirStorage({ dir }),
  });
  cubeNoStorage = createCube({ db: { pool }, components: testComponents, auth });
});

after(async () => {
  await pool?.end();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function skippable(name: string, fn: () => Promise<void>) {
  test(name, { skip: !available && "postgres unavailable" }, fn);
}

const API = "http://cube.test/api/cube";

function req(
  method: string,
  path: string,
  // Uint8Array<ArrayBuffer>, not the ArrayBufferLike default: DOM's BufferSource
  // (BodyInit) is pinned to ArrayBuffer since typed arrays became generic.
  opts: { body?: unknown; headers?: Record<string, string>; bytes?: Uint8Array<ArrayBuffer> } = {},
) {
  return new Request(`${API}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined && { "content-type": "application/json" }),
      ...opts.headers,
    },
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    ...(opts.bytes !== undefined && { body: opts.bytes }),
  });
}

function csrf(cookie: string): Record<string, string> {
  return { cookie, "sec-fetch-site": "same-origin" };
}

async function login(name: string, password: string): Promise<string> {
  const res = await cube.handlers.POST(req("POST", "/auth/login", { body: { name, password } }));
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function sha256hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

const PNG_V1 = Buffer.from("fake png bytes, version one");
const PNG_V2 = Buffer.from("fake png bytes, version two, different content");

skippable("active media is sandboxed and never redirected to a public gateway", async () => {
  const { uploadMedia } = await import("../src/media");
  const storage = localDirStorage({ dir, publicBase: `${API}/static` });
  const gateway = createCube({ db: { pool }, components: testComponents, storage });
  for (const mime of ["image/svg+xml", "Image/SVG+XML; charset=utf-8", "text/html", "application/xhtml+xml"]) {
    const name = `active-${encodeURIComponent(mime)}.svg`;
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await uploadMedia(pool, storage, { name, body: bytes, contentType: mime, uploader: { name: "test" } });
    const res = await gateway.handlers.GET(req("GET", `/media/file?name=${encodeURIComponent(name)}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }
});

let uploaderCookie = "";
let modCookie = "";
let vandalCookie = "";

skippable("setup: users and logins", async () => {
  await createUser(pool, { name: "uploader", password: "up-pass" });
  await createUser(pool, { name: "mod", password: "modpass", roles: ["moderator"] });
  await createUser(pool, { name: "vandal", password: "vandalpass" });
  uploaderCookie = await login("uploader", "up-pass");
  modCookie = await login("mod", "modpass");
  vandalCookie = await login("vandal", "vandalpass");
});

/* ---- media ---- */

skippable("anonymous upload is forbidden", async () => {
  const res = await cube.handlers.POST(
    req("POST", "/media?name=F.png", { bytes: PNG_V1, headers: { "content-type": "image/png" } }),
  );
  assert.equal(res.status, 403);
});

skippable("upload without a storage adapter returns 501 no_storage", async () => {
  const res = await cubeNoStorage.handlers.POST(
    req("POST", "/media?name=F.png", {
      bytes: PNG_V1,
      headers: { "content-type": "image/png", ...csrf(uploaderCookie) },
    }),
  );
  assert.equal(res.status, 501);
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "no_storage");
});

skippable("upload creates the row and blob; /media/file streams the bytes", async () => {
  const res = await cube.handlers.POST(
    req("POST", "/media?name=F.png", {
      bytes: PNG_V1,
      headers: { "content-type": "image/png", ...csrf(uploaderCookie) },
    }),
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as { name: string; sha256: string; size: number };
  const sha = sha256hex(PNG_V1);
  assert.deepEqual(body, { name: "F.png", sha256: sha, size: PNG_V1.length });

  const row = await pool.query(`SELECT storage_key, sha256, size, mime FROM cube_media WHERE name = 'F.png'`);
  assert.equal(row.rows[0].storage_key, `${sha.slice(0, 2)}/${sha}`);
  assert.equal(row.rows[0].mime, "image/png");
  assert.ok(existsSync(join(dir, sha.slice(0, 2), sha)));

  const file = await cube.handlers.GET(req("GET", "/media/file?name=F.png"));
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.equal(file.headers.get("content-disposition"), null);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_V1);
});

skippable("re-upload of identical bytes is a no-op (no revision row)", async () => {
  const res = await cube.handlers.POST(
    req("POST", "/media?name=F.png", {
      bytes: PNG_V1,
      headers: { "content-type": "image/png", ...csrf(uploaderCookie) },
    }),
  );
  assert.equal(res.status, 200);
  const revs = await pool.query(`SELECT count(*)::int AS n FROM cube_media_revision`);
  assert.equal(Number(revs.rows[0].n), 0);
});

skippable("overwrite pushes the old version into cube_media_revision", async () => {
  const oldSha = sha256hex(PNG_V1);
  const newSha = sha256hex(PNG_V2);
  const res = await cube.handlers.POST(
    req("POST", "/media?name=F.png", {
      bytes: PNG_V2,
      headers: { "content-type": "image/png", ...csrf(uploaderCookie) },
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sha256: string };
  assert.equal(body.sha256, newSha);

  const info = await cube.handlers.GET(req("GET", "/media/info?name=F.png"));
  assert.equal(info.status, 200);
  const meta = (await info.json()) as { sha256: string; revisions: { sha256: string }[] };
  assert.equal(meta.sha256, newSha);
  assert.equal(meta.revisions.length, 1);
  assert.equal(meta.revisions[0]!.sha256, oldSha);

  const overwriteLog = await pool.query(
    `SELECT detail FROM cube_page_log WHERE action = 'media-overwrite'`,
  );
  assert.equal(overwriteLog.rows.length, 1);
  assert.equal(overwriteLog.rows[0].detail.sha256, newSha);
});

skippable("media search finds names by trgm", async () => {
  const res = await cube.handlers.GET(req("GET", "/media/search?q=F.png"));
  assert.equal(res.status, 200);
  const { hits } = (await res.json()) as { hits: { name: string }[] };
  assert.ok(hits.some((h) => h.name === "F.png"));
});

skippable("delete is refused while a page references the file, force wins", async () => {
  const save = await cube.handlers.PUT(
    req("PUT", "/page?title=Game X (proto)", {
      body: { markdown: `<Prototype game="X" titleScreen="F.png" />\n` },
      headers: csrf(uploaderCookie),
    }),
  );
  assert.equal(save.status, 201);
  const link = await pool.query(`SELECT 1 FROM cube_link WHERE to_ns = 'file' AND to_slug = 'F.png'`);
  assert.equal(link.rows.length, 1);

  const nonMod = await cube.handlers.DELETE(
    req("DELETE", "/media?name=F.png", { body: {}, headers: csrf(uploaderCookie) }),
  );
  assert.equal(nonMod.status, 403);

  const refused = await cube.handlers.DELETE(
    req("DELETE", "/media?name=F.png", { body: {}, headers: csrf(modCookie) }),
  );
  assert.equal(refused.status, 409);
  const refusedBody = (await refused.json()) as { error: { code: string } };
  assert.equal(refusedBody.error.code, "referenced");

  const forced = await cube.handlers.DELETE(
    req("DELETE", "/media?name=F.png", { body: { force: true }, headers: csrf(modCookie) }),
  );
  assert.equal(forced.status, 200);
  const gone = await cube.handlers.GET(req("GET", "/media/info?name=F.png"));
  assert.equal(gone.status, 404);
});

/* ---- moderation ---- */

skippable("protect blocks non-moderator edits end to end; unprotect restores", async () => {
  const create = await cube.handlers.PUT(
    req("PUT", "/page?title=Guarded Page", {
      body: { markdown: "Original.\n" },
      headers: csrf(uploaderCookie),
    }),
  );
  assert.equal(create.status, 201);
  const { revision } = (await create.json()) as { revision: number };

  const nonMod = await cube.handlers.POST(
    req("POST", "/moderation/protect", {
      body: { title: "Guarded Page", protection: { edit: "moderator" } },
      headers: csrf(uploaderCookie),
    }),
  );
  assert.equal(nonMod.status, 403);

  const protect = await cube.handlers.POST(
    req("POST", "/moderation/protect", {
      body: { title: "Guarded Page", protection: { edit: "moderator" } },
      headers: csrf(modCookie),
    }),
  );
  assert.equal(protect.status, 200);

  const denied = await cube.handlers.PUT(
    req("PUT", "/page?title=Guarded Page", {
      body: { markdown: "Changed.\n", baseRevision: revision },
      headers: csrf(uploaderCookie),
    }),
  );
  assert.equal(denied.status, 403);

  const unprotect = await cube.handlers.POST(
    req("POST", "/moderation/protect", {
      body: { title: "Guarded Page", protection: {} },
      headers: csrf(modCookie),
    }),
  );
  assert.equal(unprotect.status, 200);

  const allowed = await cube.handlers.PUT(
    req("PUT", "/page?title=Guarded Page", {
      body: { markdown: "Changed.\n", baseRevision: revision },
      headers: csrf(uploaderCookie),
    }),
  );
  assert.equal(allowed.status, 200);

  const log = await pool.query(`SELECT count(*)::int AS n FROM cube_page_log WHERE action = 'protect'`);
  assert.equal(Number(log.rows[0].n), 2);
});

skippable("vandalism setup: vandal edits an existing page and creates a new one", async () => {
  const create = await cube.handlers.PUT(
    req("PUT", "/page?title=Croc Guide", {
      body: { markdown: "Good content.\n" },
      headers: csrf(uploaderCookie),
    }),
  );
  assert.equal(create.status, 201);
  const { revision } = (await create.json()) as { revision: number };

  const vandalize = await cube.handlers.PUT(
    req("PUT", "/page?title=Croc Guide", {
      body: { markdown: "VANDALIZED.\n", baseRevision: revision },
      headers: csrf(vandalCookie),
    }),
  );
  assert.equal(vandalize.status, 200);

  const spam = await cube.handlers.PUT(
    req("PUT", "/page?title=Vandal Spam", {
      body: { markdown: "Buy things.\n" },
      headers: csrf(vandalCookie),
    }),
  );
  assert.equal(spam.status, 201);
});

skippable("block kills the session and denies further writes", async () => {
  const block = await cube.handlers.POST(
    req("POST", "/moderation/block", {
      body: { name: "vandal", reason: "spam" },
      headers: csrf(modCookie),
    }),
  );
  assert.equal(block.status, 200);

  const me = await cube.handlers.GET(req("GET", "/auth/me", { headers: { cookie: vandalCookie } }));
  const body = (await me.json()) as { user: unknown };
  assert.equal(body.user, null);

  const denied = await cube.handlers.PUT(
    req("PUT", "/page?title=Croc Guide", {
      body: { markdown: "More vandalism.\n" },
      headers: csrf(vandalCookie),
    }),
  );
  assert.equal(denied.status, 403);

  const row = await pool.query(`SELECT blocked_at, block_reason FROM cube_user WHERE name = 'Vandal'`);
  assert.ok(row.rows[0].blocked_at !== null);
  assert.equal(row.rows[0].block_reason, "spam");
});

skippable("mass revert restores the vandalized page and deletes the net-new one", async () => {
  const res = await cube.handlers.POST(
    req("POST", "/moderation/mass-revert", {
      body: { user: "vandal", sinceHours: 1 },
      headers: csrf(modCookie),
    }),
  );
  assert.equal(res.status, 200);
  const result = (await res.json()) as { reverted: number; deleted: number; skipped: unknown[] };
  assert.equal(result.reverted, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.skipped, []);

  const restored = await cube.handlers.GET(req("GET", "/page?title=Croc Guide"));
  assert.equal(restored.status, 200);
  const page = (await restored.json()) as { markdown: string };
  assert.equal(page.markdown, "Good content.\n");

  // The revert is a NEW revision by the actor; history stays intact.
  const revs = await cube.handlers.GET(req("GET", "/revisions?title=Croc Guide"));
  const { revisions } = (await revs.json()) as { revisions: { author: string; comment: string }[] };
  assert.equal(revisions.length, 3);
  assert.equal(revisions[0]!.author, "Mod");
  assert.equal(revisions[0]!.comment, "mass revert of Vandal");

  const gone = await cube.handlers.GET(req("GET", "/page?title=Vandal Spam"));
  assert.equal(gone.status, 404);
});

skippable("/changes returns the feed with the revert entries", async () => {
  const res = await cube.handlers.GET(req("GET", "/changes?limit=100"));
  assert.equal(res.status, 200);
  const { changes } = (await res.json()) as {
    changes: { slug: string; author: string; comment: string; delta: number }[];
  };
  const revert = changes.find((c) => c.comment === "mass revert of Vandal");
  assert.ok(revert);
  assert.equal(revert.author, "Mod");
  assert.equal(revert.slug, "Croc_Guide");
  // Feed is newest-first and the revert is the newest surviving revision.
  assert.equal(changes[0]!.comment, "mass revert of Vandal");
  // Deleted pages drop out of the feed entirely.
  assert.ok(!changes.some((c) => c.slug === "Vandal_Spam"));

  const filtered = await cube.handlers.GET(req("GET", "/changes?user=Mod"));
  const modOnly = (await filtered.json()) as { changes: { author: string }[] };
  assert.ok(modOnly.changes.length >= 1);
  assert.ok(modOnly.changes.every((c) => c.author === "Mod"));
});
