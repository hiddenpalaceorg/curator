/**
 * cube: a markdown wiki engine for Next.js apps.
 *
 * createCube(config) wires the host's pool/site config to the engine and
 * returns the local API (Payload-style: direct DB access, no HTTP hops).
 * HTTP handlers and MCP mount on top of this API.
 */

import type { Pool } from "pg";
import type { CubeAuthAdapter } from "./auth/native";
import { builtinComponents } from "./builtins";
import type { RevisionRow } from "./db";
import type { GitExportConfig } from "./git";
import { createHandlers, type CubeHandlers } from "./http/index";
import { CubeValidationError, type Issue } from "./issues";
import { runQuery, type CompileOptions, type ObjectQuery, type QueryResult } from "./query";
import {
  deletePage,
  movePage,
  savePage,
  type CubeAuthor,
  type DeleteInput,
  type MoveInput,
  type SaveContext,
  type SaveInput,
  type SaveResult,
} from "./save";
import {
  createRegistry,
  toSchemaJson,
  type ComponentSchemaJson,
  type ComponentSpec,
  type Registry,
} from "./schema/index";
import {
  DEFAULT_SLUG_CONFIG,
  isTitleError,
  normalizeTitle,
  type SlugConfig,
  type TitleRef,
} from "./slug";
import type { CubeStorageAdapter } from "./storage";
import type { ValidateOptions } from "./validate";

export type RevisionEvent = {
  ns: string;
  slug: string;
  title: string;
  revId: number;
  author: string;
  comment: string;
  minor: boolean;
};

export type CubeConfig = {
  db: { pool: Pool | (() => Pool) };
  /** Site component schemas; cube built-ins are always included. */
  components?: ComponentSpec[];
  /** Session/permissions adapter; cubeNativeAuth() is the batteries-included one. */
  auth?: CubeAuthAdapter;
  site?: {
    homeSlug?: string;
    apiBasePath?: string;
    slug?: Partial<SlugConfig>;
    interwiki?: Record<string, string>;
  };
  validate?: ValidateOptions;
  /** Media blob backend; uploads 501 without one. */
  storage?: CubeStorageAdapter;
  git?: GitExportConfig;
  /** Called post-save with cache tags; host maps to revalidateTag etc. */
  onInvalidate?: (tags: string[], pages: { ns: string; slug: string }[]) => void;
  notify?: {
    revisionSaved?: (ev: RevisionEvent) => void;
  };
};

export type Page = {
  id: number;
  ns: string;
  slug: string;
  title: string;
  displayTitle: string | null;
  path: string | null;
  isRedirect: boolean;
  visibility: "public" | "moderator";
  protection: Record<string, string>;
  markdown: string;
  revId: number;
  /** True when this revision holds original MediaWiki wikitext, not markdown. */
  wikitextFallback: boolean;
  updatedAt: Date;
};

export type RevisionMeta = {
  id: number;
  parentRevId: number | null;
  author: string;
  comment: string;
  minor: boolean;
  wikitextFallback: boolean;
  createdAt: Date;
  bytes: number;
};

export type ResolveResult = {
  ns: string;
  slug: string;
  redirectedFrom?: { ns: string; slug: string };
};

export type SearchHit = {
  ns: string;
  slug: string;
  title: string;
  snippet: string;
  rank: number;
};

export type CubeLocalApi = {
  /** `followRedirect: false` returns the page itself, so a reader can reach
   *  a redirect page rather than its target (MediaWiki's ?redirect=no). */
  resolve(title: string, opts?: { followRedirect?: boolean }): Promise<ResolveResult | null>;
  getPage(ref: { ns: string; slug: string }, opts?: { revId?: number }): Promise<Page | null>;
  savePage(input: SaveInput): Promise<SaveResult>;
  movePage(input: MoveInput): Promise<{ pageId: number }>;
  deletePage(input: DeleteInput): Promise<void>;
  getRevision(
    id: number,
  ): Promise<
    | (RevisionMeta & {
        content: string;
        pageId: number;
        ns: string;
        slug: string;
        visibility: "public" | "moderator";
        protection: Record<string, string>;
        deletedAt: Date | null;
      })
    | null
  >;
  listRevisions(ref: { ns: string; slug: string }, opts?: { limit?: number; before?: number }): Promise<RevisionMeta[]>;
  search(q: string, opts?: { ns?: string; limit?: number }): Promise<SearchHit[]>;
  queryObjects(q: ObjectQuery, opts?: CompileOptions): Promise<QueryResult>;
  listComponents(): ComponentSchemaJson[];
  /** Parse+validate without saving (preview/editor lint). */
  validateMarkdown(ref: { ns: string; slug: string }, markdown: string): Promise<Issue[]>;
};

export type Cube = {
  registry: Registry;
  config: CubeConfig;
  slug: SlugConfig;
  saveContext: SaveContext;
  pool(): Pool;
  api: CubeLocalApi;
  /** Fetch-standard route handlers; mount at site.apiBasePath. */
  handlers: CubeHandlers;
};

export function createCube(config: CubeConfig): Cube {
  const registry = createRegistry([...builtinComponents, ...(config.components ?? [])]);
  const slug: SlugConfig = {
    ...DEFAULT_SLUG_CONFIG,
    ...config.site?.slug,
    namespacePrefixes: {
      ...DEFAULT_SLUG_CONFIG.namespacePrefixes,
      ...config.site?.slug?.namespacePrefixes,
    },
  };
  const pool = typeof config.db.pool === "function" ? config.db.pool : () => config.db.pool as Pool;
  const saveContext: SaveContext = { registry, slug, ...(config.validate && { validate: config.validate }) };

  const api: CubeLocalApi = {
    async resolve(title, opts = {}) {
      const ref = normalizeTitle(title, slug);
      if (isTitleError(ref)) return null;
      return resolveRef(pool(), ref, opts.followRedirect !== false);
    },

    async getPage(ref, opts = {}) {
      const p = pool();
      const page = await p.query(
        `SELECT id, ns, slug, title, display_title, path, current_rev_id, is_redirect, visibility,
                protection, updated_at
           FROM cube_page WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL`,
        [ref.ns, ref.slug],
      );
      const row = page.rows[0];
      if (!row || row.current_rev_id === null) return null;
      const revId = opts.revId ?? (row.current_rev_id as number);
      const rev = await p.query(
        `SELECT id, content, wikitext_fallback FROM cube_revision WHERE id = $1 AND page_id = $2`,
        [revId, row.id],
      );
      if (!rev.rows[0]) return null;
      return {
        id: Number(row.id),
        ns: row.ns,
        slug: row.slug,
        title: row.title,
        displayTitle: row.display_title,
        path: row.path,
        isRedirect: row.is_redirect,
        visibility: row.visibility,
        protection: row.protection,
        markdown: rev.rows[0].content,
        revId: Number(rev.rows[0].id),
        wikitextFallback: rev.rows[0].wikitext_fallback,
        updatedAt: row.updated_at,
      };
    },

    async savePage(input) {
      const result = await savePage(pool(), saveContext, input);
      if (!result.noop) {
        const pages = await dependentPages(pool(), result.invalidate);
        try {
          config.onInvalidate?.(result.invalidate, pages);
          config.notify?.revisionSaved?.({
            ns: input.ns,
            slug: input.slug,
            title: input.slug.replace(/_/g, " "),
            revId: result.revId,
            author: input.author.name,
            comment: input.comment ?? "",
            minor: input.minor ?? false,
          });
        } catch {
          // Post-commit hooks must never fail the save.
        }
      }
      return result;
    },

    movePage: (input) => movePage(pool(), saveContext, input),
    deletePage: (input) => deletePage(pool(), input),

    async getRevision(id) {
      const res = await pool().query(
        `SELECT r.id, r.page_id, r.parent_rev_id, r.author_name, r.comment, r.minor,
                r.content, r.wikitext_fallback, r.created_at,
                p.ns, p.slug, p.visibility, p.protection, p.deleted_at
           FROM cube_revision r JOIN cube_page p ON p.id = r.page_id
          WHERE r.id = $1`,
        [id],
      );
      const r = res.rows[0] as
        | (RevisionRow & {
            page_id: number;
            ns: string;
            slug: string;
            visibility: "public" | "moderator";
            protection: Record<string, string>;
            deleted_at: Date | null;
          })
        | undefined;
      if (!r) return null;
      return {
        id: Number(r.id),
        pageId: Number(r.page_id),
        ns: r.ns,
        slug: r.slug,
        visibility: r.visibility,
        protection: r.protection,
        deletedAt: r.deleted_at,
        parentRevId: r.parent_rev_id === null ? null : Number(r.parent_rev_id),
        author: r.author_name,
        comment: r.comment,
        minor: r.minor,
        wikitextFallback: r.wikitext_fallback,
        createdAt: r.created_at,
        bytes: Buffer.byteLength(r.content, "utf8"),
        content: r.content,
      };
    },

    async listRevisions(ref, opts = {}) {
      const res = await pool().query(
        `SELECT r.id, r.parent_rev_id, r.author_name, r.comment, r.minor, r.wikitext_fallback,
                r.created_at, length(r.content) AS bytes
           FROM cube_revision r
           JOIN cube_page p ON p.id = r.page_id
          WHERE p.ns = $1 AND p.slug = $2 ${opts.before ? "AND r.id < $4" : ""}
          ORDER BY r.id DESC
          LIMIT $3`,
        opts.before
          ? [ref.ns, ref.slug, Math.min(opts.limit ?? 50, 500), opts.before]
          : [ref.ns, ref.slug, Math.min(opts.limit ?? 50, 500)],
      );
      return res.rows.map((r) => ({
        id: Number(r.id),
        parentRevId: r.parent_rev_id === null ? null : Number(r.parent_rev_id),
        author: r.author_name,
        comment: r.comment,
        minor: r.minor,
        wikitextFallback: r.wikitext_fallback,
        createdAt: r.created_at,
        bytes: Number(r.bytes),
      }));
    },

    async search(q, opts = {}) {
      const limit = Math.min(opts.limit ?? 20, 100);
      const res = await pool().query(
        `SELECT ns, slug, title,
                ts_headline('simple', search_doc, plainto_tsquery('simple', $1),
                            'MaxWords=25, MinWords=10') AS snippet,
                (similarity(title, $1) * 2 +
                 ts_rank(search_tsv, plainto_tsquery('simple', $1))) AS rank
           FROM cube_page
          WHERE deleted_at IS NULL AND visibility = 'public'
            AND ($2::text IS NULL OR ns = $2)
            AND (search_tsv @@ plainto_tsquery('simple', $1) OR title % $1 OR title ILIKE '%' || $1 || '%')
          ORDER BY rank DESC, title ASC
          LIMIT $3`,
        [q, opts.ns ?? null, limit],
      );
      return res.rows.map((r) => ({
        ns: r.ns,
        slug: r.slug,
        title: r.title,
        snippet: r.snippet,
        rank: Number(r.rank),
      }));
    },

    queryObjects: (q, opts) => runQuery(pool(), registry, q, opts),

    listComponents: () => toSchemaJson(registry),

    async validateMarkdown(ref, markdown) {
      try {
        await savePageDryRun(saveContext, ref, markdown);
        return [];
      } catch (err) {
        if (err instanceof CubeValidationError) return err.issues;
        throw err;
      }
    },
  };

  const cube: Cube = { registry, config, slug, saveContext, pool, api, handlers: null as never };
  cube.handlers = createHandlers(cube);
  return cube;
}

async function savePageDryRun(
  ctx: SaveContext,
  ref: { ns: string; slug: string },
  markdown: string,
): Promise<void> {
  // Reuses the exact save-pipeline front half via a parse+validate pass.
  const { parseDocument } = await import("./parse");
  const { validateDocument } = await import("./validate");
  const { checkQueries } = await import("./query-component");
  const { hasErrors } = await import("./issues");
  const page: TitleRef = { ns: ref.ns, slug: ref.slug, title: ref.slug.replace(/_/g, " ") };
  const { root, issues: parseIssues } = parseDocument(markdown);
  if (!root) throw new CubeValidationError(parseIssues);
  const { issues, components } = validateDocument(ctx.registry, root, page, ctx.validate);
  const all = [...parseIssues, ...issues, ...checkQueries(ctx.registry, components)];
  if (hasErrors(all) || all.length > 0) throw new CubeValidationError(all);
}

async function resolveRef(
  pool: Pool,
  ref: TitleRef,
  followRedirect = true,
): Promise<ResolveResult | null> {
  const page = await pool.query(
    `SELECT p.is_redirect, r.to_ns, r.to_slug
       FROM cube_page p
       LEFT JOIN cube_redirect r ON r.from_page_id = p.id
      WHERE p.ns = $1 AND p.slug = $2 AND p.deleted_at IS NULL`,
    [ref.ns, ref.slug],
  );
  const row = page.rows[0];
  if (!row) return null;
  if (followRedirect && row.is_redirect && row.to_slug) {
    const target = await pool.query(
      `SELECT 1 FROM cube_page WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL`,
      [row.to_ns, row.to_slug],
    );
    if (target.rows[0]) {
      return { ns: row.to_ns, slug: row.to_slug, redirectedFrom: { ns: ref.ns, slug: ref.slug } };
    }
  }
  return { ns: ref.ns, slug: ref.slug };
}

/** Pages whose <Query>/component queries depend on the given invalidation tags. */
export async function dependentPages(
  pool: Pool,
  tags: string[],
): Promise<{ ns: string; slug: string }[]> {
  const pairs: { component: string; key: string }[] = [];
  for (const tag of tags) {
    const m = /^cube:q:([^:]+):(.+)$/.exec(tag);
    if (m) pairs.push({ component: m[1]!, key: m[2]! });
  }
  if (pairs.length === 0) return [];
  const res = await pool.query(
    `SELECT DISTINCT p.ns, p.slug
       FROM cube_query_dep d
       JOIN cube_page p ON p.id = d.page_id
      WHERE (d.component, d.filter_key) IN (
        SELECT c, k FROM unnest($1::text[], $2::text[]) AS t(c, k)
      )`,
    [pairs.map((p) => p.component), pairs.map((p) => p.key)],
  );
  return res.rows;
}

export { builtinComponents } from "./builtins";
export {
  defineComponent,
  createRegistry,
  toSchemaJson,
  snakeCase,
  type AttrSpec,
  type ComponentSpec,
  type ComponentSchemaJson,
  type QueryDep,
  type Registry,
} from "./schema/index";
export { parseDocument, type WikiLink } from "./parse";
export { validateDocument, DEFAULT_INTRINSIC_TAGS, type ComponentInstance, type ValidateOptions } from "./validate";
export { extractPage, invalidationTags, type Extraction } from "./extract";
export { serializeComponentTag, parseComponentTag, serializeAttr } from "./tags";
export {
  normalizeTitle,
  titleFromSlug,
  fullTitle,
  isTitleError,
  DEFAULT_SLUG_CONFIG,
  DEFAULT_NAMESPACE_PREFIXES,
  type SlugConfig,
  type TitleRef,
} from "./slug";
export { savePage, movePage, deletePage, normalizeContent, type SaveInput, type SaveResult, type SaveContext, type CubeAuthor } from "./save";
export { compileQuery, runQuery, CubeQueryError, DEFAULT_LIMIT, MAX_LIMIT, type ObjectQuery, type QueryResult, type QueryRow, type Where } from "./query";
export { toObjectQuery, checkQueries } from "./query-component";
export { processGitQueue, startGitWorker, pageFile, type GitExportConfig, type DrainResult } from "./git";
export { CubeValidationError, CubeConflictError, hasErrors, type Issue } from "./issues";
export { withTx } from "./db";
export {
  cubeNativeAuth,
  defaultCan,
  createUser,
  canonicalUsername,
  type CubeAuthAdapter,
  type CubeUser,
  type CubeAction,
} from "./auth/native";
export { hashPassword, verifyPassword, needsRehash } from "./auth/passwords";
export { createHandlers, createToken, type CubeHandlers } from "./http/index";
export { diffRevisions, type RevisionDiff } from "./diff";
export {
  localDirStorage,
  s3Storage,
  type CubeStorageAdapter,
  type LocalDirStorageOptions,
  type S3StorageOptions,
} from "./storage";
export {
  uploadMedia,
  getMedia,
  listMediaRevisions,
  deleteMedia,
  searchMedia,
  storageKeyFor,
  CubeMediaError,
  DEFAULT_MAX_UPLOAD_BYTES,
  type MediaActor,
  type MediaRow,
  type MediaRevisionRow,
  type MediaSearchHit,
  type UploadMediaInput,
  type UploadMediaResult,
  type DeleteMediaInput,
} from "./media";
export {
  protectPage,
  setPageVisibility,
  blockUser,
  unblockUser,
  massRevert,
  listRecentChanges,
  CubeModerationError,
  type MassRevertInput,
  type MassRevertResult,
  type RecentChange,
} from "./moderation";
