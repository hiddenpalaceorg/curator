// Magazine metadata queries: magazines/issues/pages, extract ingest (batch,
// idempotent by client_key, moderation-preserving), moderation (amend with
// audit trail, reject/restore), and the public read side (issue pages, game
// coverage, person pages, search).
//
// Ingest ground rule: re-ingest may only replace status='auto' rows —
// amended/rejected extracts are moderator data and survive any re-run (the
// WHERE clauses here enforce it; it is not a convention the caller can miss).

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { slugify } from "../slug";
import { upsertGame } from "../queries";
import type {
  ExtractInput,
  IssueInput,
  MagazineInput,
  PersonKind,
  TagKind,
} from "./kinds";

// ── row types ────────────────────────────────────────────────────────────────

export interface MagazineRow {
  id: number;
  slug: string;
  title: string;
  aliases: string[];
  country: string;
  language: string;
  publisher: string;
  pages_public: boolean;
  notes: string;
}

export interface MagazineListItem extends MagazineRow {
  issue_count: number;
  cover_sha: string | null;
}

export interface IssueRow {
  id: number;
  magazine_id: number;
  slug: string;
  label: string;
  volume: string | null;
  number: string | null;
  whole_number: string | null;
  cover_date: string | null;
  cover_date_precision: "day" | "month" | "year" | null;
  price_raw: string | null;
  publisher_raw: string | null;
  page_count: number | null;
  binding: "ltr" | "rtl";
  pdf_sha256: string | null;
  pdf_size: number | null;
  source_url: string | null;
  supplements: { title: string; present: boolean }[];
  status: string;
  notes: string;
}

export interface IssueWithMagazine extends IssueRow {
  magazine_slug: string;
  magazine_title: string;
  pages_public: boolean;
}

export interface IssueListItem extends IssueRow {
  cover_sha: string | null;
  extract_count: number;
}

export interface PageRow {
  id: number;
  issue_id: number;
  pdf_index: number;
  printed_label: string | null;
  width: number | null;
  height: number | null;
  image_sha256: string | null;
}

export interface RegionView {
  id: number;
  seq: number;
  pdf_index: number;
  printed_label: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  crop_sha256: string | null;
  page_sha256: string | null;
  page_width: number | null;
  page_height: number | null;
}

export interface GameLinkView {
  game_id: number;
  name: string;
  system: string;
  slug: string | null;
  role: string;
  title_printed: string | null;
}

export interface PersonLinkView {
  person_id: number;
  slug: string;
  name: string;
  name_original: string | null;
  kind: string;
  role: string;
}

export interface TagView {
  slug: string;
  kind: string;
  name: string;
}

export interface ExtractView {
  id: number;
  issue_id: number;
  kind: string;
  section: string | null;
  seq: number;
  title: string | null;
  language: string;
  text_original: string;
  text_en: string | null;
  translation: "machine" | "human" | null;
  summary_en: string | null;
  data: Record<string, unknown>;
  is_fictional: boolean;
  sponsored: boolean;
  content_warning: string | null;
  status: string;
  regions: RegionView[];
  games: GameLinkView[];
  people: PersonLinkView[];
  systems: string[];
  tags: TagView[];
}

const EXTRACT_COLS = `e.id::int AS id, e.issue_id::int AS issue_id, e.kind, e.section, e.seq::int AS seq,
  e.title, e.language, e.text_original, e.text_en, e.translation, e.summary_en, e.data,
  e.is_fictional, e.sponsored, e.content_warning, e.status`;

/** The aggregated sub-selects every ExtractView needs. Keyed off alias `e`. */
const extractAgg = (privatePages = false) => `
  COALESCE((SELECT json_agg(json_build_object(
      'id', r.id::int, 'seq', r.seq::int, 'pdf_index', p.pdf_index::int,
      'printed_label', p.printed_label,
      'x', r.x, 'y', r.y, 'w', r.w, 'h', r.h,
      'crop_sha256', r.crop_sha256, 'page_sha256', ${privatePages ? "p.image_sha256" : "CASE WHEN EXISTS (SELECT 1 FROM magazine_issue pi JOIN magazines pm ON pm.id=pi.magazine_id WHERE pi.id=p.issue_id AND pm.pages_public) THEN p.image_sha256 ELSE NULL END"},
      'page_width', p.width::int, 'page_height', p.height::int) ORDER BY r.seq)
    FROM extract_region r JOIN magazine_page p ON p.id=r.page_id
    WHERE r.extract_id=e.id), '[]') AS regions,
  COALESCE((SELECT json_agg(json_build_object(
      'game_id', g.id::int, 'name', g.name, 'system', g.system, 'slug', g.slug,
      'role', eg.role, 'title_printed', eg.title_printed) ORDER BY g.name)
    FROM extract_game eg JOIN games g ON g.id=eg.game_id
    WHERE eg.extract_id=e.id), '[]') AS games,
  COALESCE((SELECT json_agg(json_build_object(
      'person_id', pe.id::int, 'slug', pe.slug, 'name', pe.name,
      'name_original', pe.name_original, 'kind', pe.kind, 'role', ep.role) ORDER BY pe.name)
    FROM extract_person ep JOIN people pe ON pe.id=ep.person_id
    WHERE ep.extract_id=e.id), '[]') AS people,
  COALESCE((SELECT json_agg(es.system ORDER BY es.system)
    FROM extract_system es WHERE es.extract_id=e.id), '[]') AS systems,
  COALESCE((SELECT json_agg(json_build_object('slug', t.slug, 'kind', t.kind, 'name', t.name) ORDER BY t.name)
    FROM extract_tag et JOIN mag_tag t ON t.id=et.tag_id
    WHERE et.extract_id=e.id), '[]') AS tags`;

// ── magazines ────────────────────────────────────────────────────────────────

export async function upsertMagazine(pool: Pool, input: MagazineInput): Promise<MagazineRow> {
  const slug = input.slug ?? slugify(input.title);
  if (!slug) throw new Error("magazine title yields an empty slug; pass slug explicitly");
  const r = await pool.query(
    `INSERT INTO magazines (slug, title, aliases, country, language, publisher, pages_public, notes)
     VALUES ($1, $2, COALESCE($3::text[], '{}'::text[]), COALESCE($4, ''), COALESCE($5, ''), COALESCE($6, ''), COALESCE($7::boolean, TRUE), COALESCE($8, ''))
     ON CONFLICT (slug) DO UPDATE SET
       title        = excluded.title,
       aliases      = COALESCE($3::text[], magazines.aliases),
       country      = COALESCE($4, magazines.country),
       language     = COALESCE($5, magazines.language),
       publisher    = COALESCE($6, magazines.publisher),
       pages_public = COALESCE($7::boolean, magazines.pages_public),
       notes        = COALESCE($8, magazines.notes)
     RETURNING id::int AS id, slug, title, aliases, country, language, publisher, pages_public, notes`,
    [
      slug,
      input.title,
      input.aliases ?? null,
      input.country ?? null,
      input.language ?? null,
      input.publisher ?? null,
      input.pages_public ?? null,
      input.notes ?? null,
    ]
  );
  return r.rows[0] as MagazineRow;
}

export async function getMagazineBySlug(pool: Pool, slug: string): Promise<MagazineRow | null> {
  const r = await pool.query(
    `SELECT id::int AS id, slug, title, aliases, country, language, publisher, pages_public, notes
     FROM magazines WHERE slug=$1`,
    [slug]
  );
  return (r.rows[0] as MagazineRow) ?? null;
}

export async function listMagazines(pool: Pool): Promise<MagazineListItem[]> {
  const r = await pool.query(
    `SELECT m.id::int AS id, m.slug, m.title, m.aliases, m.country, m.language, m.publisher,
            m.pages_public, m.notes,
            (SELECT count(*) FROM magazine_issue i WHERE i.magazine_id=m.id)::int AS issue_count,
            (SELECT p.image_sha256 FROM magazine_issue i
               JOIN magazine_page p ON p.issue_id=i.id AND p.pdf_index=1
             WHERE i.magazine_id=m.id AND m.pages_public AND p.image_sha256 IS NOT NULL
             ORDER BY i.cover_date ASC NULLS LAST, i.slug LIMIT 1) AS cover_sha
     FROM magazines m
     ORDER BY lower(m.title)`
  );
  return r.rows as MagazineListItem[];
}

// ── issues ───────────────────────────────────────────────────────────────────

const ISSUE_COLS = `i.id::int AS id, i.magazine_id::int AS magazine_id, i.slug, i.label, i.volume,
  i.number, i.whole_number, i.cover_date::text AS cover_date, i.cover_date_precision,
  i.price_raw, i.publisher_raw, i.page_count::int AS page_count, i.binding,
  i.pdf_sha256, i.pdf_size::float8 AS pdf_size, i.source_url, i.supplements, i.status, i.notes`;

export async function upsertIssue(pool: Pool, magazineId: number, input: IssueInput): Promise<IssueRow> {
  const r = await pool.query(
    `INSERT INTO magazine_issue (magazine_id, slug, label, volume, number, whole_number,
        cover_date, cover_date_precision, price_raw, publisher_raw, page_count, binding,
        source_url, supplements, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11::int,COALESCE($12,'ltr'),$13,COALESCE($14::jsonb,'[]'::jsonb),COALESCE($15,''))
     ON CONFLICT (magazine_id, slug) DO UPDATE SET
       label        = excluded.label,
       volume       = COALESCE($4,  magazine_issue.volume),
       number       = COALESCE($5,  magazine_issue.number),
       whole_number = COALESCE($6,  magazine_issue.whole_number),
       cover_date   = COALESCE($7::date,  magazine_issue.cover_date),
       cover_date_precision = COALESCE($8, magazine_issue.cover_date_precision),
       price_raw    = COALESCE($9,  magazine_issue.price_raw),
       publisher_raw= COALESCE($10, magazine_issue.publisher_raw),
       page_count   = COALESCE($11::int, magazine_issue.page_count),
       binding      = COALESCE($12, magazine_issue.binding),
       source_url   = COALESCE($13, magazine_issue.source_url),
       supplements  = COALESCE($14::jsonb, magazine_issue.supplements),
       notes        = COALESCE($15, magazine_issue.notes),
       updated_at   = now()
     RETURNING ${ISSUE_COLS.replaceAll("i.", "magazine_issue.")}`,
    [
      magazineId,
      input.slug,
      input.label,
      input.volume ?? null,
      input.number ?? null,
      input.whole_number ?? null,
      input.cover_date ?? null,
      input.cover_date_precision ?? null,
      input.price_raw ?? null,
      input.publisher_raw ?? null,
      input.page_count ?? null,
      input.binding ?? null,
      input.source_url ?? null,
      input.supplements ? JSON.stringify(input.supplements) : null,
      input.notes ?? null,
    ]
  );
  const issue = r.rows[0] as IssueRow;
  if (input.page_labels) {
    for (const [idx, label] of Object.entries(input.page_labels)) {
      await pool.query(
        `INSERT INTO magazine_page (issue_id, pdf_index, printed_label) VALUES ($1,$2,$3)
         ON CONFLICT (issue_id, pdf_index) DO UPDATE SET printed_label=$3`,
        [issue.id, parseInt(idx, 10), label]
      );
    }
  }
  return issue;
}

export async function getIssue(pool: Pool, magSlug: string, issueSlug: string): Promise<IssueWithMagazine | null> {
  const r = await pool.query(
    `SELECT ${ISSUE_COLS}, m.slug AS magazine_slug, m.title AS magazine_title, m.pages_public
     FROM magazine_issue i JOIN magazines m ON m.id=i.magazine_id
     WHERE m.slug=$1 AND i.slug=$2`,
    [magSlug, issueSlug]
  );
  return (r.rows[0] as IssueWithMagazine) ?? null;
}

export async function getIssueById(pool: Pool, id: number): Promise<IssueWithMagazine | null> {
  const r = await pool.query(
    `SELECT ${ISSUE_COLS}, m.slug AS magazine_slug, m.title AS magazine_title, m.pages_public
     FROM magazine_issue i JOIN magazines m ON m.id=i.magazine_id
     WHERE i.id=$1`,
    [id]
  );
  return (r.rows[0] as IssueWithMagazine) ?? null;
}

export async function listIssues(pool: Pool, magazineId: number): Promise<IssueListItem[]> {
  const r = await pool.query(
    `SELECT ${ISSUE_COLS},
            (SELECT p.image_sha256 FROM magazine_page p
             WHERE p.issue_id=i.id AND p.pdf_index=1
               AND EXISTS (SELECT 1 FROM magazines m WHERE m.id=i.magazine_id AND m.pages_public)) AS cover_sha,
            (SELECT count(*) FROM magazine_extract e
             WHERE e.issue_id=i.id AND e.status<>'rejected')::int AS extract_count
     FROM magazine_issue i
     WHERE i.magazine_id=$1
     ORDER BY i.cover_date ASC NULLS LAST, i.slug`,
    [magazineId]
  );
  return r.rows as IssueListItem[];
}

export async function setIssuePdf(pool: Pool, issueId: number, sha256: string, size: number): Promise<void> {
  await pool.query(
    `UPDATE magazine_issue SET pdf_sha256=$2, pdf_size=$3,
        status = CASE WHEN status='new' THEN 'rendering' ELSE status END,
        updated_at=now()
     WHERE id=$1`,
    [issueId, sha256, size]
  );
}

export async function setIssueStatus(pool: Pool, issueId: number, status: string): Promise<void> {
  await pool.query("UPDATE magazine_issue SET status=$2, updated_at=now() WHERE id=$1", [issueId, status]);
}

export async function listIssuePages(pool: Pool, issueId: number): Promise<PageRow[]> {
  const r = await pool.query(
    `SELECT id::int AS id, issue_id::int AS issue_id, pdf_index::int AS pdf_index, printed_label,
            width::int AS width, height::int AS height, image_sha256
     FROM magazine_page WHERE issue_id=$1 ORDER BY pdf_index`,
    [issueId]
  );
  return r.rows as PageRow[];
}

// ── people and tags ──────────────────────────────────────────────────────────

export interface PersonRow {
  id: number;
  slug: string;
  name: string;
  name_original: string | null;
  kind: string;
  aliases: string[];
  notes: string;
}

/** Deterministic slug for names that survive slugify empty (CJK without a
 *  provided romanization): p-<first 8 hex of sha256(name)>. */
export function personSlugFor(name: string, provided?: string): string {
  if (provided) return provided;
  const s = slugify(name);
  if (s) return s;
  return "p-" + createHash("sha256").update(name).digest("hex").slice(0, 8);
}

export async function upsertPerson(
  pool: Pool,
  p: { name: string; slug?: string; name_original?: string; kind?: PersonKind }
): Promise<PersonRow> {
  const slug = personSlugFor(p.name, p.slug);
  const r = await pool.query(
    `INSERT INTO people (slug, name, name_original, kind)
     VALUES ($1, $2, $3, COALESCE($4, 'person'))
     ON CONFLICT (slug) DO UPDATE SET
       name_original = COALESCE(people.name_original, excluded.name_original)
     RETURNING id::int AS id, slug, name, name_original, kind, aliases, notes`,
    [slug, p.name, p.name_original ?? null, p.kind ?? null]
  );
  return r.rows[0] as PersonRow;
}

export async function getPersonBySlug(pool: Pool, slug: string): Promise<PersonRow | null> {
  const r = await pool.query(
    "SELECT id::int AS id, slug, name, name_original, kind, aliases, notes FROM people WHERE slug=$1",
    [slug]
  );
  return (r.rows[0] as PersonRow) ?? null;
}

export async function upsertTag(pool: Pool, kind: TagKind, name: string): Promise<{ id: number; slug: string }> {
  const base = slugify(name) || createHash("sha256").update(name).digest("hex").slice(0, 8);
  const slug = `${kind}-${base}`;
  const r = await pool.query(
    `INSERT INTO mag_tag (slug, kind, name) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name=excluded.name
     RETURNING id::int AS id, slug`,
    [slug, kind, name]
  );
  return r.rows[0] as { id: number; slug: string };
}

// ── extract ingest ───────────────────────────────────────────────────────────

export type IngestResult =
  | { client_key: string; id: number; action: "inserted" | "updated" }
  | { client_key: string; skipped: "moderated" | "error"; error?: string };

/** Ingest one validated extract. Entities are upserted outside the
 *  transaction (idempotent either way); the extract row, its regions, and
 *  its links commit atomically. An existing amended/rejected row under the
 *  same client_key is left untouched. */
export async function ingestExtract(pool: Pool, issueId: number, e: ExtractInput): Promise<IngestResult> {
  try {
    const gameIds: { id: number; role: string; title_printed: string | null }[] = [];
    for (const g of e.games ?? []) {
      const row = await upsertGame(pool, g.name, g.system ?? "");
      if (!gameIds.some((x) => x.id === row.id)) {
        gameIds.push({ id: row.id, role: g.role ?? "subject", title_printed: g.title_printed ?? null });
      }
    }
    const personIds: { id: number; role: string }[] = [];
    for (const p of e.people ?? []) {
      const row = await upsertPerson(pool, p);
      personIds.push({ id: row.id, role: p.role ?? "mentioned" });
    }
    const tagIds: number[] = [];
    for (const t of e.tags ?? []) {
      const row = await upsertTag(pool, t.kind ?? "topic", t.name);
      if (!tagIds.includes(row.id)) tagIds.push(row.id);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await ingestExtractTx(client, issueId, e, gameIds, personIds, tagIds);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    return {
      client_key: e.client_key,
      skipped: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ingestExtractTx(
  client: PoolClient,
  issueId: number,
  e: ExtractInput,
  gameIds: { id: number; role: string; title_printed: string | null }[],
  personIds: { id: number; role: string }[],
  tagIds: number[]
): Promise<IngestResult> {
  const existing = await client.query(
    "SELECT id::int AS id, status FROM magazine_extract WHERE issue_id=$1 AND client_key=$2 FOR UPDATE",
    [issueId, e.client_key]
  );
  const prior = existing.rows[0] as { id: number; status: string } | undefined;
  if (prior && prior.status !== "auto") {
    return { client_key: e.client_key, skipped: "moderated" };
  }

  // Page rows for every referenced pdf index (render may not have run yet).
  const pageIds = new Map<number, number>();
  for (const idx of new Set(e.regions.map((r) => r.pdf_index))) {
    const p = await client.query(
      `INSERT INTO magazine_page (issue_id, pdf_index) VALUES ($1,$2)
       ON CONFLICT (issue_id, pdf_index) DO UPDATE SET pdf_index=excluded.pdf_index
       RETURNING id::int AS id`,
      [issueId, idx]
    );
    pageIds.set(idx, (p.rows[0] as { id: number }).id);
  }

  const cols = [
    e.kind,
    e.section ?? null,
    e.seq ?? 0,
    e.title ?? null,
    e.language,
    e.text_original,
    e.text_en ?? null,
    e.translation ?? null,
    e.summary_en ?? null,
    JSON.stringify(e.data ?? {}),
    e.is_fictional ?? false,
    e.sponsored ?? false,
    e.content_warning ?? null,
  ];

  let id: number;
  let action: "inserted" | "updated";
  if (prior) {
    const u = await client.query(
      `UPDATE magazine_extract SET kind=$3, section=$4, seq=$5, title=$6, language=$7,
          text_original=$8, text_en=$9, translation=$10, summary_en=$11, data=$12,
          is_fictional=$13, sponsored=$14, content_warning=$15, updated_at=now()
       WHERE id=$1 AND status='auto' AND issue_id=$2
       RETURNING id::int AS id`,
      [prior.id, issueId, ...cols]
    );
    if (!u.rows[0]) return { client_key: e.client_key, skipped: "moderated" };
    id = prior.id;
    action = "updated";
    await client.query("DELETE FROM extract_region WHERE extract_id=$1", [id]);
    await client.query("DELETE FROM extract_game WHERE extract_id=$1", [id]);
    await client.query("DELETE FROM extract_person WHERE extract_id=$1", [id]);
    await client.query("DELETE FROM extract_system WHERE extract_id=$1", [id]);
    await client.query("DELETE FROM extract_tag WHERE extract_id=$1", [id]);
  } else {
    const ins = await client.query(
      `INSERT INTO magazine_extract (issue_id, client_key, kind, section, seq, title, language,
          text_original, text_en, translation, summary_en, data, is_fictional, sponsored, content_warning)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id::int AS id`,
      [issueId, e.client_key, ...cols]
    );
    id = (ins.rows[0] as { id: number }).id;
    action = "inserted";
  }

  for (const [i, r] of e.regions.entries()) {
    await client.query(
      `INSERT INTO extract_region (extract_id, page_id, seq, x, y, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, pageIds.get(r.pdf_index), i, r.x, r.y, r.w, r.h]
    );
  }
  for (const g of gameIds) {
    await client.query(
      `INSERT INTO extract_game (extract_id, game_id, role, title_printed) VALUES ($1,$2,$3,$4)
       ON CONFLICT (extract_id, game_id) DO NOTHING`,
      [id, g.id, g.role, g.title_printed]
    );
  }
  for (const p of personIds) {
    await client.query(
      `INSERT INTO extract_person (extract_id, person_id, role) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [id, p.id, p.role]
    );
  }
  for (const s of e.systems ?? []) {
    await client.query(
      `INSERT INTO extract_system (extract_id, system) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, s]
    );
  }
  for (const t of tagIds) {
    await client.query(
      `INSERT INTO extract_tag (extract_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [id, t]
    );
  }
  return { client_key: e.client_key, id, action };
}

/** Ingest reset that provably cannot touch moderated rows. */
export async function deleteAutoExtracts(pool: Pool, issueId: number): Promise<number> {
  const r = await pool.query("DELETE FROM magazine_extract WHERE issue_id=$1 AND status='auto'", [issueId]);
  return r.rowCount ?? 0;
}

// ── extract reads ────────────────────────────────────────────────────────────

function toView(row: Record<string, unknown>): ExtractView {
  return row as unknown as ExtractView;
}

export async function getExtract(pool: Pool, id: number, privatePages = false): Promise<ExtractView | null> {
  const r = await pool.query(
    `SELECT ${EXTRACT_COLS}, ${extractAgg(privatePages)} FROM magazine_extract e WHERE e.id=$1`,
    [id]
  );
  return r.rows[0] ? toView(r.rows[0]) : null;
}

export async function getIssueExtracts(
  pool: Pool,
  issueId: number,
  includeRejected = false,
  privatePages = false
): Promise<ExtractView[]> {
  const r = await pool.query(
    `SELECT ${EXTRACT_COLS}, ${extractAgg(privatePages)}
     FROM magazine_extract e
     WHERE e.issue_id=$1 AND ${includeRejected ? "TRUE" : "e.status <> 'rejected'"}
     ORDER BY e.seq, e.id`,
    [issueId]
  );
  return r.rows.map(toView);
}

// ── moderation ───────────────────────────────────────────────────────────────

/** Fields a moderator may patch. Regions are patched separately (they carry
 *  derived crops). */
export const AMENDABLE_FIELDS = [
  "kind",
  "section",
  "seq",
  "title",
  "language",
  "text_original",
  "text_en",
  "translation",
  "summary_en",
  "data",
  "is_fictional",
  "sponsored",
  "content_warning",
] as const;
export type AmendableField = (typeof AMENDABLE_FIELDS)[number];

export interface AmendPatch {
  fields?: Partial<Record<AmendableField, unknown>>;
  /** Full region replacement: resets crops (they regenerate). */
  regions?: { pdf_index: number; x: number; y: number; w: number; h: number }[];
  note?: string;
}

export async function amendExtract(
  pool: Pool,
  id: number,
  patch: AmendPatch,
  editor: string
): Promise<ExtractView | null> {
  const current = await getExtract(pool, id, true);
  if (!current) return null;

  const change: Record<string, [unknown, unknown]> = {};
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const f of AMENDABLE_FIELDS) {
    if (!patch.fields || !(f in patch.fields)) continue;
    const next = patch.fields[f] ?? null;
    const prev = (current as unknown as Record<string, unknown>)[f] ?? null;
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    change[f] = [prev, next];
    params.push(f === "data" ? JSON.stringify(next ?? {}) : next);
    sets.push(`${f}=$${params.length}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (sets.length) {
      await client.query(
        `UPDATE magazine_extract SET ${sets.join(", ")},
            status = CASE WHEN status='rejected' THEN 'rejected' ELSE 'amended' END,
            updated_at=now()
         WHERE id=$1`,
        params
      );
    } else if (patch.regions) {
      await client.query(
        `UPDATE magazine_extract SET
            status = CASE WHEN status='rejected' THEN 'rejected' ELSE 'amended' END,
            updated_at=now()
         WHERE id=$1`,
        [id]
      );
    }
    if (patch.regions) {
      change["regions"] = [
        current.regions.map((r) => ({ pdf_index: r.pdf_index, x: r.x, y: r.y, w: r.w, h: r.h })),
        patch.regions,
      ];
      await client.query("DELETE FROM extract_region WHERE extract_id=$1", [id]);
      for (const [i, r] of patch.regions.entries()) {
        const p = await client.query(
          `INSERT INTO magazine_page (issue_id, pdf_index) VALUES ($1,$2)
           ON CONFLICT (issue_id, pdf_index) DO UPDATE SET pdf_index=excluded.pdf_index
           RETURNING id::int AS id`,
          [current.issue_id, r.pdf_index]
        );
        await client.query(
          "INSERT INTO extract_region (extract_id, page_id, seq, x, y, w, h) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [id, (p.rows[0] as { id: number }).id, i, r.x, r.y, r.w, r.h]
        );
      }
    }
    if (Object.keys(change).length) {
      await client.query(
        "INSERT INTO extract_revision (extract_id, editor, change, note) VALUES ($1,$2,$3,$4)",
        [id, editor, JSON.stringify(change), patch.note ?? null]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getExtract(pool, id, true);
}

export async function setExtractRejected(
  pool: Pool,
  id: number,
  rejected: boolean,
  editor: string,
  note?: string
): Promise<ExtractView | null> {
  const current = await getExtract(pool, id, true);
  if (!current) return null;
  const next = rejected ? "rejected" : "amended";
  if (current.status === next) return current;
  await pool.query("UPDATE magazine_extract SET status=$2, updated_at=now() WHERE id=$1", [id, next]);
  await pool.query("INSERT INTO extract_revision (extract_id, editor, change, note) VALUES ($1,$2,$3,$4)", [
    id,
    editor,
    JSON.stringify({ status: [current.status, next] }),
    note ?? null,
  ]);
  return getExtract(pool, id, true);
}

export interface RevisionRow {
  id: number;
  extract_id: number;
  editor: string;
  change: Record<string, [unknown, unknown]>;
  note: string | null;
  created_at: string;
}

export async function listExtractRevisions(pool: Pool, extractId: number): Promise<RevisionRow[]> {
  const r = await pool.query(
    `SELECT id::int AS id, extract_id::int AS extract_id, editor, change, note, created_at::text AS created_at
     FROM extract_revision WHERE extract_id=$1 ORDER BY id DESC`,
    [extractId]
  );
  return r.rows as RevisionRow[];
}

// ── cross-entity reads (game pages, person pages, search) ────────────────────

export interface CoverageItem {
  id: number;
  kind: string;
  section: string | null;
  title: string | null;
  language: string;
  summary_en: string | null;
  data: Record<string, unknown>;
  status: string;
  role: string;
  title_printed: string | null;
  issue_id: number;
  issue_slug: string;
  issue_label: string;
  cover_date: string | null;
  magazine_slug: string;
  magazine_title: string;
  crop_sha256: string | null;
}

const COVERAGE_COLS = `e.id::int AS id, e.kind, e.section, e.title, e.language, e.summary_en, e.data, e.status,
  i.id::int AS issue_id, i.slug AS issue_slug, i.label AS issue_label, i.cover_date::text AS cover_date,
  m.slug AS magazine_slug, m.title AS magazine_title,
  (SELECT r.crop_sha256 FROM extract_region r WHERE r.extract_id=e.id AND r.crop_sha256 IS NOT NULL
   ORDER BY r.seq LIMIT 1) AS crop_sha256`;

export async function getGameCoverage(pool: Pool, gameId: number): Promise<CoverageItem[]> {
  const r = await pool.query(
    `SELECT ${COVERAGE_COLS}, eg.role, eg.title_printed
     FROM extract_game eg
     JOIN magazine_extract e ON e.id=eg.extract_id AND e.status <> 'rejected'
     JOIN magazine_issue i ON i.id=e.issue_id
     JOIN magazines m ON m.id=i.magazine_id
     WHERE eg.game_id=$1
     ORDER BY i.cover_date ASC NULLS LAST, e.seq`,
    [gameId]
  );
  return r.rows as CoverageItem[];
}

export async function getPersonCoverage(pool: Pool, personId: number): Promise<CoverageItem[]> {
  const r = await pool.query(
    `SELECT ${COVERAGE_COLS}, ep.role, NULL::text AS title_printed
     FROM extract_person ep
     JOIN magazine_extract e ON e.id=ep.extract_id AND e.status <> 'rejected'
     JOIN magazine_issue i ON i.id=e.issue_id
     JOIN magazines m ON m.id=i.magazine_id
     WHERE ep.person_id=$1
     ORDER BY i.cover_date ASC NULLS LAST, e.seq`,
    [personId]
  );
  return r.rows as CoverageItem[];
}

export interface TagRow {
  slug: string;
  kind: string;
  name: string;
  extract_count: number;
}

export async function listTags(pool: Pool): Promise<TagRow[]> {
  const r = await pool.query(
    `SELECT t.slug, t.kind, t.name, COUNT(e.id)::int AS extract_count
     FROM mag_tag t
     LEFT JOIN extract_tag et ON et.tag_id=t.id
     LEFT JOIN magazine_extract e ON e.id=et.extract_id AND e.status <> 'rejected'
     GROUP BY t.id
     ORDER BY extract_count DESC, t.name ASC`
  );
  return r.rows as TagRow[];
}

export async function getTagBySlug(pool: Pool, slug: string): Promise<TagRow | null> {
  const r = await pool.query(
    `SELECT t.slug, t.kind, t.name, COUNT(e.id)::int AS extract_count
     FROM mag_tag t
     LEFT JOIN extract_tag et ON et.tag_id=t.id
     LEFT JOIN magazine_extract e ON e.id=et.extract_id AND e.status <> 'rejected'
     WHERE t.slug=$1
     GROUP BY t.id`,
    [slug]
  );
  return (r.rows[0] as TagRow | undefined) ?? null;
}

export async function getTagCoverage(pool: Pool, tagSlug: string): Promise<CoverageItem[]> {
  const r = await pool.query(
    `SELECT ${COVERAGE_COLS}, 'subject' AS role, NULL::text AS title_printed
     FROM extract_tag et
     JOIN mag_tag t ON t.id=et.tag_id
     JOIN magazine_extract e ON e.id=et.extract_id AND e.status <> 'rejected'
     JOIN magazine_issue i ON i.id=e.issue_id
     JOIN magazines m ON m.id=i.magazine_id
     WHERE t.slug=$1
     ORDER BY i.cover_date ASC NULLS LAST, e.seq`,
    [tagSlug]
  );
  return r.rows as CoverageItem[];
}

/** Filter options actually present in the index, for the search UI. */
export interface MagSearchFacets {
  systems: string[];
  languages: string[];
}

export async function listSearchFacets(pool: Pool): Promise<MagSearchFacets> {
  const [sys, langs] = await Promise.all([
    pool.query(
      `SELECT DISTINCT es.system FROM extract_system es
       JOIN magazine_extract e ON e.id=es.extract_id AND e.status <> 'rejected'
       ORDER BY es.system`
    ),
    pool.query(
      `SELECT DISTINCT language FROM magazine_extract WHERE status <> 'rejected' ORDER BY language`
    ),
  ]);
  return {
    systems: (sys.rows as { system: string }[]).map((r) => r.system),
    languages: (langs.rows as { language: string }[]).map((r) => r.language),
  };
}

export interface MagSearchFilters {
  magazine?: string;
  kind?: string;
  system?: string;
  language?: string;
  person?: string;
  game?: string;
  from?: string; // YYYY-MM-DD on cover_date
  to?: string;
  limit?: number;
}

export interface MagSearchHit extends CoverageItem {
  snippet: string | null;
  rank: number;
}

/** Extract search. A quoted query ("...") is an exact substring match via
 *  trigram (also the only useful path for CJK); anything else is FTS over the
 *  original ('simple') and English sides, ranked. */
export async function searchExtracts(pool: Pool, q: string, f: MagSearchFilters = {}): Promise<MagSearchHit[]> {
  const term = q.trim();
  if (!term) return [];
  const exact = /^".+"$/.test(term);
  const needle = exact ? term.slice(1, -1) : term;

  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  const wheres: string[] = ["e.status <> 'rejected'"];
  if (f.magazine) wheres.push(`m.slug = ${p(f.magazine)}`);
  if (f.kind) wheres.push(`e.kind = ${p(f.kind)}`);
  if (f.language) wheres.push(`e.language = ${p(f.language)}`);
  if (f.system) {
    wheres.push(`EXISTS (SELECT 1 FROM extract_system es WHERE es.extract_id=e.id AND es.system = ${p(f.system)})`);
  }
  if (f.person) {
    wheres.push(
      `EXISTS (SELECT 1 FROM extract_person ep JOIN people pe ON pe.id=ep.person_id
        WHERE ep.extract_id=e.id AND pe.slug = ${p(f.person)})`
    );
  }
  if (f.game) {
    wheres.push(
      `EXISTS (SELECT 1 FROM extract_game eg JOIN games g ON g.id=eg.game_id
        WHERE eg.extract_id=e.id AND g.slug = ${p(f.game)})`
    );
  }
  if (f.from) wheres.push(`i.cover_date >= ${p(f.from)}`);
  if (f.to) wheres.push(`i.cover_date <= ${p(f.to)}`);

  const limit = Math.min(100, Math.max(1, f.limit ?? 30));

  if (exact) {
    const like = "%" + needle.replace(/([\\%_])/g, "\\$1") + "%";
    const lp = p(like);
    wheres.push(`(e.text_original ILIKE ${lp} OR e.text_en ILIKE ${lp} OR e.title ILIKE ${lp})`);
    const r = await pool.query(
      `SELECT ${COVERAGE_COLS}, 'subject' AS role, NULL::text AS title_printed,
              e.text_original AS _orig, e.text_en AS _en,
              1.0::float8 AS rank
       FROM magazine_extract e
       JOIN magazine_issue i ON i.id=e.issue_id
       JOIN magazines m ON m.id=i.magazine_id
       WHERE ${wheres.join(" AND ")}
       ORDER BY i.cover_date ASC NULLS LAST, e.seq
       LIMIT ${p(limit)}`,
      params
    );
    return (r.rows as (MagSearchHit & { _orig: string; _en: string | null })[]).map(
      ({ _orig, _en, ...h }) => ({
        ...h,
        snippet: snippetFrom(_orig, needle) ?? snippetFrom(_en ?? "", needle) ?? snippetFrom(h.title ?? "", needle),
      })
    );
  }

  const tq = p(needle);
  wheres.push(
    `(to_tsvector('simple', coalesce(e.title,'') || ' ' || e.text_original) @@ plainto_tsquery('simple', ${tq})
      OR to_tsvector('english', coalesce(e.title,'') || ' ' || coalesce(e.text_en,'') || ' ' || coalesce(e.summary_en,'')) @@ plainto_tsquery('english', ${tq})
      OR e.title ILIKE ${p("%" + needle.replace(/([\\%_])/g, "\\$1") + "%")})`
  );
  const r = await pool.query(
    `SELECT ${COVERAGE_COLS}, 'subject' AS role, NULL::text AS title_printed,
            ts_headline('simple', left(coalesce(e.text_en, e.text_original), 3000),
                        plainto_tsquery('simple', ${tq}),
                        'MaxFragments=1, MaxWords=25, MinWords=8, StartSel=[[, StopSel=]]') AS snippet,
            (ts_rank(to_tsvector('simple', coalesce(e.title,'') || ' ' || e.text_original), plainto_tsquery('simple', ${tq}))
             + ts_rank(to_tsvector('english', coalesce(e.title,'') || ' ' || coalesce(e.text_en,'') || ' ' || coalesce(e.summary_en,'')), plainto_tsquery('english', ${tq})))::float8 AS rank
     FROM magazine_extract e
     JOIN magazine_issue i ON i.id=e.issue_id
     JOIN magazines m ON m.id=i.magazine_id
     WHERE ${wheres.join(" AND ")}
     ORDER BY rank DESC, i.cover_date ASC NULLS LAST
     LIMIT ${p(limit)}`,
    params
  );
  return r.rows as MagSearchHit[];
}

/** App-side snippet for exact mode: ±60 chars around the first hit, using the
 *  same [[...]] highlight convention ts_headline is configured with above. */
function snippetFrom(text: string, needle: string): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - 60);
  const end = Math.min(text.length, i + needle.length + 60);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, i) +
    "[[" +
    text.slice(i, i + needle.length) +
    "]]" +
    text.slice(i + needle.length, end) +
    (end < text.length ? "…" : "")
  );
}
