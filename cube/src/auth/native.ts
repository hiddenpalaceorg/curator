/**
 * The default auth adapter (cube_user/cube_session tables): what the Hidden
 * Palace site uses. Auth stays a pluggable seam: hosts with their own
 * accounts implement CubeAuthAdapter instead.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, needsRehash, verifyPassword } from "./passwords";
import { loginAdmission } from "./login-limit";

export type CubeUser = {
  id: number;
  name: string;
  roles: string[];
};

export type CubeAction = "read" | "edit" | "create" | "move" | "delete" | "upload" | "protect" | "admin";

export type PagePolicyInput = {
  ns: string;
  slug: string;
  visibility?: "public" | "moderator";
  protection?: Record<string, string>;
};

export type CubeAuthAdapter = {
  /** Ambient session -> user; null = anonymous. */
  getUser(req: { headers: Headers }): Promise<CubeUser | null>;
  /** Capability check; cube falls back to defaultCan when omitted. */
  can?(user: CubeUser | null, action: CubeAction, page?: PagePolicyInput): boolean | Promise<boolean>;
  login?(
    creds: { name: string; password: string },
    req: Request,
  ): Promise<{ user: CubeUser; setCookies: string[] } | null>;
  logout?(req: Request): Promise<{ setCookies: string[] }>;
};

/** Anonymous read, logged-in write, moderators for destructive/protected ops. */
export function defaultCan(user: CubeUser | null, action: CubeAction, page?: PagePolicyInput): boolean {
  const isModerator = user?.roles.some((r) => r === "moderator" || r === "sysop") ?? false;
  if (page?.visibility === "moderator" && !isModerator) return false;
  switch (action) {
    case "read":
      return true;
    case "edit":
    case "create":
    case "upload": {
      if (user === null) return false;
      const editLevel = page?.protection?.edit;
      if (editLevel === "moderator" && !isModerator) return false;
      return true;
    }
    case "move":
    case "delete":
    case "protect":
    case "admin":
      return isModerator;
  }
}

export type NativeAuthOptions = {
  pool: Pool | (() => Pool);
  cookieName?: string;
  sessionTtlDays?: number;
  /** Set the Secure cookie flag (default true; disable for local dev). */
  secure?: boolean;
};

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// A fixed valid scrypt hash, computed once, used only to spend the same work on
// the login miss path as a real password verify (see login()).
let DUMMY_HASH: string | null = null;
function dummyHash(): string {
  if (DUMMY_HASH === null) DUMMY_HASH = hashPassword("cube-timing-equalizer");
  return DUMMY_HASH;
}

/** MW-compatible username canonicalization: trim, collapse spaces, ucfirst. */
export function canonicalUsername(name: string): string {
  const t = name.replace(/[_\s]+/g, " ").trim();
  if (t === "") return t;
  const first = String.fromCodePoint(t.codePointAt(0)!);
  const upper = first.toUpperCase();
  return upper !== first && [...upper].length === 1 ? upper + t.slice(first.length) : t;
}

export function cubeNativeAuth(opts: NativeAuthOptions): CubeAuthAdapter {
  const pool = typeof opts.pool === "function" ? opts.pool : () => opts.pool as Pool;
  const cookieName = opts.cookieName ?? "cube_session";
  const ttlMs = (opts.sessionTtlDays ?? 30) * 24 * 3600 * 1000;
  const secure = opts.secure !== false;

  const cookie = (token: string, maxAgeSec: number): string =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${maxAgeSec}`;

  return {
    async getUser(req) {
      const token = tokenFromCookies(req.headers.get("cookie"), cookieName);
      if (!token) return null;
      const res = await pool().query(
        `SELECT u.id, u.name, u.roles, u.blocked_at, s.last_seen
           FROM cube_session s
           JOIN cube_user u ON u.id = s.user_id
          WHERE s.token_sha256 = $1 AND s.expires_at > now()`,
        [sha256hex(token)],
      );
      const row = res.rows[0];
      if (!row || row.blocked_at !== null) return null;
      if (Date.now() - new Date(row.last_seen).getTime() > 3600_000) {
        // Sliding session, updated at most hourly to keep reads cheap.
        void pool()
          .query(
            `UPDATE cube_session SET last_seen = now(), expires_at = now() + $2::interval
              WHERE token_sha256 = $1`,
            [sha256hex(token), `${opts.sessionTtlDays ?? 30} days`],
          )
          .catch(() => {});
      }
      return { id: Number(row.id), name: row.name, roles: row.roles };
    },

    can: defaultCan,

    async login(creds) {
      if (typeof creds.name !== "string" || typeof creds.password !== "string") return null;
      const name = canonicalUsername(creds.name);
      loginAdmission.admit(sha256hex(name));
      const res = await pool().query(
        `SELECT id, name, roles, password_hash, blocked_at FROM cube_user WHERE name = $1`,
        [name],
      );
      const row = res.rows[0];
      if (!row || row.blocked_at !== null) {
        // Run a real verify against a dummy hash so the unknown/blocked-user
        // path costs the same as a wrong password, closing a username-
        // enumeration timing oracle. (Not a substitute for rate limiting.)
        verifyPassword(dummyHash(), creds.password);
        return null;
      }
      if (!verifyPassword(row.password_hash, creds.password)) return null;

      if (row.password_hash && needsRehash(row.password_hash)) {
        await pool().query(`UPDATE cube_user SET password_hash = $2 WHERE id = $1`, [
          row.id,
          hashPassword(creds.password),
        ]);
      }

      const token = randomBytes(32).toString("base64url");
      await pool().query(
        `INSERT INTO cube_session (token_sha256, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(days => $3))`,
        [sha256hex(token), row.id, opts.sessionTtlDays ?? 30],
      );
      return {
        user: { id: Number(row.id), name: row.name, roles: row.roles },
        setCookies: [cookie(token, Math.floor(ttlMs / 1000))],
      };
    },

    async logout(req) {
      const token = tokenFromCookies(req.headers.get("cookie"), cookieName);
      if (token) {
        await pool().query(`DELETE FROM cube_session WHERE token_sha256 = $1`, [sha256hex(token)]);
      }
      return { setCookies: [cookie("", 0)] };
    },
  };
}

function tokenFromCookies(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Registration helper for the HP site (invite/captcha policy is host-side). */
export async function createUser(
  pool: Pool,
  input: { name: string; password: string; email?: string; roles?: string[] },
): Promise<CubeUser> {
  const name = canonicalUsername(input.name);
  if (name === "" || name.length > 255) throw new Error("invalid username");
  const res = await pool.query(
    `INSERT INTO cube_user (name, email, password_hash, roles)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO NOTHING
     RETURNING id, name, roles`,
    [name, input.email ?? null, hashPassword(input.password), input.roles ?? []],
  );
  if (res.rows[0] === undefined) throw new Error("username taken");
  return res.rows[0];
}
