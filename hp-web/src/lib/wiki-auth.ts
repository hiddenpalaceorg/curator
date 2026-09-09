import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";

/** A wiki account resolved from the incoming request's session cookies. */
export interface WikiUser {
  id: number;
  name: string;
  groups: string[];
}

/** Base URL of the MediaWiki api.php (env WIKI_API_URL); unset disables wiki login. */
export function wikiApiUrl(): string | undefined {
  return process.env.WIKI_API_URL || undefined;
}

/** Wiki groups whose members may moderate (env MODERATION_WIKI_GROUPS, comma-separated). */
export function moderatorGroups(): string[] {
  return (process.env.MODERATION_WIKI_GROUPS ?? "sysop")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function cookiePrefix(): string {
  return process.env.WIKI_COOKIE_PREFIX ?? "hp_wiki_new";
}

// The app shares the hiddenpalace.org origin with the wiki, whose session
// cookies are set with path=/, so they ride along on every request to us.
// A session is validated by forwarding the cookies to the wiki's own
// userinfo API; verdicts are cached briefly so page loads don't hammer it.
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expires: number; user: WikiUser | null }>();
const pending = new Map<string, Promise<WikiUser | null>>();
let starts = 20;
let updated = Date.now();

function sessionCookies(header: string, prefix: string): string | null {
  if (header.length > 16_384) return null;
  const names = [`${prefix}_session`, `${prefix}Token`, `${prefix}UserID`, `${prefix}UserName`];
  const found = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!names.includes(name)) continue;
    if (found.has(name)) return null;
    found.set(name, part.slice(eq + 1).trim());
  }
  if (!found.get(names[0]) && !found.get(names[1])) return null;
  return names.filter((name) => found.has(name)).map((name) => `${name}=${found.get(name)}`).join("; ");
}

/** Resolve the wiki user behind a Cookie header, or null (anon/invalid/disabled). */
export async function wikiUserFromCookies(cookieHeader: string | null): Promise<WikiUser | null> {
  const api = wikiApiUrl();
  if (!api || !cookieHeader) return null;
  // Skip the API round-trip unless a wiki session or remember-me cookie is present.
  const cookies = sessionCookies(cookieHeader, cookiePrefix());
  if (!cookies) return null;
  const host = process.env.WIKI_API_HOST;
  const key = createHash("sha256").update(JSON.stringify([api, host, cookies])).digest("base64");
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.user;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  starts = Math.min(20, starts + Math.max(0, now - updated) / 200);
  updated = now;
  // Process-wide admission: no unbounded queue or caller-controlled identity.
  if (starts < 1 || pending.size >= 8) return null;
  starts -= 1;
  const work = queryUserinfo(api, cookies, host).catch(() => null).then((user) => {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, user });
    return user;
  }).finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}

// node:http rather than fetch: undici strips custom Host headers, and
// WIKI_API_HOST needs one (on the server the wiki is reached by IP without
// leaving the box, with the vhost picked by Host).
async function queryUserinfo(api: string, cookieHeader: string, host?: string): Promise<WikiUser | null> {
  const url = new URL(api);
  url.search = new URLSearchParams({
    action: "query",
    meta: "userinfo",
    uiprop: "groups",
    format: "json",
  }).toString();
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let done = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (user: WikiUser | null) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve(user);
    };
    const req = request(
      url,
      {
        headers: {
          Cookie: cookieHeader,
          ...(host ? { Host: host } : {}),
        },
        timeout: 4000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) { res.destroy(); req.destroy(); finish(null); return; }
          chunks.push(chunk);
        });
        res.on("error", () => finish(null));
        res.on("aborted", () => finish(null));
        res.on("end", () => {
          if (done || res.statusCode !== 200) { finish(null); return; }
          try {
            const info = JSON.parse(Buffer.concat(chunks, size).toString("utf8"))?.query?.userinfo;
            finish(
              info && info.id > 0
                ? { id: info.id, name: info.name, groups: info.groups ?? [] }
                : null,
            );
          } catch {
            finish(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => finish(null));
    deadline = setTimeout(() => { req.destroy(); finish(null); }, 4000);
    req.end();
  });
}
