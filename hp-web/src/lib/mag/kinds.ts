// Magazine extract taxonomy and ingest-payload validation.
//
// The taxonomy is deliberately app-side (no DB CHECK): the corpus keeps
// producing new content shapes (survey: 143 issues, ~15 languages), and adding
// a kind must stay a one-array edit. Validation here is structural — kinds,
// regions, links, sizes — while `data` stays a schemaless JSONB payload with
// only targeted shape checks, because score grids, chart entries, and ad
// product lists differ per magazine and evolve per issue.
//
// Client-safe: no server-only imports (the moderation UI validates edits too).

/** One extract = one addressable unit: a capsule review, a tip, a letter, an
 *  ad, a chart. Derived from the phase-1 survey of EGM 022 (US), Beep!
 *  MegaDrive 1991-08 (JP), and Supergame 01 (BR). */
export const EXTRACT_KINDS = [
  "cover", // front/back cover compositions
  "toc",
  "masthead", // staff/colophon blocks
  "editorial",
  "letters", // one reader letter + reply (or a letters solicitation)
  "news",
  "rumor", // gossip columns (Quartermann)
  "preview", // upcoming-game coverage, fact-file features
  "review", // scored or qualitative; data.subject_type: game|hardware|accessory|music
  "feature", // long-form: company profiles, hardware launches, event specials
  "interview",
  "strategy", // walkthroughs, maps, move catalogs
  "tips", // one trick/code/password with credit
  "chart", // sales/reader/arcade/port-request rankings
  "high_scores",
  "calendar", // release calendars, availability lists
  "contest", // house contests, giveaways/presents; data.subkind
  "poster", // pin-ups/posters, text-free art pages
  "comic",
  "fiction", // novelizations, serials (may embed real directory data)
  "column", // recurring branded opinion/essay
  "ad", // data.ad_type: product|retail_mailorder|classified|house|consumer|school|service
  "ad_index", // advertiser index tables
  "next_issue",
  "form", // standalone coupons/entry forms/questionnaires
  "other", // tv listings, vox pop, lifestyle, quizzes
] as const;

export type ExtractKind = (typeof EXTRACT_KINDS)[number];

export function isExtractKind(v: unknown): v is ExtractKind {
  return typeof v === "string" && (EXTRACT_KINDS as readonly string[]).includes(v);
}

export const PERSON_ROLES = [
  "interviewee",
  "interviewer",
  "author",
  "artist",
  "subject",
  "mentioned",
  "reviewer",
] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const GAME_ROLES = ["subject", "mentioned", "listed"] as const;
export type GameRole = (typeof GAME_ROLES)[number];

export const PERSON_KINDS = ["person", "persona", "organization"] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export const TAG_KINDS = ["company", "event", "hardware", "series", "topic"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const EXTRACT_STATUSES = ["auto", "amended", "rejected"] as const;
export type ExtractStatus = (typeof EXTRACT_STATUSES)[number];

// Size caps. text_original is verbatim-everything by policy (price lists
// included), so it gets real room; data holds structured entry arrays for the
// same pages.
export const MAX_TEXT_LEN = 200_000;
export const MAX_SUMMARY_LEN = 2_000;
export const MAX_TITLE_LEN = 500;
export const MAX_SECTION_LEN = 200;
export const MAX_DATA_BYTES = 200_000;
export const MAX_REGIONS = 12;
export const MAX_GAME_LINKS = 300; // reader-race charts list 108+ games
export const MAX_PERSON_LINKS = 50;
export const MAX_SYSTEM_LINKS = 20;
export const MAX_TAG_LINKS = 50;
export const MAX_BATCH = 50;
// Includes both texts, structured data, all bounded links, and worst-case
// JSON Unicode escaping. Unknown/unbounded extra fields need not be accepted.
export const MAX_EXTRACT_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_CLIENT_KEY_LEN = 200;

export interface RegionInput {
  pdf_index: number;
  /** Normalized 0-1 over the rendered page, origin top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GameLinkInput {
  name: string;
  system?: string;
  role?: GameRole;
  title_printed?: string;
}

export interface PersonLinkInput {
  name: string;
  slug?: string;
  name_original?: string;
  kind?: PersonKind;
  role?: PersonRole;
}

export interface TagLinkInput {
  name: string;
  kind?: TagKind;
}

export interface ExtractInput {
  client_key: string;
  kind: ExtractKind;
  section?: string;
  seq?: number;
  title?: string;
  language: string;
  text_original: string;
  text_en?: string;
  translation?: "machine" | "human";
  summary_en?: string;
  data?: Record<string, unknown>;
  is_fictional?: boolean;
  sponsored?: boolean;
  content_warning?: string;
  regions: RegionInput[];
  games?: GameLinkInput[];
  people?: PersonLinkInput[];
  systems?: string[];
  tags?: TagLinkInput[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(v: unknown, max: number, label: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${label} must be a string`);
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > max) throw new Error(`${label} too long (${t.length} > ${max})`);
  return t;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** bcp47-ish: "en", "ja", "pt-br". Lowercased; no registry validation. */
export function normalizeLang(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(t) ? t : null;
}

function validateRegion(v: unknown, i: number): RegionInput {
  if (!isRecord(v)) throw new Error(`regions[${i}] must be an object`);
  const idx = v.pdf_index;
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 1 || idx > 10_000) {
    throw new Error(`regions[${i}].pdf_index must be a positive page number`);
  }
  for (const k of ["x", "y", "w", "h"] as const) {
    if (typeof v[k] !== "number" || !Number.isFinite(v[k] as number)) {
      throw new Error(`regions[${i}].${k} must be a finite number`);
    }
  }
  // Clamp instead of reject: vision bboxes run a hair out of range routinely,
  // and a 1.02 that meant 1.0 should not fail a 400-page ingest.
  const x = clamp01(v.x as number);
  const y = clamp01(v.y as number);
  const w = Math.min(clamp01(v.w as number), 1 - x);
  const h = Math.min(clamp01(v.h as number), 1 - y);
  if (w < 0.005 || h < 0.005) throw new Error(`regions[${i}] is degenerate after clamping`);
  return { pdf_index: idx, x, y, w, h };
}

/** Validate one extract of an ingest batch. Returns a normalized copy
 *  (trimmed strings, clamped regions) or the first structural error. */
export function validateExtractInput(v: unknown): Validated<ExtractInput> {
  try {
    if (!isRecord(v)) throw new Error("extract must be an object");

    const client_key = optString(v.client_key, MAX_CLIENT_KEY_LEN, "client_key");
    if (!client_key) throw new Error("client_key is required");
    if (!isExtractKind(v.kind)) throw new Error(`unknown kind: ${String(v.kind)}`);

    const language = normalizeLang(v.language);
    if (!language) throw new Error("language must be a bcp47 code like en, ja, pt-br");

    if (typeof v.text_original !== "string") throw new Error("text_original must be a string");
    if (v.text_original.length > MAX_TEXT_LEN) {
      throw new Error(`text_original too long (${v.text_original.length} > ${MAX_TEXT_LEN})`);
    }
    const text_en = v.text_en === undefined || v.text_en === null ? undefined : v.text_en;
    if (text_en !== undefined && typeof text_en !== "string") throw new Error("text_en must be a string");
    if (typeof text_en === "string" && text_en.length > MAX_TEXT_LEN) {
      throw new Error(`text_en too long (${text_en.length} > ${MAX_TEXT_LEN})`);
    }
    let translation: "machine" | "human" | undefined;
    if (v.translation !== undefined && v.translation !== null) {
      if (v.translation !== "machine" && v.translation !== "human") {
        throw new Error("translation must be machine or human");
      }
      translation = v.translation;
    }
    if (text_en && !translation) translation = "machine";

    let data: Record<string, unknown> | undefined;
    if (v.data !== undefined && v.data !== null) {
      if (!isRecord(v.data)) throw new Error("data must be an object");
      const bytes = JSON.stringify(v.data).length;
      if (bytes > MAX_DATA_BYTES) throw new Error(`data too large (${bytes} > ${MAX_DATA_BYTES})`);
      // Targeted shape checks on the conventional array fields, so a skill
      // bug (scores as a map, entries as strings) fails loudly at ingest.
      for (const k of ["scores", "axes", "entries", "products", "prizes"] as const) {
        const arr = v.data[k];
        if (arr === undefined) continue;
        if (!Array.isArray(arr)) throw new Error(`data.${k} must be an array`);
        if (arr.some((e) => !isRecord(e))) throw new Error(`data.${k} entries must be objects`);
      }
      data = v.data;
    }

    if (!Array.isArray(v.regions) || v.regions.length === 0) {
      throw new Error("regions must be a non-empty array");
    }
    if (v.regions.length > MAX_REGIONS) throw new Error(`too many regions (> ${MAX_REGIONS})`);
    const regions = v.regions.map(validateRegion);

    const games: GameLinkInput[] = [];
    if (v.games !== undefined && v.games !== null) {
      if (!Array.isArray(v.games)) throw new Error("games must be an array");
      if (v.games.length > MAX_GAME_LINKS) throw new Error(`too many game links (> ${MAX_GAME_LINKS})`);
      for (const [i, g] of v.games.entries()) {
        if (!isRecord(g)) throw new Error(`games[${i}] must be an object`);
        const name = optString(g.name, 300, `games[${i}].name`);
        if (!name) throw new Error(`games[${i}].name is required`);
        const role = g.role ?? "subject";
        if (!(GAME_ROLES as readonly string[]).includes(role as string)) {
          throw new Error(`games[${i}].role must be one of ${GAME_ROLES.join("|")}`);
        }
        games.push({
          name,
          system: optString(g.system, 100, `games[${i}].system`) ?? "",
          role: role as GameRole,
          title_printed: optString(g.title_printed, 300, `games[${i}].title_printed`),
        });
      }
    }

    const people: PersonLinkInput[] = [];
    if (v.people !== undefined && v.people !== null) {
      if (!Array.isArray(v.people)) throw new Error("people must be an array");
      if (v.people.length > MAX_PERSON_LINKS) throw new Error(`too many person links (> ${MAX_PERSON_LINKS})`);
      for (const [i, p] of v.people.entries()) {
        if (!isRecord(p)) throw new Error(`people[${i}] must be an object`);
        const name = optString(p.name, 200, `people[${i}].name`);
        if (!name) throw new Error(`people[${i}].name is required`);
        const kind = p.kind ?? "person";
        if (!(PERSON_KINDS as readonly string[]).includes(kind as string)) {
          throw new Error(`people[${i}].kind must be one of ${PERSON_KINDS.join("|")}`);
        }
        const role = p.role ?? "mentioned";
        if (!(PERSON_ROLES as readonly string[]).includes(role as string)) {
          throw new Error(`people[${i}].role must be one of ${PERSON_ROLES.join("|")}`);
        }
        people.push({
          name,
          slug: optString(p.slug, 200, `people[${i}].slug`),
          name_original: optString(p.name_original, 200, `people[${i}].name_original`),
          kind: kind as PersonKind,
          role: role as PersonRole,
        });
      }
    }

    let systems: string[] = [];
    if (v.systems !== undefined && v.systems !== null) {
      if (!Array.isArray(v.systems)) throw new Error("systems must be an array");
      if (v.systems.length > MAX_SYSTEM_LINKS) throw new Error(`too many systems (> ${MAX_SYSTEM_LINKS})`);
      systems = v.systems.map((s, i) => {
        const t = optString(s, 100, `systems[${i}]`);
        if (!t) throw new Error(`systems[${i}] is empty`);
        return t;
      });
    }

    const tags: TagLinkInput[] = [];
    if (v.tags !== undefined && v.tags !== null) {
      if (!Array.isArray(v.tags)) throw new Error("tags must be an array");
      if (v.tags.length > MAX_TAG_LINKS) throw new Error(`too many tags (> ${MAX_TAG_LINKS})`);
      for (const [i, t] of v.tags.entries()) {
        if (!isRecord(t)) throw new Error(`tags[${i}] must be an object`);
        const name = optString(t.name, 200, `tags[${i}].name`);
        if (!name) throw new Error(`tags[${i}].name is required`);
        const kind = t.kind ?? "topic";
        if (!(TAG_KINDS as readonly string[]).includes(kind as string)) {
          throw new Error(`tags[${i}].kind must be one of ${TAG_KINDS.join("|")}`);
        }
        tags.push({ name, kind: kind as TagKind });
      }
    }

    let seq: number | undefined;
    if (v.seq !== undefined && v.seq !== null) {
      if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0 || v.seq > 1_000_000) {
        throw new Error("seq must be a non-negative integer");
      }
      seq = v.seq;
    }

    return {
      ok: true,
      value: {
        client_key,
        kind: v.kind,
        section: optString(v.section, MAX_SECTION_LEN, "section"),
        seq,
        title: optString(v.title, MAX_TITLE_LEN, "title"),
        language,
        text_original: v.text_original,
        text_en,
        translation,
        summary_en: optString(v.summary_en, MAX_SUMMARY_LEN, "summary_en"),
        data,
        is_fictional: v.is_fictional === true,
        sponsored: v.sponsored === true,
        content_warning: optString(v.content_warning, 500, "content_warning"),
        regions,
        games,
        people,
        systems,
        tags,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface IssueInput {
  magazine: string; // magazine slug
  slug: string;
  label: string;
  volume?: string;
  number?: string;
  whole_number?: string;
  cover_date?: string; // ISO date
  cover_date_precision?: "day" | "month" | "year";
  price_raw?: string;
  publisher_raw?: string;
  page_count?: number;
  binding?: "ltr" | "rtl";
  source_url?: string;
  supplements?: { title: string; present: boolean }[];
  notes?: string;
  /** Printed page labels by pdf index: {"4": "4", "56": "supp:6"}. */
  page_labels?: Record<string, string>;
}

/** Issue tokens keep URLs tame: "022", "1991-08", "01", "ace-50-supplement". */
export function isIssueSlug(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
}

export function validateIssueInput(v: unknown): Validated<IssueInput> {
  try {
    if (!isRecord(v)) throw new Error("issue must be an object");
    const magazine = optString(v.magazine, 100, "magazine");
    if (!magazine) throw new Error("magazine (slug) is required");
    if (!isIssueSlug(v.slug)) throw new Error("slug must be [a-z0-9-], 1-64 chars");
    const label = optString(v.label, 200, "label");
    if (!label) throw new Error("label is required");

    let cover_date: string | undefined;
    if (v.cover_date !== undefined && v.cover_date !== null) {
      if (typeof v.cover_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.cover_date)) {
        throw new Error("cover_date must be YYYY-MM-DD");
      }
      cover_date = v.cover_date;
    }
    let precision: "day" | "month" | "year" | undefined;
    if (v.cover_date_precision !== undefined && v.cover_date_precision !== null) {
      if (v.cover_date_precision !== "day" && v.cover_date_precision !== "month" && v.cover_date_precision !== "year") {
        throw new Error("cover_date_precision must be day|month|year");
      }
      precision = v.cover_date_precision;
    }
    if (cover_date && !precision) precision = "day";

    let binding: "ltr" | "rtl" | undefined;
    if (v.binding !== undefined && v.binding !== null) {
      if (v.binding !== "ltr" && v.binding !== "rtl") throw new Error("binding must be ltr|rtl");
      binding = v.binding;
    }

    let page_count: number | undefined;
    if (v.page_count !== undefined && v.page_count !== null) {
      if (typeof v.page_count !== "number" || !Number.isInteger(v.page_count) || v.page_count < 1 || v.page_count > 10_000) {
        throw new Error("page_count must be a positive integer");
      }
      page_count = v.page_count;
    }

    let supplements: { title: string; present: boolean }[] | undefined;
    if (v.supplements !== undefined && v.supplements !== null) {
      if (!Array.isArray(v.supplements)) throw new Error("supplements must be an array");
      supplements = v.supplements.map((s, i) => {
        if (!isRecord(s)) throw new Error(`supplements[${i}] must be an object`);
        const title = optString(s.title, 300, `supplements[${i}].title`);
        if (!title) throw new Error(`supplements[${i}].title is required`);
        return { title, present: s.present === true };
      });
    }

    let page_labels: Record<string, string> | undefined;
    if (v.page_labels !== undefined && v.page_labels !== null) {
      if (!isRecord(v.page_labels)) throw new Error("page_labels must be an object");
      page_labels = {};
      for (const [k, val] of Object.entries(v.page_labels)) {
        if (!/^\d{1,4}$/.test(k)) throw new Error(`page_labels key "${k}" must be a pdf index`);
        const lab = optString(val, 40, `page_labels[${k}]`);
        if (lab) page_labels[k] = lab;
      }
    }

    return {
      ok: true,
      value: {
        magazine,
        slug: v.slug,
        label,
        volume: optString(v.volume, 50, "volume"),
        number: optString(v.number, 50, "number"),
        whole_number: optString(v.whole_number, 50, "whole_number"),
        cover_date,
        cover_date_precision: precision,
        price_raw: optString(v.price_raw, 300, "price_raw"),
        publisher_raw: optString(v.publisher_raw, 300, "publisher_raw"),
        page_count,
        binding,
        source_url: optString(v.source_url, 1000, "source_url"),
        supplements,
        notes: optString(v.notes, 5000, "notes"),
        page_labels,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface MagazineInput {
  slug?: string;
  title: string;
  aliases?: string[];
  country?: string;
  language?: string;
  publisher?: string;
  pages_public?: boolean;
  notes?: string;
}

export function validateMagazineInput(v: unknown): Validated<MagazineInput> {
  try {
    if (!isRecord(v)) throw new Error("magazine must be an object");
    const title = optString(v.title, 200, "title");
    if (!title) throw new Error("title is required");
    const slug = optString(v.slug, 100, "slug");
    if (slug && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error("slug must be [a-z0-9-]");
    let aliases: string[] | undefined;
    if (v.aliases !== undefined && v.aliases !== null) {
      if (!Array.isArray(v.aliases)) throw new Error("aliases must be an array");
      aliases = v.aliases.map((a, i) => {
        const t = optString(a, 200, `aliases[${i}]`);
        if (!t) throw new Error(`aliases[${i}] is empty`);
        return t;
      });
    }
    const language = v.language === undefined || v.language === null ? undefined : normalizeLang(v.language);
    if (language === null) throw new Error("language must be a bcp47 code");
    return {
      ok: true,
      value: {
        slug,
        title,
        aliases,
        country: optString(v.country, 10, "country"),
        language,
        publisher: optString(v.publisher, 200, "publisher"),
        pages_public: typeof v.pages_public === "boolean" ? v.pages_public : undefined,
        notes: optString(v.notes, 5000, "notes"),
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
