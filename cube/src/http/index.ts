/**
 * The HTTP API: pure fetch-standard handlers, mountable in any framework
 * (Next: `export const { GET, POST, PUT, DELETE } = cube.handlers`).
 *
 * Titles travel as query params (?title=), never path segments: wiki titles
 * contain slashes, so path-embedding is ambiguous. One error envelope
 * everywhere, with the save pipeline's line-accurate issues on 422.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { defaultCan, type CubeAction, type CubeUser } from "../auth/native";
import { diffRevisions } from "../diff";
import { CubeAuthorizationError, CubeConflictError, CubeValidationError, type Issue } from "../issues";
import {
  CubeMediaError,
  deleteMedia,
  getMedia,
  listMediaRevisions,
  searchMedia,
  uploadMedia,
} from "../media";
import {
  CubeModerationError,
  blockUser,
  listRecentChanges,
  massRevert,
  protectPage,
  setPageVisibility,
  unblockUser,
} from "../moderation";
import { CubeQueryError, type ObjectQuery } from "../query";
import type { Cube } from "../index";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type CubeHandlers = Record<Method, (req: Request) => Promise<Response>>;

type AuthResult = {
  user: CubeUser | null;
  via: "session" | "token" | "anon";
  scopes: Set<string>;
};

const SESSION_SCOPES = ["read", "query"];
const SESSION_WRITE_SCOPES = ["read", "query", "write", "media"];

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function err(code: string, status: number, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: { code, status, message, ...extra } }, status);
}

function issueError(issues: Issue[], status = 422): Response {
  const errors = issues.filter((i) => i.severity === "error");
  return json(
    {
      error: {
        code: "validation_failed",
        status,
        message: `${errors.length} issue${errors.length === 1 ? "" : "s"} in markdown`,
        issues,
      },
    },
    status,
  );
}

export function createHandlers(cube: Cube): CubeHandlers {
  const handle = async (req: Request): Promise<Response> => {
    try {
      return await route(cube, req);
    } catch (e) {
      if (e instanceof CubeValidationError) return issueError(e.issues);
      if (e instanceof CubeAuthorizationError) return err("forbidden", 403, e.message);
      if (e instanceof CubeConflictError) {
        return json(
          {
            error: {
              code: "conflict",
              status: 409,
              message: e.message,
              head: e.currentRevId,
              headContent: e.currentContent,
              baseContent: e.baseContent,
            },
          },
          409,
        );
      }
      if (e instanceof CubeQueryError) return err("bad_query", 422, e.message);
      if (e instanceof CubeMediaError) return err(e.code, e.status, e.message);
      if (e instanceof CubeModerationError) return err(e.code, e.status, e.message);
      return err("internal", 500, e instanceof Error ? e.message : "internal error");
    }
  };
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}

async function route(cube: Cube, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const base = cube.config.site?.apiBasePath ?? "/api/cube";
  let path = url.pathname;
  if (path.startsWith(base)) path = path.slice(base.length);
  path = path.replace(/\/+$/, "") || "/";
  const method = req.method as Method;

  const auth = await authenticate(cube, req);

  // CSRF: cookie-session non-GET requests must be same-origin fetches.
  if (auth.via === "session" && method !== "GET") {
    if (req.headers.get("sec-fetch-site") !== "same-origin") {
      return err("forbidden", 403, "cross-origin request rejected (Sec-Fetch-Site)");
    }
  }

  const can = async (action: CubeAction, page?: Parameters<typeof defaultCan>[2]) => {
    const adapter = cube.config.auth;
    if (adapter?.can) return adapter.can(auth.user, action, page);
    return defaultCan(auth.user, action, page);
  };
  const requireScope = (scope: string): Response | null =>
    auth.scopes.has(scope) ? null : err("forbidden", 403, `missing scope: ${scope}`);
  // Read gate for the revision/diff/history endpoints, which fetch content by
  // id rather than title: honor page `visibility`, and treat soft-deleted
  // pages as moderator-only so they 404 for everyone else. Without this these
  // routes are a back door around the visibility control that /page enforces.
  const canReadPage = async (
    page: { ns: string; slug: string; visibility?: "public" | "moderator" },
    deleted = false,
  ): Promise<boolean> => {
    if (!(await can("read", page))) return false;
    if (deleted && !(await can("delete", page))) return false;
    return true;
  };

  /* ---- auth ---- */
  if (path === "/auth/login" && method === "POST") {
    const adapter = cube.config.auth;
    if (!adapter?.login) return err("bad_request", 400, "login not supported by this site");
    const body = (await req.json().catch(() => null)) as { name?: string; password?: string } | null;
    if (!body?.name || !body?.password) return err("bad_request", 400, "name and password required");
    const result = await adapter.login({ name: body.name, password: body.password }, req);
    if (!result) return err("unauthorized", 401, "invalid credentials");
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of result.setCookies) headers.append("set-cookie", c);
    return new Response(JSON.stringify({ user: result.user }), { status: 200, headers });
  }
  if (path === "/auth/logout" && method === "POST") {
    const adapter = cube.config.auth;
    if (!adapter?.logout) return json({ ok: true });
    const result = await adapter.logout(req);
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of result.setCookies) headers.append("set-cookie", c);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }
  if (path === "/auth/me" && method === "GET") {
    return json({ user: auth.user });
  }

  /* ---- pages ---- */
  if (path === "/page") {
    const title = url.searchParams.get("title");
    if (!title) return err("bad_request", 400, "title required");
    const { normalizeTitle, isTitleError } = await import("../slug");
    const ref = normalizeTitle(title, cube.slug);
    if (isTitleError(ref)) return err("bad_request", 400, `invalid title: ${ref.error}`);

    if (method === "GET") {
      const follow = url.searchParams.get("redirect") !== "no";
      const resolved = follow ? await cube.api.resolve(title) : null;
      const target = resolved ?? { ns: ref.ns, slug: ref.slug };
      const revId = url.searchParams.get("rev");
      const page = await cube.api.getPage(target, revId ? { revId: Number(revId) } : {});
      if (!page) return err("not_found", 404, "no such page");
      if (!(await can("read", page))) return err("not_found", 404, "no such page");
      const format = url.searchParams.get("format");
      const body: Record<string, unknown> = {
        ns: page.ns,
        slug: page.slug,
        title: page.title,
        displayTitle: page.displayTitle,
        markdown: page.markdown,
        revision: page.revId,
        isRedirect: page.isRedirect,
        updatedAt: page.updatedAt,
        ...(resolved?.redirectedFrom && { redirectedFrom: resolved.redirectedFrom }),
      };
      if (format === "ast") {
        const { parseDocument } = await import("../parse");
        body.ast = parseDocument(page.markdown).root;
      }
      return json(body);
    }

    if (method === "PUT") {
      // Writes never follow redirects: editing a redirect edits the redirect.
      const scopeErr = requireScope("write");
      if (scopeErr) return scopeErr;
      const existing = await cube.api.getPage(ref);
      const action: CubeAction = existing ? "edit" : "create";
      if (!(await can(action, existing ?? { ns: ref.ns, slug: ref.slug }))) {
        return err("forbidden", 403, `not allowed to ${action} this page`);
      }
      const body = await readWriteBody(req);
      if (body instanceof Response) return body;
      const result = await cube.api.savePage({
        ns: ref.ns,
        slug: ref.slug,
        markdown: body.markdown,
        baseRevId: body.baseRevision ?? null,
        author: authorOf(auth),
        comment: body.comment ?? "",
        minor: body.minor ?? false,
        authorize: async (page) => await can(page.exists ? "edit" : "create", page) &&
          (!page.deleted || await can("delete", page)),
      });
      return json(
        {
          revision: result.revId,
          noop: result.noop,
          merged: result.merged,
          issues: result.issues,
        },
        existing ? 200 : 201,
      );
    }

    if (method === "DELETE") {
      const scopeErr = requireScope("write");
      if (scopeErr) return scopeErr;
      const page = await cube.api.getPage(ref);
      if (!page) return err("not_found", 404, "no such page");
      if (!(await can("delete", page))) return err("forbidden", 403, "not allowed to delete");
      const body = (await req.json().catch(() => ({}))) as { reason?: string };
      await cube.api.deletePage({ ns: ref.ns, slug: ref.slug, actor: authorOf(auth), reason: body.reason });
      return json({ ok: true });
    }
  }

  if (path === "/page/move" && method === "POST") {
    const scopeErr = requireScope("write");
    if (scopeErr) return scopeErr;
    const body = (await req.json().catch(() => null)) as
      | { from?: string; to?: string; leaveRedirect?: boolean }
      | null;
    if (!body?.from || !body?.to) return err("bad_request", 400, "from and to required");
    const from = await cube.api.resolve(body.from);
    if (!from) return err("not_found", 404, "no such page");
    const fromRef = from.redirectedFrom ?? from;
    const page = await cube.api.getPage(fromRef);
    if (!page) return err("not_found", 404, "no such page");
    if (!(await can("move", page))) return err("forbidden", 403, "not allowed to move");
    const { normalizeTitle, isTitleError } = await import("../slug");
    const to = normalizeTitle(body.to, cube.slug);
    if (isTitleError(to)) return err("bad_request", 400, `invalid target title: ${to.error}`);
    await cube.api.movePage({
      from: fromRef,
      to: { ns: to.ns, slug: to.slug },
      actor: authorOf(auth),
      leaveRedirect: body.leaveRedirect,
    });
    return json({ ok: true, to: { ns: to.ns, slug: to.slug } });
  }

  if (path === "/resolve" && method === "GET") {
    const title = url.searchParams.get("title");
    if (!title) return err("bad_request", 400, "title required");
    const resolved = await cube.api.resolve(title);
    return resolved ? json(resolved) : err("not_found", 404, "no such page");
  }

  if (path === "/revisions" && method === "GET") {
    const title = url.searchParams.get("title");
    if (!title) return err("bad_request", 400, "title required");
    const resolved = await cube.api.resolve(title);
    if (!resolved) return err("not_found", 404, "no such page");
    const ref = resolved.redirectedFrom ?? resolved;
    const page = await cube.api.getPage(ref);
    if (!page || !(await canReadPage(page))) return err("not_found", 404, "no such page");
    const revisions = await cube.api.listRevisions(ref, {
      limit: numParam(url, "limit"),
      before: numParam(url, "before"),
    });
    return json({ revisions });
  }

  const revMatch = /^\/revision\/(\d+)$/.exec(path);
  if (revMatch && method === "GET") {
    const rev = await cube.api.getRevision(Number(revMatch[1]));
    if (!rev) return err("not_found", 404, "no such revision");
    if (!(await canReadPage({ ns: rev.ns, slug: rev.slug, visibility: rev.visibility }, rev.deletedAt !== null))) {
      return err("not_found", 404, "no such revision");
    }
    return json(rev);
  }

  if (path === "/diff" && method === "GET") {
    const from = numParam(url, "from");
    const to = numParam(url, "to");
    if (!from || !to) return err("bad_request", 400, "from and to revision ids required");
    const diff = await diffRevisions(cube.pool(), from, to);
    if (!diff) return err("not_found", 404, "no such revisions");
    for (const p of [diff.pages.from, diff.pages.to]) {
      if (!(await canReadPage(p, p.deleted))) return err("not_found", 404, "no such revisions");
    }
    return json(diff);
  }

  if (path === "/search" && method === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return err("bad_request", 400, "q required");
    const hits = await cube.api.search(q, {
      ns: url.searchParams.get("ns") ?? undefined,
      limit: numParam(url, "limit"),
    });
    return json({ hits });
  }

  if (path === "/query" && method === "POST") {
    const scopeErr = requireScope("query");
    if (scopeErr) return scopeErr;
    const q = (await req.json().catch(() => null)) as ObjectQuery | null;
    if (!q || typeof q !== "object") return err("bad_request", 400, "query body required");
    const includeHidden = (auth.user?.roles ?? []).some((r) => r === "moderator" || r === "sysop");
    const result = await cube.api.queryObjects(q, { includeHidden });
    return json(result);
  }

  if (path === "/components" && method === "GET") {
    return json({ components: cube.api.listComponents() });
  }

  if (path === "/validate" && method === "POST") {
    const body = (await req.json().catch(() => null)) as { title?: string; markdown?: string } | null;
    if (!body?.markdown) return err("bad_request", 400, "markdown required");
    const issues = await cube.api.validateMarkdown(
      { ns: "main", slug: body.title ?? "Preview" },
      body.markdown,
    );
    return json({ issues });
  }

  /* ---- media ---- */
  if (path === "/media" && method === "POST") {
    const scopeErr = requireScope("media");
    if (scopeErr) return scopeErr;
    if (!(await can("upload"))) return err("forbidden", 403, "not allowed to upload");
    const storage = cube.config.storage;
    if (!storage) return err("no_storage", 501, "no storage adapter configured");
    const name = url.searchParams.get("name");
    if (!name) return err("bad_request", 400, "name required");
    const result = await uploadMedia(cube.pool(), storage, {
      name,
      body: new Uint8Array(await req.arrayBuffer()),
      contentType: req.headers.get("content-type") ?? undefined,
      uploader: authorOf(auth),
    });
    return json(
      { name: result.name, sha256: result.sha256, size: result.size },
      result.created ? 201 : 200,
    );
  }

  if (path === "/media/info" && method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return err("bad_request", 400, "name required");
    const media = await getMedia(cube.pool(), name);
    if (!media) return err("not_found", 404, "no such media");
    const revisions = await listMediaRevisions(cube.pool(), name);
    return json({ ...media, revisions });
  }

  if (path === "/media/file" && method === "GET") {
    const name = url.searchParams.get("name");
    if (!name) return err("bad_request", 400, "name required");
    const storage = cube.config.storage;
    if (!storage) return err("no_storage", 501, "no storage adapter configured");
    const media = await getMedia(cube.pool(), name);
    if (!media) return err("not_found", 404, "no such media");
    const publicUrl = storage.publicUrl(media.storageKey);
    if (publicUrl) return new Response(null, { status: 302, headers: { location: publicUrl } });
    const blob = await storage.get(media.storageKey);
    if (!blob) return err("not_found", 404, "media blob missing from storage");
    const contentType = media.mime ?? blob.contentType ?? "application/octet-stream";
    const headers: Record<string, string> = { "content-type": contentType };
    const size = media.size ?? blob.size;
    if (size != null) headers["content-length"] = String(size);
    if (!/^(image|video|audio)\//.test(contentType)) {
      headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(media.name)}`;
    }
    return new Response(Readable.toWeb(blob.body) as unknown as ReadableStream, { status: 200, headers });
  }

  if (path === "/media/search" && method === "GET") {
    const q = url.searchParams.get("q");
    if (!q) return err("bad_request", 400, "q required");
    const hits = await searchMedia(cube.pool(), q, numParam(url, "limit") ?? 20);
    return json({ hits });
  }

  if (path === "/media" && method === "DELETE") {
    const scopeErr = requireScope("media");
    if (scopeErr) return scopeErr;
    const name = url.searchParams.get("name");
    if (!name) return err("bad_request", 400, "name required");
    if (!(await can("delete"))) return err("forbidden", 403, "not allowed to delete media");
    const body = (await req.json().catch(() => ({}))) as { force?: boolean };
    await deleteMedia(cube.pool(), { name, actor: authorOf(auth), force: body.force === true });
    return json({ ok: true });
  }

  /* ---- moderation ---- */
  if (path === "/moderation/protect" && method === "POST") {
    const scopeErr = requireScope("write");
    if (scopeErr) return scopeErr;
    const body = (await req.json().catch(() => null)) as
      | { title?: string; protection?: Record<string, string> }
      | null;
    if (!body?.title || typeof body.protection !== "object" || body.protection === null) {
      return err("bad_request", 400, "title and protection object required");
    }
    const { normalizeTitle, isTitleError } = await import("../slug");
    const ref = normalizeTitle(body.title, cube.slug);
    if (isTitleError(ref)) return err("bad_request", 400, `invalid title: ${ref.error}`);
    const page = await cube.api.getPage(ref);
    if (!page) return err("not_found", 404, "no such page");
    if (!(await can("protect", page))) return err("forbidden", 403, "not allowed to protect");
    await protectPage(cube.pool(), {
      ns: ref.ns,
      slug: ref.slug,
      protection: body.protection,
      actor: authorOf(auth),
    });
    return json({ ok: true });
  }

  if (path === "/moderation/visibility" && method === "POST") {
    const scopeErr = requireScope("write");
    if (scopeErr) return scopeErr;
    const body = (await req.json().catch(() => null)) as
      | { title?: string; visibility?: "public" | "moderator" }
      | null;
    if (!body?.title || !body.visibility) return err("bad_request", 400, "title and visibility required");
    const { normalizeTitle, isTitleError } = await import("../slug");
    const ref = normalizeTitle(body.title, cube.slug);
    if (isTitleError(ref)) return err("bad_request", 400, `invalid title: ${ref.error}`);
    const page = await cube.api.getPage(ref);
    if (!page) return err("not_found", 404, "no such page");
    if (!(await can("protect", page))) return err("forbidden", 403, "not allowed to change visibility");
    await setPageVisibility(cube.pool(), {
      ns: ref.ns,
      slug: ref.slug,
      visibility: body.visibility,
      actor: authorOf(auth),
    });
    return json({ ok: true });
  }

  if (path === "/moderation/block" && method === "POST") {
    const scopeErr = requireScope("write");
    if (scopeErr) return scopeErr;
    if (!(await can("admin"))) return err("forbidden", 403, "not allowed to block users");
    const body = (await req.json().catch(() => null)) as { name?: string; reason?: string } | null;
    if (!body?.name) return err("bad_request", 400, "name required");
    await blockUser(cube.pool(), { name: body.name, reason: body.reason, actor: authorOf(auth) });
    return json({ ok: true });
  }

  if (path === "/moderation/unblock" && method === "POST") {
    const scopeErr = requireScope("write");
    if (scopeErr) return scopeErr;
    if (!(await can("admin"))) return err("forbidden", 403, "not allowed to unblock users");
    const body = (await req.json().catch(() => null)) as { name?: string } | null;
    if (!body?.name) return err("bad_request", 400, "name required");
    await unblockUser(cube.pool(), { name: body.name, actor: authorOf(auth) });
    return json({ ok: true });
  }

  if (path === "/moderation/mass-revert" && method === "POST") {
    const scopeErr = requireScope("write");
    if (scopeErr) return scopeErr;
    if (!(await can("admin"))) return err("forbidden", 403, "not allowed to mass-revert");
    const body = (await req.json().catch(() => null)) as
      | { user?: string; sinceHours?: number; comment?: string }
      | null;
    if (!body?.user) return err("bad_request", 400, "user required");
    const sinceHours = Number.isFinite(body.sinceHours) ? (body.sinceHours as number) : 24;
    const result = await massRevert(cube.pool(), cube.saveContext, {
      userName: body.user,
      since: new Date(Date.now() - sinceHours * 3600_000),
      actor: authorOf(auth),
      comment: body.comment,
    });
    return json(result);
  }

  if (path === "/changes" && method === "GET") {
    const changes = await listRecentChanges(cube.pool(), {
      limit: numParam(url, "limit"),
      before: numParam(url, "before"),
      user: url.searchParams.get("user") ?? undefined,
    });
    return json({ changes });
  }

  return err("not_found", 404, `no route: ${method} ${path}`);
}

function numParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function readWriteBody(
  req: Request,
): Promise<{ markdown: string; comment?: string; baseRevision?: number; minor?: boolean } | Response> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.startsWith("text/markdown") || ct.startsWith("text/plain")) {
    return { markdown: await req.text() };
  }
  const body = (await req.json().catch(() => null)) as
    | { markdown?: string; comment?: string; baseRevision?: number; minor?: boolean }
    | null;
  if (!body || typeof body.markdown !== "string") {
    return err("bad_request", 400, "body must be JSON with a markdown field, or raw text/markdown");
  }
  return body as { markdown: string; comment?: string; baseRevision?: number; minor?: boolean };
}

function authorOf(auth: AuthResult): { id: number | null; name: string } {
  if (auth.user) return { id: auth.user.id, name: auth.user.name };
  return { id: null, name: "Anonymous" };
}

async function authenticate(cube: Cube, req: Request): Promise<AuthResult> {
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ")) {
    const token = bearer.slice(7).trim();
    const result = await verifyToken(cube.pool(), token);
    if (result) return result;
    return { user: null, via: "anon", scopes: new Set() };
  }
  const adapter = cube.config.auth;
  if (adapter) {
    const user = await adapter.getUser({ headers: req.headers });
    if (user) {
      const isModerator = user.roles.some((r) => r === "moderator" || r === "sysop");
      return {
        user,
        via: "session",
        scopes: new Set(isModerator ? [...SESSION_WRITE_SCOPES, "admin"] : SESSION_WRITE_SCOPES),
      };
    }
  }
  return { user: null, via: "anon", scopes: new Set(SESSION_SCOPES) };
}

/** Token format: cube_<id>_<secret>; DB stores sha256 of the whole string. */
async function verifyToken(pool: Pool, token: string): Promise<AuthResult | null> {
  const m = /^cube_(\d+)_[A-Za-z0-9_-]+$/.exec(token);
  if (!m) return null;
  const res = await pool.query(
    `SELECT t.id, t.name, t.token_sha256, t.scopes, t.user_id, t.expires_at, u.blocked_at
       FROM cube_token t LEFT JOIN cube_user u ON u.id = t.user_id
      WHERE t.id = $1`,
    [Number(m[1])],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  // A blocked user's tokens must stop working, mirroring the cookie path.
  if (row.user_id !== null && row.blocked_at !== null) return null;
  const actual = createHash("sha256").update(token).digest();
  const expected = Buffer.from(row.token_sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  void pool.query(`UPDATE cube_token SET last_used = now() WHERE id = $1`, [row.id]).catch(() => {});
  return {
    user: { id: row.user_id === null ? 0 : Number(row.user_id), name: `token:${row.name}`, roles: row.scopes.includes("admin") ? ["moderator"] : [] },
    via: "token",
    scopes: new Set(row.scopes),
  };
}

/** Mint a scoped API token; the raw value is shown exactly once. */
export async function createToken(
  pool: Pool,
  input: { name: string; scopes: string[]; userId?: number; expiresAt?: Date },
): Promise<{ id: number; token: string }> {
  const { randomBytes } = await import("node:crypto");
  const placeholder = await pool.query(
    `INSERT INTO cube_token (name, token_sha256, scopes, user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.name, `pending-${randomBytes(16).toString("hex")}`, input.scopes, input.userId ?? null, input.expiresAt ?? null],
  );
  const id = Number(placeholder.rows[0].id);
  const token = `cube_${id}_${randomBytes(24).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await pool.query(`UPDATE cube_token SET token_sha256 = $2 WHERE id = $1`, [id, hash]);
  return { id, token };
}
