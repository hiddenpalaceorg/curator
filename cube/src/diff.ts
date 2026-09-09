/** Revision diffs: line-level change list (the editor renders word-level
 * refinement client-side from the same data). */

import { diffLines, type Change } from "diff";
import type { Pool } from "pg";

/** Per-side page context so callers can enforce read authorization. */
export type DiffSidePage = {
  ns: string;
  slug: string;
  visibility: "public" | "moderator";
  protection: Record<string, string>;
  deleted: boolean;
};

export type RevisionDiff = {
  from: { id: number; author: string; createdAt: Date };
  to: { id: number; author: string; createdAt: Date };
  samePage: boolean;
  changes: Change[];
  /** Owning page of each revision; used for `can("read")` gating. */
  pages: { from: DiffSidePage; to: DiffSidePage };
};

export async function diffRevisions(pool: Pool, fromId: number, toId: number): Promise<RevisionDiff | null> {
  const res = await pool.query(
    `SELECT r.id, r.page_id, r.author_name, r.content, r.created_at,
            p.ns, p.slug, p.visibility, p.protection, p.deleted_at
       FROM cube_revision r JOIN cube_page p ON p.id = r.page_id
      WHERE r.id = ANY($1)`,
    [[fromId, toId]],
  );
  // node-pg returns BIGINT as strings; compare numerically.
  const from = res.rows.find((r) => Number(r.id) === fromId);
  const to = res.rows.find((r) => Number(r.id) === toId);
  if (!from || !to) return null;
  const side = (r: (typeof res.rows)[number]): DiffSidePage => ({
    ns: r.ns,
    slug: r.slug,
    visibility: r.visibility,
    protection: r.protection,
    deleted: r.deleted_at !== null,
  });
  return {
    from: { id: Number(from.id), author: from.author_name, createdAt: from.created_at },
    to: { id: Number(to.id), author: to.author_name, createdAt: to.created_at },
    samePage: Number(from.page_id) === Number(to.page_id),
    changes: diffLines(from.content, to.content),
    pages: { from: side(from), to: side(to) },
  };
}
