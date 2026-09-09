// The content-addressed blob store backing the asset viewer, the attached-repo
// viewer, and the submission upload path — one facade, two backends:
//
// - local (default): blobs at `<ASSET_STORE_DIR>/<sha256[:2]>/<sha256>`, the
//   layout ingest has always produced.
// - s3: an S3-compatible object store, selected by setting ASSET_S3_ENDPOINT
//   (in production the same versitygw service the wiki's uploads go to, with
//   a bucket of its own). Keys mirror the local layout —
//   `<ASSET_S3_PREFIX><sha256[:2]>/<sha256>` — so versitygw's POSIX backend
//   lays the bucket out on disk exactly like a local store.
//
// Under the s3 backend ASSET_STORE_DIR still serves as the local root for
// what must stay on disk: upload staging (.staging), ffmpeg's derivative
// caches (.transcode, .thumb), and sources materialized for ffmpeg (.fetch).
//
// Config (s3 backend): ASSET_S3_ENDPOINT, ASSET_S3_BUCKET (default
// "prism"), ASSET_S3_PREFIX (default "", for scratch/test namespaces),
// ASSET_S3_REGION (default "us-east-1"), ASSET_S3_ACCESS_KEY_ID +
// ASSET_S3_SECRET_ACCESS_KEY (else the SDK's default credential chain), and
// ASSET_S3_INSECURE_TLS=1 to accept a self-signed endpoint certificate.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Agent } from "node:https";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";

/** Root of the local store (blobs on the local backend; staging and caches
 *  always). Defaults next to the app: survives the deploy rsync, git-ignored. */
export function assetStoreDir(): string {
  return process.env.ASSET_STORE_DIR || path.join(process.cwd(), "asset-store");
}

/** Local path of one blob. Caller must have validated `sha256` (isSha256).
 *  `ns` selects a store namespace ("" = assets, "media/" = user media); a
 *  namespace name can't collide with the two-hex-char blob dirs. */
export function assetBlobPath(sha256: string, ns = ""): string {
  const parts = ns ? [ns.replace(/\/+$/, "")] : [];
  return path.join(assetStoreDir(), ...parts, sha256.slice(0, 2), sha256);
}

/** Staging file for a blob's chunked upload (`.staging` can't collide with the
 *  two-hex-char blob dirs). Caller must have validated `sha256`. */
export function assetStagingPath(sha256: string, token?: string): string {
  if (token !== undefined && !/^[0-9a-f]{32}$/.test(token)) throw new Error("invalid upload token");
  return path.join(assetStoreDir(), ".staging", `${sha256}${token ? `-${token}` : ""}.part`);
}

const ASSET_PART_NAME = /^[0-9a-f]{64}(?:-[0-9a-f]{32})?\.part$/;

/** All uploader-private partial copies contribute to the digest's quota. */
export async function assetStagingStats(sha256: string): Promise<{bytes:number;count:number}> {
  let dir;
  try { dir = await fsp.opendir(path.join(assetStoreDir(), ".staging")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {bytes:0,count:0}; throw e; }
  let bytes = 0, count = 0;
  for await (const entry of dir) {
    if (entry.name.slice(0,64) !== sha256 || !ASSET_PART_NAME.test(entry.name)) continue;
    bytes += (await fsp.stat(path.join(assetStoreDir(), ".staging", entry.name))).size;
    count++;
  }
  return {bytes,count};
}

// Asset staging files (`<sha>.part`) abandoned this long are reaped, so a flood
// of never-finalized uploads can't pile up on the store disk. Media sessions
// (`media-*`) carry their own reaper and are left alone here.
const ASSET_STAGING_TTL_MS = 24 * 3600_000;

/** Remove asset staging files past the TTL. Best-effort and opportunistic —
 *  the asset upload route calls it before staging a fresh chunk. */
export async function reapStaleAssetStaging(
  guard?: (sha: string, reap: () => Promise<void>) => Promise<void>
): Promise<string[]> {
  const reaped: string[] = [];
  const dir = path.join(assetStoreDir(), ".staging");
  const cutoff = Date.now() - ASSET_STAGING_TTL_MS;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return reaped;
  }
  for (const name of names) {
    if (!ASSET_PART_NAME.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if ((await fsp.stat(p)).mtimeMs >= cutoff) continue;
      const reap = async () => {
        // Recheck after acquiring the upload's lease, not before it.
        if ((await fsp.stat(p)).mtimeMs < cutoff) {
          await fsp.rm(p, { force: true });
          reaped.push(name.slice(0, 64));
        }
      };
      if (guard) await guard(name.slice(0, 64), reap);
      else await reap();
    } catch {
      // Raced with another reaper or an active finalize; leave it.
    }
  }
  return reaped;
}

/** Free space the store filesystem must keep in reserve: staging writes refuse
 *  below it, so an upload flood can't fill the disk out from under Postgres and
 *  in-flight transcodes (env ASSET_STORE_MIN_FREE_BYTES, default 5 GiB). */
export function storeMinFreeBytes(): number {
  const raw = Number(process.env.ASSET_STORE_MIN_FREE_BYTES);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5 * 1024 * 1024 * 1024;
}

/** Free bytes on the filesystem backing the local store, or null when it can't
 *  be determined (a stat failure must never wedge uploads). */
export async function storeFreeBytes(): Promise<number | null> {
  try {
    const s = await fsp.statfs(assetStoreDir());
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Whether the store can take `need` more bytes and still hold the reserve. */
export async function hasStagingHeadroom(need = 0): Promise<boolean> {
  const free = await storeFreeBytes();
  if (free === null) return true;
  return free - need >= storeMinFreeBytes();
}

/** Whether blob reads/writes go to the S3 backend. */
export function s3Enabled(): boolean {
  return !!process.env.ASSET_S3_ENDPOINT;
}

/** Where blobs land, for operator-facing log lines. */
export function storeDescription(): string {
  if (!s3Enabled()) return assetStoreDir();
  return `${process.env.ASSET_S3_ENDPOINT}/${s3Bucket()}/${s3Prefix()}`;
}

export function storeIdentity(): string {
  return JSON.stringify(s3Enabled()
    ? [process.env.ASSET_S3_ENDPOINT, s3Bucket(), s3Prefix(), path.resolve(assetStoreDir())]
    : ["local", path.resolve(assetStoreDir())]);
}

/** Actual asset objects and partial assets; excludes separate media namespaces. */
export async function* inventoryAssetBytes(): AsyncGenerator<{ sha256: string; size: number; staged?: boolean }> {
  if (s3Enabled()) {
    let token: string | undefined;
    do {
      const page = await s3().send(new ListObjectsV2Command({ Bucket: s3Bucket(), Prefix: s3Prefix(), ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        const key = object.Key?.slice(s3Prefix().length) ?? "";
        if (/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key) && key.slice(0, 2) === key.slice(3, 5)) {
          if (object.Size === undefined) throw new Error("missing object size");
          yield { sha256: key.slice(3), size: object.Size };
        }
      }
      if (page.IsTruncated && !page.NextContinuationToken) throw new Error("incomplete object listing");
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  } else {
    for (let i = 0; i < 256; i++) {
      const shard = i.toString(16).padStart(2, "0");
      let dir;
      try { dir = await fsp.opendir(path.join(assetStoreDir(), shard)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
      for await (const entry of dir) {
        if (/^[0-9a-f]{64}$/.test(entry.name) && entry.name.startsWith(shard)) {
          const stat = await fsp.stat(path.join(assetStoreDir(), shard, entry.name));
          if (!stat.isFile()) throw new Error("invalid asset object");
          yield { sha256: entry.name, size: stat.size };
        }
      }
    }
  }
  let staging;
  try { staging = await fsp.opendir(path.join(assetStoreDir(), ".staging")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  for await (const entry of staging) {
    if (!ASSET_PART_NAME.test(entry.name)) continue;
    yield { sha256: entry.name.slice(0, 64), size: (await fsp.stat(path.join(assetStoreDir(), ".staging", entry.name))).size, staged: true };
  }
}

function s3Bucket(): string {
  return process.env.ASSET_S3_BUCKET || "prism";
}

function s3Prefix(): string {
  return process.env.ASSET_S3_PREFIX || "";
}

function s3Key(sha256: string, ns = ""): string {
  return `${s3Prefix()}${ns}${sha256.slice(0, 2)}/${sha256}`;
}

// One client per process; the config is env-fixed for the process lifetime.
let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) {
    const accessKeyId = process.env.ASSET_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.ASSET_S3_SECRET_ACCESS_KEY;
    client = new S3Client({
      endpoint: process.env.ASSET_S3_ENDPOINT,
      region: process.env.ASSET_S3_REGION || "us-east-1",
      // versitygw/minio address buckets by path, not virtual host.
      forcePathStyle: true,
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
      ...(process.env.ASSET_S3_INSECURE_TLS === "1"
        ? {
            requestHandler: new NodeHttpHandler({
              // Mirror the SDK default agent's keepAlive/maxSockets — a bare
              // Agent would open a fresh TLS connection per request, and that
              // handshake churn both triples latency and trips the endpoint's
              // connection defenses under load. Bounded timeouts so a wedged
              // connection surfaces as a retryable error, not a silent hang.
              httpsAgent: new Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 50 }),
              connectionTimeout: 5_000,
              requestTimeout: 120_000,
            }),
          }
        : {}),
    });
  }
  return client;
}

/** Errors that mean "no such object", as opposed to a broken store. */
function isMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/** Byte size of a blob, or null when it is missing from the store. */
export async function blobSize(sha256: string, ns = ""): Promise<number | null> {
  if (s3Enabled()) {
    try {
      const r = await s3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: s3Key(sha256, ns) }));
      return r.ContentLength ?? null;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }
  try {
    return (await fsp.stat(assetBlobPath(sha256, ns))).size;
  } catch {
    return null;
  }
}

export async function blobExists(sha256: string, ns = ""): Promise<boolean> {
  return (await blobSize(sha256, ns)) !== null;
}

// Bounds concurrent requests in missingBlobs (and nothing else): high enough
// to hide the per-request latency, low enough to be a polite S3 client.
const EXISTS_CONCURRENCY = 16;

// Below this many blobs, per-blob HEADs beat shard listings.
const LIST_THRESHOLD = 16;

/** All keys under one 2-hex shard prefix (paginated past 1000). */
async function listShard(shard: string): Promise<Set<string>> {
  const keys = new Set<string>();
  const prefix = `${s3Prefix()}${shard}/`;
  let token: string | undefined;
  do {
    const r = await s3().send(
      new ListObjectsV2Command({ Bucket: s3Bucket(), Prefix: prefix, ContinuationToken: token })
    );
    for (const o of r.Contents ?? []) keys.add(o.Key!.slice(prefix.length));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** The subset of `shas` missing from the store, in input order.
 *
 *  On s3, big sets are answered by listing each referenced 2-hex shard once
 *  (one round trip covers every blob in the shard) instead of a HEAD per
 *  blob: a 4096-asset submission's check would otherwise take minutes of
 *  sequential-ish round trips and blow the desktop clients' HTTP timeouts. */
export async function missingBlobs(shas: string[]): Promise<string[]> {
  if (!s3Enabled()) return shas.filter((s) => !fs.existsSync(assetBlobPath(s)));

  if (shas.length <= LIST_THRESHOLD) {
    const present = new Array<boolean>(shas.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(EXISTS_CONCURRENCY, shas.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= shas.length) return;
          present[i] = await blobExists(shas[i]);
        }
      })
    );
    return shas.filter((_, i) => !present[i]);
  }

  const shards = [...new Set(shas.map((s) => s.slice(0, 2)))];
  const present = new Set<string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(EXISTS_CONCURRENCY, shards.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= shards.length) return;
        for (const key of await listShard(shards[i])) present.add(key);
      }
    })
  );
  return shas.filter((s) => !present.has(s));
}

/** A readable stream over a blob (optionally one byte range), or null when it
 *  is missing from the store. */
export async function openBlobStream(
  sha256: string,
  range?: { start: number; end: number },
  ns = ""
): Promise<Readable | null> {
  if (s3Enabled()) {
    try {
      const r = await s3().send(
        new GetObjectCommand({
          Bucket: s3Bucket(),
          Key: s3Key(sha256, ns),
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        })
      );
      return r.Body as Readable;
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }
  // open() first so a missing blob is a null, not a later stream error event.
  try {
    const fh = await fsp.open(assetBlobPath(sha256, ns), "r");
    return fh.createReadStream(range ? { start: range.start, end: range.end } : {});
  } catch {
    return null;
  }
}

/** A whole blob in memory, or null when it is missing from the store.
 *  Callers cap sizes (convert/preview paths); don't hand this a DVD image. */
export async function readBlob(sha256: string, ns = ""): Promise<Buffer | null> {
  if (s3Enabled()) {
    try {
      const r = await s3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: s3Key(sha256, ns) }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }
  try {
    return await fsp.readFile(assetBlobPath(sha256, ns));
  } catch {
    return null;
  }
}

/** Leading bytes of a blob, or null when it is missing from the store. */
export async function readBlobHead(sha256: string, maxBytes = 2048): Promise<Buffer | null> {
  if (s3Enabled()) {
    try {
      const r = await s3().send(
        new GetObjectCommand({
          Bucket: s3Bucket(),
          Key: s3Key(sha256),
          Range: `bytes=0-${maxBytes - 1}`,
        })
      );
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (err) {
      if (isMissing(err)) return null;
      // An empty object satisfies no byte range (416) but does exist.
      if (httpStatus(err) === 416) {
        return (await blobSize(sha256)) === null ? null : Buffer.alloc(0);
      }
      throw err;
    }
  }
  let fh;
  try {
    fh = await fsp.open(assetBlobPath(sha256), "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** Move a completed local file into the store ("exists" means an identical
 *  blob was already stored — content-addressed, so concurrent writers of the
 *  same key can only race harmlessly). Consumes `src` unless `keepSource` is
 *  set (the migration script pushes the local store without eating it). */
export async function storeBlobFromFile(
  sha256: string,
  src: string,
  opts?: { keepSource?: boolean; ns?: string }
): Promise<"stored" | "exists"> {
  const ns = opts?.ns ?? "";
  const cleanup = async () => {
    if (!opts?.keepSource) await fsp.rm(src, { force: true });
  };
  if (s3Enabled()) {
    if (await blobExists(sha256, ns)) {
      await cleanup();
      return "exists";
    }
    // Multipart so multi-GB video blobs upload in bounded memory with
    // per-part retries.
    await new Upload({
      client: s3(),
      params: { Bucket: s3Bucket(), Key: s3Key(sha256, ns), Body: fs.createReadStream(src) },
    }).done();
    await cleanup();
    return "stored";
  }
  const dest = assetBlobPath(sha256, ns);
  if (fs.existsSync(dest)) {
    await cleanup();
    return "exists";
  }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // Copy to a private temp name in the final dir, then rename, so a crash
  // can't leave a truncated blob under its final name.
  const copyIn = async () => {
    const tmp = `${dest}.tmp${process.pid}`;
    await fsp.copyFile(src, tmp);
    await fsp.rename(tmp, dest);
    await cleanup();
  };
  if (opts?.keepSource) {
    await copyIn();
    return "stored";
  }
  try {
    // Same-filesystem fast path (upload staging lives inside the store root).
    await fsp.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      // Cross-device source (ingest stages under os.tmpdir).
      await copyIn();
    } else if (fs.existsSync(dest)) {
      await cleanup();
      return "exists";
    } else {
      throw err;
    }
  }
  return "stored";
}

/** Write one in-memory blob into the store. True when newly stored, false
 *  when an identical blob was already there. */
export async function storeBlobBytes(sha256: string, data: Uint8Array): Promise<boolean> {
  if (s3Enabled()) {
    if (await blobExists(sha256)) return false;
    await s3().send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: s3Key(sha256),
        Body: data,
        ContentLength: data.byteLength,
      })
    );
    return true;
  }
  const dest = assetBlobPath(sha256);
  if (fs.existsSync(dest)) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp${process.pid}`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, dest);
  return true;
}

/** Run `fn` with a blob available at a local path — the store file itself on
 *  the local backend, a temp copy under `.fetch/` on s3 (ffmpeg wants a real
 *  file it can seek). Returns null when the blob is missing from the store. */
export async function withBlobFile<T>(
  sha256: string,
  fn: (localPath: string) => Promise<T>,
  ns = ""
): Promise<T | null> {
  if (!s3Enabled()) {
    const p = assetBlobPath(sha256, ns);
    if (!fs.existsSync(p)) return null;
    return fn(p);
  }
  const stream = await openBlobStream(sha256, undefined, ns);
  if (!stream) return null;
  const dir = path.join(assetStoreDir(), ".fetch");
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${sha256}.${randomBytes(4).toString("hex")}`);
  try {
    await pipeline(stream, fs.createWriteStream(tmp));
    return await fn(tmp);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
