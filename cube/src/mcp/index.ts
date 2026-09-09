/**
 * MCP server: a thin layer over CubeLocalApi: zero duplicated logic, every
 * write goes through the validated save pipeline and the git mirror.
 * Validation failures come back as tool RESULTS (not protocol errors) so
 * agents can self-correct against line numbers.
 *
 * Stdio-first: `createCubeMcpServer(cube, user)` + StdioServerTransport in a
 * host script. Streamable-HTTP mounting is a follow-up.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultCan, type CubeUser } from "../auth/native";
import { CubeAuthorizationError, CubeConflictError, CubeValidationError } from "../issues";
import { CubeQueryError } from "../query";
import type { Cube } from "../index";

export type McpOptions = {
  /** Acting identity for writes; omit for read-only tool registration. */
  user?: CubeUser | null;
  /** Allow create_page/update_page. Default: only when a user is provided. */
  allowWrites?: boolean;
};

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] };
}

export function createCubeMcpServer(cube: Cube, opts: McpOptions = {}): McpServer {
  const server = new McpServer({ name: "cube", version: "0.1.0" });
  const allowWrites = opts.user != null && (opts.allowWrites ?? true);
  const author = opts.user ? { id: opts.user.id, name: opts.user.name } : { id: null, name: "mcp-agent" };

  server.registerTool(
    "search_pages",
    {
      description: "Full-text + title search over wiki pages.",
      inputSchema: {
        query: z.string(),
        ns: z.string().optional().describe("namespace filter, e.g. 'main', 'file'"),
        limit: z.number().int().max(100).optional(),
      },
    },
    async ({ query, ns, limit }) => text(await cube.api.search(query, { ns, limit })),
  );

  server.registerTool(
    "get_page",
    {
      description:
        "Fetch a page's markdown source by title (redirects followed). Returns slug, revision id (use as baseRevision when editing), and markdown.",
      inputSchema: { title: z.string(), revision: z.number().int().optional() },
    },
    async ({ title, revision }) => {
      const resolved = await cube.api.resolve(title);
      if (!resolved) return text({ error: "no such page" });
      const page = await cube.api.getPage(resolved, revision ? { revId: revision } : {});
      if (!page) return text({ error: "no such page" });
      return text({
        ns: page.ns,
        slug: page.slug,
        title: page.title,
        revision: page.revId,
        isRedirect: page.isRedirect,
        redirectedFrom: resolved.redirectedFrom,
        markdown: page.markdown,
      });
    },
  );

  server.registerTool(
    "list_revisions",
    {
      description: "Revision history for a page (newest first).",
      inputSchema: { title: z.string(), limit: z.number().int().max(500).optional(), before: z.number().int().optional() },
    },
    async ({ title, limit, before }) => {
      const resolved = await cube.api.resolve(title);
      if (!resolved) return text({ error: "no such page" });
      return text(await cube.api.listRevisions(resolved.redirectedFrom ?? resolved, { limit, before }));
    },
  );

  server.registerTool(
    "get_revision",
    { description: "Fetch one revision's markdown + metadata.", inputSchema: { id: z.number().int() } },
    async ({ id }) => text((await cube.api.getRevision(id)) ?? { error: "no such revision" }),
  );

  server.registerTool(
    "diff_revisions",
    {
      description: "Line diff between two revisions.",
      inputSchema: { from: z.number().int(), to: z.number().int() },
    },
    async ({ from, to }) => {
      const { diffRevisions } = await import("../diff");
      return text((await diffRevisions(cube.pool(), from, to)) ?? { error: "no such revisions" });
    },
  );

  server.registerTool(
    "query_objects",
    {
      description:
        "Query structured data extracted from pages (the #ask replacement). Use list_components to see queryable fields. Example: {from: 'Prototype', where: {system: 'Sega Mega Drive'}, sort: [{field: 'build_date'}], limit: 50}",
      inputSchema: {
        from: z.union([z.string(), z.array(z.string())]),
        where: z.record(z.string(), z.unknown()).optional(),
        select: z.array(z.string()).optional(),
        sort: z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })).optional(),
        limit: z.number().int().optional(),
        groupBy: z.string().optional(),
        aggs: z
          .array(z.object({ fn: z.enum(["count", "min", "max"]), field: z.string().optional(), as: z.string().optional() }))
          .optional(),
      },
    },
    async (q) => {
      try {
        return text(await cube.api.queryObjects(q as never));
      } catch (e) {
        if (e instanceof CubeQueryError) return text({ error: e.message });
        throw e;
      }
    },
  );

  server.registerTool(
    "list_components",
    {
      description: "Component schemas: attributes, types, and queryable fields — read before writing component tags or queries.",
      inputSchema: {},
    },
    async () => text(cube.api.listComponents()),
  );

  if (allowWrites) {
    const writeHandler = async ({
      title,
      markdown,
      comment,
      baseRevision,
    }: {
      title: string;
      markdown: string;
      comment?: string;
      baseRevision?: number;
    }) => {
      const { normalizeTitle, isTitleError } = await import("../slug");
      const ref = normalizeTitle(title, cube.slug);
      if (isTitleError(ref)) return text({ error: `invalid title: ${ref.error}` });
      try {
        const result = await cube.api.savePage({
          ns: ref.ns,
          slug: ref.slug,
          markdown,
          baseRevId: baseRevision ?? null,
          author,
          comment: comment ?? "",
          authorize: async (page) => {
            const can = (action: "edit" | "create" | "delete") => cube.config.auth?.can
              ? cube.config.auth.can(opts.user ?? null, action, page)
              : defaultCan(opts.user ?? null, action, page);
            return await can(page.exists ? "edit" : "create") && (!page.deleted || await can("delete"));
          },
        });
        return text({ revision: result.revId, noop: result.noop, merged: result.merged, warnings: result.issues });
      } catch (e) {
        // Line-accurate issues as tool results so the model can fix and retry.
        if (e instanceof CubeValidationError) return text({ validationErrors: e.issues });
        if (e instanceof CubeAuthorizationError) return text({ error: "forbidden" });
        if (e instanceof CubeConflictError) {
          return text({ conflict: { head: e.currentRevId, headContent: e.currentContent } });
        }
        throw e;
      }
    };

    server.registerTool(
      "create_page",
      {
        description: "Create a new wiki page from markdown (validated; component tags must match list_components schemas).",
        inputSchema: { title: z.string(), markdown: z.string(), comment: z.string().optional() },
      },
      writeHandler,
    );

    server.registerTool(
      "update_page",
      {
        description:
          "Update an existing page. Pass baseRevision from get_page; a stale base merges cleanly or returns the conflict.",
        inputSchema: {
          title: z.string(),
          markdown: z.string(),
          comment: z.string().optional(),
          baseRevision: z.number().int(),
        },
      },
      writeHandler,
    );
  }

  return server;
}
