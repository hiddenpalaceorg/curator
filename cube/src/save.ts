/**
 * The save pipeline: parse -> validate -> normalize ->
 * one transaction (page upsert + lock, conflict check, revision insert,
 * derived-table extraction, git enqueue) -> invalidation tags.
 */

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { PagePolicyInput } from "./auth/native";
import { diff3Merge } from "node-diff3";
import type { Root } from "mdast";
import { withTx } from "./db";
import { extractPage, invalidationTags, type ExtractedObject, type Extraction } from "./extract";
import { CubeAuthorizationError, CubeConflictError, CubeValidationError, hasErrors, type Issue } from "./issues";
import { parseDocument } from "./parse";
import { checkQueries } from "./query-component";
import type { Registry } from "./schema/index";
import { DEFAULT_SLUG_CONFIG, isTitleError, normalizeTitle, type SlugConfig, type TitleRef } from "./slug";
import { serializeComponentTag } from "./tags";
import { validateDocument, type ComponentInstance, type ValidateOptions } from "./validate";

export type CubeAuthor = {
  id?: number | null;
  name: string;
};

export type SaveContext = {
  registry: Registry;
  slug?: SlugConfig;
  validate?: ValidateOptions;
};

export type SaveInput = {
  ns: string;
  slug: string;
  markdown: string;
  /** Head revision the editor loaded; null/undefined when creating. */
  baseRevId?: number | null;
  author: CubeAuthor;
  comment?: string;
  minor?: boolean;
  /** Import path: preserve original wikitext verbatim (skips parse/validate). */
  wikitextFallback?: boolean;
  /** Import provenance: historical revision timestamp (default now()). */
  timestamp?: Date;
  /** Import provenance: source MediaWiki revision id (unique when set). */
  mwRevId?: number;
  /** Remote writes: authorize the locked current state before any mutation or
   * conflict disclosure. Trusted local imports may omit this callback. */
  authorize?: (page: PagePolicyInput & { exists: boolean; deleted: boolean }) => boolean | Promise<boolean>;
};

export type SaveResult = {
  pageId: number;
  revId: number;
  noop: boolean;
  merged: boolean;
  issues: Issue[];
  /** Cache invalidation tags for the host (cube:page:*, cube:cat:*, cube:q:*). */
  invalidate: string[];
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizeContent(markdown: string): string {
  const lf = markdown.replace(/\r\n?/g, "\n");
  return lf.replace(/\n+$/, "") + "\n";
}

type ParsedDoc = {
  root: Root;
  components: ComponentInstance[];
  issues: Issue[];
  extraction: Extraction;
};

function parseAndValidate(ctx: SaveContext, page: TitleRef, content: string): ParsedDoc {
  const { root, issues: parseIssues } = parseDocument(content);
  if (!root) throw new CubeValidationError(parseIssues);
  const { issues, components } = validateDocument(ctx.registry, root, page, ctx.validate);
  const all = [...parseIssues, ...issues, ...checkQueries(ctx.registry, components)];
  if (hasErrors(all)) throw new CubeValidationError(all);
  const extraction = extractPage(ctx.registry, root, components, page);
  return { root, components, issues: all, extraction };
}

export async function savePage(pool: Pool, ctx: SaveContext, input: SaveInput): Promise<SaveResult> {
  const slugCfg = ctx.slug ?? DEFAULT_SLUG_CONFIG;
  const ref = normalizeTitle(`${input.slug}`, { ...slugCfg, namespacePrefixes: {} });
  if (isTitleError(ref)) {
    throw new CubeValidationError([
      { severity: "error", rule: `title-${ref.error}`, message: `invalid page title: ${ref.error}` },
    ]);
  }
  const page: TitleRef = { ...ref, ns: input.ns };

  let content = normalizeContent(input.markdown);
  let contentSha = sha256(content);
  let merged = false;

  // Pre-check no-op outside the transaction (racy but write-free).
  const head = await pool.query(
    `SELECT p.id, p.current_rev_id, r.content_sha256
       FROM cube_page p LEFT JOIN cube_revision r ON r.id = p.current_rev_id
      WHERE p.ns = $1 AND p.slug = $2 AND p.deleted_at IS NULL`,
    [page.ns, page.slug],
  );
  const headRow = head.rows[0]
    ? {
        id: Number(head.rows[0].id),
        current_rev_id: head.rows[0].current_rev_id === null ? null : Number(head.rows[0].current_rev_id),
        content_sha256: head.rows[0].content_sha256 as string | null,
      }
    : undefined;
  if (
    !input.authorize && headRow?.content_sha256 === contentSha &&
    (input.baseRevId == null || input.baseRevId === headRow.current_rev_id)
  ) {
    return {
      pageId: headRow.id,
      revId: headRow.current_rev_id!,
      noop: true,
      merged: false,
      issues: [],
      invalidate: [],
    };
  }

  let doc = input.authorize || input.wikitextFallback ? null : parseAndValidate(ctx, page, content);

  return withTx(pool, async (client) => {
    let locked = await client.query(
      `SELECT id, current_rev_id, deleted_at, visibility, protection FROM cube_page WHERE ns = $1 AND slug = $2 FOR UPDATE`,
      [page.ns, page.slug],
    );
    if (locked.rows[0] === undefined) {
      await client.query(
        `INSERT INTO cube_page (ns, slug, title) VALUES ($1, $2, $3) ON CONFLICT (ns, slug) DO NOTHING`,
        [page.ns, page.slug, page.title],
      );
      locked = await client.query(
        `SELECT id, current_rev_id, deleted_at, visibility, protection FROM cube_page WHERE ns = $1 AND slug = $2 FOR UPDATE`,
        [page.ns, page.slug],
      );
    }
    const pageId = Number(locked.rows[0].id);
    const currentRevId = locked.rows[0].current_rev_id === null ? null : Number(locked.rows[0].current_rev_id);
    // Recreating a soft-deleted page is a fresh create: no conflict check,
    // but the revision chain keeps its parent for history continuity.
    const wasDeleted = locked.rows[0].deleted_at !== null;
    if (input.authorize) {
      if (!(await input.authorize({
        ns: page.ns, slug: page.slug, visibility: locked.rows[0].visibility,
        protection: locked.rows[0].protection, exists: currentRevId !== null, deleted: wasDeleted,
      }))) throw new CubeAuthorizationError();
      if (!wasDeleted && headRow?.current_rev_id === currentRevId &&
          headRow?.content_sha256 === contentSha &&
          (input.baseRevId == null || input.baseRevId === currentRevId)) {
        return { pageId, revId: currentRevId!, noop: true, merged: false, issues: [], invalidate: [] };
      }
      doc = input.wikitextFallback ? null : parseAndValidate(ctx, page, content);
    }
    if (wasDeleted) {
      await client.query(`UPDATE cube_page SET deleted_at = NULL WHERE id = $1`, [pageId]);
    }

    if (!wasDeleted && currentRevId !== null && (input.baseRevId ?? null) !== currentRevId) {
      const current = await client.query(`SELECT content, content_sha256 FROM cube_revision WHERE id = $1`, [
        currentRevId,
      ]);
      const currentContent = current.rows[0].content as string;
      if (current.rows[0].content_sha256 === contentSha) {
        return { pageId, revId: currentRevId, noop: true, merged: false, issues: [], invalidate: [] };
      }

      let baseContent = "";
      if (input.baseRevId != null) {
        const base = await client.query(
          `SELECT content FROM cube_revision WHERE id = $1 AND page_id = $2`,
          [input.baseRevId, pageId],
        );
        baseContent = (base.rows[0]?.content as string | undefined) ?? "";
        if (base.rows[0] === undefined) {
          throw new CubeConflictError(currentRevId, currentContent, baseContent);
        }
      } else {
        // Creating over an existing page.
        throw new CubeConflictError(currentRevId, currentContent, "");
      }

      const regions = diff3Merge(content.split("\n"), baseContent.split("\n"), currentContent.split("\n"), {
        excludeFalseConflicts: true,
      });
      if (regions.some((r) => "conflict" in r)) {
        throw new CubeConflictError(currentRevId, currentContent, baseContent);
      }
      content = normalizeContent(
        regions.flatMap((r) => ("ok" in r ? (r.ok as string[]) : [])).join("\n"),
      );
      contentSha = sha256(content);
      merged = true;
      if (!input.wikitextFallback) doc = parseAndValidate(ctx, page, content);
    }

    const extraction: Extraction = doc?.extraction ?? {
      objects: [],
      categories: [],
      links: [],
      searchDoc: "",
      queryDeps: [],
      warnings: [],
    };

    const before = await client.query(
      `SELECT component, ordinal, data FROM cube_page_object WHERE page_id = $1`,
      [pageId],
    );
    const beforeObjects = before.rows as ExtractedObject[];
    const beforeCats = (
      await client.query(`SELECT category FROM cube_page_category WHERE page_id = $1`, [pageId])
    ).rows.map((r) => r.category as string);

    const rev = await client.query(
      `INSERT INTO cube_revision
         (page_id, parent_rev_id, author_id, author_name, comment, minor, content, content_sha256,
          wikitext_fallback, mw_rev_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()))
       RETURNING id`,
      [
        pageId,
        currentRevId,
        input.author.id ?? null,
        input.author.name,
        input.comment ?? "",
        input.minor ?? false,
        content,
        contentSha,
        input.wikitextFallback ?? false,
        input.mwRevId ?? null,
        input.timestamp ?? null,
      ],
    );
    const revId = Number(rev.rows[0].id);

    const redirectRef = extraction.redirect
      ? normalizeTitle(extraction.redirect.target, slugCfg)
      : undefined;
    const redirect = redirectRef && !isTitleError(redirectRef) ? redirectRef : undefined;

    await client.query(
      `UPDATE cube_page
          SET current_rev_id = $2, updated_at = now(), is_redirect = $3,
              display_title = $4, search_doc = $5
        WHERE id = $1`,
      [pageId, revId, redirect !== undefined, extraction.displayTitle ?? null, extraction.searchDoc],
    );

    await writeDerived(client, pageId, extraction, redirect, slugCfg);

    await client.query(
      `INSERT INTO cube_git_queue (rev_id, action, detail) VALUES ($1, 'save', $2)`,
      [revId, JSON.stringify({ ns: page.ns, slug: page.slug, title: page.title })],
    );
    await client.query(`NOTIFY cube_git`);

    const tags = new Set<string>([`cube:page:${page.ns}:${page.slug}`]);
    for (const c of symmetricDiff(beforeCats, extraction.categories)) tags.add(`cube:cat:${c}`);
    for (const t of invalidationTags(ctx.registry, beforeObjects, extraction.objects)) tags.add(t);

    return {
      pageId,
      revId,
      noop: false,
      merged,
      issues: doc?.issues ?? [],
      invalidate: [...tags],
    };
  });
}

async function writeDerived(
  client: PoolClient,
  pageId: number,
  extraction: Extraction,
  redirect: TitleRef | undefined,
  slugCfg: SlugConfig,
): Promise<void> {
  await client.query(`DELETE FROM cube_page_object WHERE page_id = $1`, [pageId]);
  if (extraction.objects.length > 0) {
    await client.query(
      `INSERT INTO cube_page_object (page_id, component, ordinal, data)
       SELECT $1, * FROM unnest($2::text[], $3::int[], $4::jsonb[])`,
      [
        pageId,
        extraction.objects.map((o) => o.component),
        extraction.objects.map((o) => o.ordinal),
        extraction.objects.map((o) => JSON.stringify(o.data)),
      ],
    );
  }

  await client.query(`DELETE FROM cube_page_category WHERE page_id = $1`, [pageId]);
  if (extraction.categories.length > 0) {
    await client.query(
      `INSERT INTO cube_page_category (page_id, category)
       SELECT $1, * FROM unnest($2::text[]) ON CONFLICT DO NOTHING`,
      [pageId, extraction.categories],
    );
  }

  await client.query(`DELETE FROM cube_link WHERE from_page_id = $1`, [pageId]);
  const linkRows: { ns: string; slug: string; kind: string }[] = [];
  const seen = new Set<string>();
  for (const l of extraction.links) {
    const ref = normalizeTitle(l.target, slugCfg);
    if (isTitleError(ref)) continue;
    const ns = l.kind === "media" ? "file" : ref.ns;
    const key = `${ns} ${ref.slug} ${l.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    linkRows.push({ ns, slug: ref.slug, kind: l.kind });
  }
  if (linkRows.length > 0) {
    await client.query(
      `INSERT INTO cube_link (from_page_id, to_ns, to_slug, kind)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
      [pageId, linkRows.map((l) => l.ns), linkRows.map((l) => l.slug), linkRows.map((l) => l.kind)],
    );
  }

  await client.query(`DELETE FROM cube_query_dep WHERE page_id = $1`, [pageId]);
  if (extraction.queryDeps.length > 0) {
    await client.query(
      `INSERT INTO cube_query_dep (page_id, component, filter_key)
       SELECT $1, * FROM unnest($2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
      [
        pageId,
        extraction.queryDeps.map((d) => d.component),
        extraction.queryDeps.map((d) => d.filterKey ?? "*"),
      ],
    );
  }

  if (redirect) {
    await client.query(
      `INSERT INTO cube_redirect (from_page_id, to_ns, to_slug, fragment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_page_id)
       DO UPDATE SET to_ns = EXCLUDED.to_ns, to_slug = EXCLUDED.to_slug, fragment = EXCLUDED.fragment`,
      [pageId, redirect.ns, redirect.slug, redirect.fragment ?? null],
    );
  } else {
    await client.query(`DELETE FROM cube_redirect WHERE from_page_id = $1`, [pageId]);
  }
}

function symmetricDiff(a: string[], b: string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...new Set([...a.filter((x) => !sb.has(x)), ...b.filter((x) => !sa.has(x))])];
}

/* ---- move / delete ------------------------------------------------------ */

export type MoveInput = {
  from: { ns: string; slug: string };
  to: { ns: string; slug: string };
  actor: CubeAuthor;
  comment?: string;
  leaveRedirect?: boolean;
};

export async function movePage(pool: Pool, ctx: SaveContext, input: MoveInput): Promise<{ pageId: number }> {
  const slugCfg = ctx.slug ?? DEFAULT_SLUG_CONFIG;
  const to = normalizeTitle(input.to.slug, { ...slugCfg, namespacePrefixes: {} });
  if (isTitleError(to)) throw new Error(`invalid move target: ${to.error}`);

  const pageId = await withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT id, title FROM cube_page WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.from.ns, input.from.slug],
    );
    if (row.rows[0] === undefined) throw new Error("page not found");
    const id = Number(row.rows[0].id);

    const clash = await client.query(`SELECT id FROM cube_page WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL`, [
      input.to.ns,
      to.slug,
    ]);
    if (clash.rows[0] !== undefined) throw new Error("target page exists");

    await client.query(
      `UPDATE cube_page SET ns = $2, slug = $3, title = $4, updated_at = now() WHERE id = $1`,
      [id, input.to.ns, to.slug, to.title],
    );
    await client.query(
      `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
       VALUES ($1, 'move', $2, $3, $4)`,
      [id, input.actor.id ?? null, input.actor.name, JSON.stringify({ from: input.from, to: { ns: input.to.ns, slug: to.slug } })],
    );
    await client.query(`INSERT INTO cube_git_queue (rev_id, action, detail) VALUES (NULL, 'move', $1)`, [
      JSON.stringify({ from: input.from, to: { ns: input.to.ns, slug: to.slug } }),
    ]);
    await client.query(`NOTIFY cube_git`);
    return id;
  });

  if (input.leaveRedirect !== false) {
    await savePage(pool, ctx, {
      ns: input.from.ns,
      slug: input.from.slug,
      // Serialize the tag so a title containing `"` can't inject attributes.
      markdown: `${serializeComponentTag("Redirect", { to: to.title })}\n`,
      author: input.actor,
      comment: input.comment ?? `moved to ${to.title}`,
    });
  }
  return { pageId };
}

export type DeleteInput = {
  ns: string;
  slug: string;
  actor: CubeAuthor;
  reason?: string;
};

export async function deletePage(pool: Pool, input: DeleteInput): Promise<void> {
  await withTx(pool, async (client) => {
    const row = await client.query(
      `SELECT id FROM cube_page WHERE ns = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.ns, input.slug],
    );
    if (row.rows[0] === undefined) throw new Error("page not found");
    const id = Number(row.rows[0].id);

    await client.query(`UPDATE cube_page SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
    for (const table of ["cube_page_object", "cube_page_category", "cube_query_dep"]) {
      await client.query(`DELETE FROM ${table} WHERE page_id = $1`, [id]);
    }
    await client.query(`DELETE FROM cube_link WHERE from_page_id = $1`, [id]);
    await client.query(`DELETE FROM cube_redirect WHERE from_page_id = $1`, [id]);
    await client.query(
      `INSERT INTO cube_page_log (page_id, action, actor_id, actor_name, detail)
       VALUES ($1, 'delete', $2, $3, $4)`,
      [id, input.actor.id ?? null, input.actor.name, JSON.stringify({ reason: input.reason ?? "" })],
    );
    await client.query(`INSERT INTO cube_git_queue (rev_id, action, detail) VALUES (NULL, 'delete', $1)`, [
      JSON.stringify({ ns: input.ns, slug: input.slug }),
    ]);
    await client.query(`NOTIFY cube_git`);
  });
}
