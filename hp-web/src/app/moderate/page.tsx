"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { buildHref } from "@/lib/slug";

interface Submission {
  sha256: string;
  nickname: string;
  status: string;
  kind: string;
  submitted_at: string;
  reviewed_at: string | null;
  name: string;
  system: string;
  file_count: number | null;
  lot: string | null;
  photo_sha256: string | null;
  photo_url: string | null;
}

// Each filter is its own URL (?status=accepted) so the accepted list can be
// linked and bookmarked, not just clicked into. "all" is a UI label only: the
// API takes no status at all for it.
const FILTERS = ["queued", "accepted", "rejected", "all"] as const;

interface Whoami {
  moderator: boolean;
  name?: string;
  via?: "token" | "wiki";
}

function Moderate() {
  const params = useSearchParams();
  const raw = params.get("status") ?? "queued";
  const filter = (FILTERS as readonly string[]).includes(raw) ? raw : "queued";
  const status = filter === "all" ? "" : filter;
  const [items, setItems] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [token, setToken] = useState<string>("");
  const [whoami, setWhoami] = useState<Whoami | null>(null);

  // Remember the moderation token locally so it isn't retyped each visit.
  useEffect(() => {
    setToken(sessionStorage.getItem("prism-mod-token") ?? "");
  }, []);
  function saveToken(t: string) {
    setToken(t);
    sessionStorage.setItem("prism-mod-token", t);
  }
  const authHeaders = useCallback(
    (extra: Record<string, string> = {}) => (token ? { ...extra, "x-moderation-token": token } : extra),
    [token],
  );

  // Who does the server think we are? Wiki session cookies ride along
  // automatically; the token header is attached when one is saved.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/whoami", { headers: authHeaders(), cache: "no-store" })
      .then((r) => r.json())
      .then((w: Whoami) => !cancelled && setWhoami(w))
      .catch(() => !cancelled && setWhoami({ moderator: false }));
    return () => {
      cancelled = true;
    };
  }, [authHeaders]);

  const load = useCallback(async (s: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/submissions${s ? `?status=${s}` : ""}`, { headers: authHeaders() });
      if (res.status === 401) {
        setItems([]);
        setNote("Unauthorized — log in with your wiki account or enter a moderation token.");
        return;
      }
      const data = await res.json();
      setItems(data.submissions ?? []);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => {
    void load(status);
  }, [load, status]);

  async function moderate(sha256: string, action: "accept" | "reject") {
    setBusy(sha256);
    setNote("");
    try {
      const res = await fetch(`/api/submissions/${sha256}`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      setNote(res.ok ? `${action === "accept" ? "Accepted" : "Rejected"} ${sha256.slice(0, 12)}…` : `Error: ${data.error}`);
      await load(status);
    } catch (e) {
      setNote(`Failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Moderation</h1>
        <Link href="/" className="text-sm text-neutral-500 hover:underline">Search &rarr;</Link>
      </div>
      <p className="mt-1 text-sm text-neutral-500">
        Review contributor submissions. Accepting ingests the build into the library
        as private (unlisted); publish it from the build page when it is ready.
        Accepting a <span className="font-medium">duplicate</span> records the submitted
        name on the existing build instead of replacing it.
        While you are signed in, build pages also show moderator tools (rename, lot).
      </p>

      {whoami?.moderator && whoami.via === "wiki" ? (
        <p className="mt-5 text-sm text-neutral-600 dark:text-neutral-300">
          Signed in as <span className="font-medium">{whoami.name}</span> via your wiki account.
        </p>
      ) : (
        <>
          {whoami && !whoami.moderator && whoami.name && (
            <p className="mt-5 text-sm text-amber-600">
              Signed in to the wiki as {whoami.name}, but that account is not in a moderator group.
            </p>
          )}
          {whoami && !whoami.moderator && !whoami.name && (
            <p className="mt-5 text-sm text-neutral-500">
              <a href="/wiki/Special:UserLogin" className="underline">Log in with your wiki account</a>
              {" "}or enter a moderation token below.
            </p>
          )}
          <input
            type="password"
            value={token}
            onChange={(e) => saveToken(e.target.value)}
            onBlur={() => load(status)}
            placeholder="moderation token (x-moderation-token)"
            className="mt-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900"
          />
        </>
      )}

      <div className="mt-4 flex gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/moderate?status=${f}`}
            className={`rounded-md px-3 py-1 text-sm ${
              filter === f
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "border border-neutral-300 dark:border-neutral-700"
            }`}
          >
            {f}
          </Link>
        ))}
      </div>

      {note && <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">{note}</p>}

      <div className="mt-4">
        {loading && <p className="text-sm text-neutral-500">Loading…</p>}
        {!loading && items.length === 0 && <p className="text-sm text-neutral-500">Nothing here.</p>}
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {items.map((s) => (
            <li key={s.sha256} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <Link href={buildHref(s.sha256, s.name ?? "")} className="font-medium hover:underline">
                  {s.name ?? s.sha256}
                </Link>
                <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-neutral-500">
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{s.system ?? "?"}</span>
                  <span>{s.file_count ?? "?"} files</span>
                  <span>by {s.nickname}</span>
                  <span className="font-mono">{s.sha256.slice(0, 12)}…</span>
                  {s.kind === "duplicate" && (
                    <span
                      title="This image is already in the library under a different name. Accept records this name as a duplicate; the existing build is not replaced."
                      className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200"
                    >
                      duplicate
                    </span>
                  )}
                  {s.lot && (
                    <Link
                      href={`/builds?lot=${encodeURIComponent(s.lot)}`}
                      className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 hover:underline dark:bg-amber-900/40 dark:text-amber-200"
                    >
                      {s.lot}
                    </Link>
                  )}
                  <StatusBadge status={s.status} />
                </div>
              </div>
              {s.status === "queued" && (
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => moderate(s.sha256, "accept")}
                    disabled={busy === s.sha256}
                    className="rounded-md bg-green-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => moderate(s.sha256, "reject")}
                    disabled={busy === s.sha256}
                    className="rounded-md border border-red-400 px-3 py-1 text-sm font-medium text-red-600 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
              {s.photo_sha256 && (
                <a
                  href={s.photo_url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  title="Front photo of the physical media"
                  className="shrink-0"
                >
                  {/* Photos are multi-MB scans: draw the cell from the server-scaled
                      thumb (lanczos), not the original. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/media/${s.photo_sha256}/thumb?w=500`}
                    alt="Front photo"
                    loading="lazy"
                    className="h-14 w-14 rounded-md border border-neutral-200 object-cover dark:border-neutral-800"
                  />
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

export default function ModeratePage() {
  return (
    <Suspense>
      <Moderate />
    </Suspense>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tint =
    status === "accepted" ? "text-green-600" : status === "rejected" ? "text-red-500" : "text-amber-600";
  return <span className={`font-medium ${tint}`}>{status}</span>;
}
