/** Admission is process-wide, before database lookup or password hashing. */
export class CubeLoginRateLimitError extends Error {
  constructor(readonly retryAfter: number) { super("too many login attempts"); }
}

export class LoginAdmission {
  private tokens = 20;
  private updated: number;
  private readonly accounts = new Map<string, { count: number; expires: number }>();
  constructor(private readonly clock: () => number = Date.now) { this.updated = clock(); }

  admit(account: string): void {
    const now = this.clock();
    this.tokens = Math.min(20, this.tokens + Math.max(0, now - this.updated) / 1000);
    this.updated = now;
    for (const [key, value] of this.accounts) if (value.expires <= now) this.accounts.delete(key);
    const current = this.accounts.get(account);
    if (current && current.count >= 5) {
      throw new CubeLoginRateLimitError(Math.max(1, Math.ceil((current.expires - now) / 1000)));
    }
    if (this.tokens < 1 || (!current && this.accounts.size >= 1000)) {
      throw new CubeLoginRateLimitError(1);
    }
    this.tokens -= 1;
    this.accounts.set(account, { count: (current?.count ?? 0) + 1, expires: current?.expires ?? now + 60_000 });
  }
}

// Each server process has its own finite allowance; reverse-proxy headers are
// deliberately not trusted as an identity. Success does not reset admission.
export const loginAdmission = new LoginAdmission();
