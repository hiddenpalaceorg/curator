/**
 * Media pipeline: content-addressed blobs through the
 * configured CubeStorageAdapter, MW File: naming semantics on cube_media, and
 * overwrite history in cube_media_revision. v1 buffers uploads in memory
 * under a size cap; chunked/resumable staging for the 60 GB parity bar is a
 * tracked follow-up.
 */

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { withTx } from "./db";
import { isTitleError, normalizeTitle, type SlugConfig } from "./slug";
import type { CubeStorageAdapter } from "./storage";

export const DEFAULT_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** Media names use title rules but never namespace-split ("Foo:bar.png" is a name). */
const MEDIA_SLUG: SlugConfig = { namespacePrefixes: {}, capitalLinks: true };

export class CubeMediaError extends Error {
  constructor(
    readonly code: "invalid_name" | "too_large" | "referenced" | "not_found" | "forbidden",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CubeMediaError";
  }
}

export type MediaActor = {
  id?: number | null;
  name: string;
};

export type UploadMediaInput = {
  name: string;
  body: Uint8Array | Readable;
  contentType?: string;
  /** Advisory only; the buffered length is authoritative. */
  size?: number;
  uploader: MediaActor;
  /** In-memory buffering cap (v1); default DEFAULT_MAX_UPLOAD_BYTES. */
  maxBytes?: number;
  /** Remote callers must supply restoration authority; local imports remain trusted. */
  authorizeRestore?: () => boolean | Promise<boolean>;
};

export type UploadMediaResult = {
  id: number;
  name: string;
  sha256: string;
  size: number;
  /** New cube_media row (vs overwrite/no-op of an existing name). */
  created: boolean;
  overwrote: boolean;
  noop: boolean;
};

export type MediaRow = {
  id: number;
  name: string;
  storageKey: string;
  sha256: string | null;
  size: number | null;
  mime: string | null;
  uploadedBy: number | null;
  uploadedAt: Date;
};

export type MediaRevisionRow = {
  id: number;
  storageKey: string;
  sha256: string | null;
  size: number | null;
  mime: string | null;
  uploadedBy: number | null;
  uploadedAt: Date;
  note: string | null;
};

/** Canonical (dbkey) media name; matches cube_link's to_slug for kind=media. */
function mediaName(name: string): string {
  const ref = normalizeTitle(name, MEDIA_SLUG);
  if (isTitleError(ref)) {
    throw new CubeMediaError("invalid_name", 400, `invalid media name: ${ref.error}`);
  }
  return ref.slug;
}

export function storageKeyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

async function bufferBody(body: Uint8Array | Readable, cap: number): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > cap) {
      throw new CubeMediaError("too_large", 413, `upload exceeds the ${cap} byte cap`);
    }
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > cap) {
      throw new CubeMediaError("too_large", 413, `upload exceeds the ${cap} byte cap`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function logMedia(
  client: PoolClient,
  action: string,
  actor: MediaActor,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
     VALUES (NULL, $1, $2, $3, $4)`,
    [action, actor.id ?? null, actor.name, JSON.stringify(detail)],
  );
}

/**
 * Upload a blob under a File: name. Content-addressed (sha256) storage keys
 * mean identical bytes are stored once; an overwrite of an existing name
 * pushes the previous version into cube_media_revision and updates the row
 * in place, so every page referencing the name picks up the new content.
 */
export async function uploadMedia(
  pool: Pool,
  storage: CubeStorageAdapter,
  input: UploadMediaInput,
): Promise<UploadMediaResult> {
  const name = mediaName(input.name);
  const buf = await bufferBody(input.body, input.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const key = storageKeyFor(sha256);

  return withTx(pool, async (client) => {
    const existing = await client.query(
      `SELECT id, storage_key, sha256, size, mime, uploaded_by, uploaded_at, deleted_at
         FROM cube_media WHERE name = $1 FOR UPDATE`,
      [name],
    );
    const row = existing.rows[0];
    if (row?.deleted_at != null && input.authorizeRestore && !(await input.authorizeRestore())) {
      throw new CubeMediaError("forbidden", 403, "not allowed to restore media");
    }
    // Authorize the locked state before storing bytes; both restore paths
    // below must keep a moderator's deletion intact when permission is denied.
    if (!(await storage.has(key))) {
      await storage.put(key, buf, {
        contentType: input.contentType,
        size: buf.length,
        downloadName: name,
      });
    }

    if (row === undefined) {
      const ins = await client.query(
        `INSERT INTO cube_media (name, storage_key, sha256, size, mime, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [name, key, sha256, buf.length, input.contentType ?? null, input.uploader.id ?? null],
      );
      await logMedia(client, "media-upload", input.uploader, { name, sha256, size: buf.length });
      return {
        id: Number(ins.rows[0].id),
        name,
        sha256,
        size: buf.length,
        created: true,
        overwrote: false,
        noop: false,
      };
    }

    const id = Number(row.id);
    if (row.sha256 === sha256) {
      if (row.deleted_at !== null) {
        // Re-upload of identical content restores a soft-deleted entry.
        await client.query(
          `UPDATE cube_media SET deleted_at = NULL, uploaded_by = $2, uploaded_at = now() WHERE id = $1`,
          [id, input.uploader.id ?? null],
        );
        await logMedia(client, "media-upload", input.uploader, { name, sha256, size: buf.length });
        return { id, name, sha256, size: buf.length, created: false, overwrote: false, noop: false };
      }
      return { id, name, sha256, size: buf.length, created: false, overwrote: false, noop: true };
    }

    await client.query(
      `INSERT INTO cube_media_revision (media_id, storage_key, sha256, size, mime, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, row.storage_key, row.sha256, row.size, row.mime, row.uploaded_by, row.uploaded_at],
    );
    await client.query(
      `UPDATE cube_media
          SET storage_key = $2, sha256 = $3, size = $4, mime = $5,
              uploaded_by = $6, uploaded_at = now(), deleted_at = NULL
        WHERE id = $1`,
      [id, key, sha256, buf.length, input.contentType ?? null, input.uploader.id ?? null],
    );
    await logMedia(client, "media-overwrite", input.uploader, { name, sha256, size: buf.length });
    return { id, name, sha256, size: buf.length, created: false, overwrote: true, noop: false };
  });
}

export async function getMedia(pool: Pool, name: string): Promise<MediaRow | null> {
  let canonical: string;
  try {
    canonical = mediaName(name);
  } catch {
    return null;
  }
  const res = await pool.query(
    `SELECT id, name, storage_key, sha256, size, mime, uploaded_by, uploaded_at
       FROM cube_media WHERE name = $1 AND deleted_at IS NULL`,
    [canonical],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name,
    storageKey: r.storage_key,
    sha256: r.sha256,
    size: r.size === null ? null : Number(r.size),
    mime: r.mime,
    uploadedBy: r.uploaded_by === null ? null : Number(r.uploaded_by),
    uploadedAt: r.uploaded_at,
  };
}

export async function listMediaRevisions(pool: Pool, name: string): Promise<MediaRevisionRow[]> {
  let canonical: string;
  try {
    canonical = mediaName(name);
  } catch {
    return [];
  }
  const res = await pool.query(
    `SELECT r.id, r.storage_key, r.sha256, r.size, r.mime, r.uploaded_by, r.uploaded_at, r.note
       FROM cube_media_revision r
       JOIN cube_media m ON m.id = r.media_id
      WHERE m.name = $1
      ORDER BY r.id DESC`,
    [canonical],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    storageKey: r.storage_key,
    sha256: r.sha256,
    size: r.size === null ? null : Number(r.size),
    mime: r.mime,
    uploadedBy: r.uploaded_by === null ? null : Number(r.uploaded_by),
    uploadedAt: r.uploaded_at,
    note: r.note,
  }));
}

export type DeleteMediaInput = {
  name: string;
  actor: MediaActor;
  /** Delete even while cube_link rows still reference the name. */
  force?: boolean;
};

/**
 * Soft delete (deleted_at). The blob stays in storage: keys are
 * content-addressed and may be shared by other names or revisions.
 */
export async function deleteMedia(pool: Pool, input: DeleteMediaInput): Promise<void> {
  const name = mediaName(input.name);
  await withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT id FROM cube_media WHERE name = $1 AND deleted_at IS NULL FOR UPDATE`,
      [name],
    );
    if (row.rows[0] === undefined) {
      throw new CubeMediaError("not_found", 404, `no such media: ${name}`);
    }
    const refs = await client.query(
      `SELECT count(*)::int AS n FROM cube_link WHERE to_ns = 'file' AND to_slug = $1`,
      [name],
    );
    const n = Number(refs.rows[0].n);
    if (n > 0 && input.force !== true) {
      throw new CubeMediaError(
        "referenced",
        409,
        `media "${name}" is referenced by ${n} page${n === 1 ? "" : "s"}; pass force to delete anyway`,
      );
    }
    await client.query(`UPDATE cube_media SET deleted_at = now() WHERE id = $1`, [
      Number(row.rows[0].id),
    ]);
    await logMedia(client, "media-delete", input.actor, {
      name,
      force: input.force === true,
      references: n,
    });
  });
}

export type MediaSearchHit = {
  name: string;
  sha256: string | null;
  size: number | null;
  mime: string | null;
  uploadedAt: Date;
};

export async function searchMedia(pool: Pool, q: string, limit = 20): Promise<MediaSearchHit[]> {
  const res = await pool.query(
    `SELECT name, sha256, size, mime, uploaded_at
       FROM cube_media
      WHERE deleted_at IS NULL
        AND (name % $1 OR name ILIKE '%' || $1 || '%')
      ORDER BY similarity(name, $1) DESC, name ASC
      LIMIT $2`,
    [q, Math.min(limit, 100)],
  );
  return res.rows.map((r) => ({
    name: r.name,
    sha256: r.sha256,
    size: r.size === null ? null : Number(r.size),
    mime: r.mime,
    uploadedAt: r.uploaded_at,
  }));
}
