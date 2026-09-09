// Wiki pages at the site root: hiddenpalace.org/<Title> (MW-compatible URLs,
// the site design). Static app segments (/builds, /games, /moderate, /api)
// win by App Router precedence; this catch-all serves everything else.
// Views dispatch on searchParams: ?source, ?rev=N, ?history (edit comes with
// the editor milestone).

import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { canReadResolution, isTitleError, normalizeTitle } from "cube";
import { getModeratorFromHeaders } from "@/lib/auth";
import { getCube, pageHref } from "@/cube/cube";
import { renderWikiMarkdown } from "@/cube/render";
import WikiEditor from "@/components/WikiEditor";

export const dynamic = "force-dynamic";

// Chrome utility stacks (article content is styled in wiki.css).
const LINK = "text-blue-600 hover:underline dark:text-blue-400";
const PRE = "whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 font-mono text-sm dark:border-neutral-800 dark:bg-neutral-900";
const TH = "border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-left dark:border-neutral-800 dark:bg-neutral-900";
const TD = "border border-neutral-200 px-3 py-1.5 dark:border-neutral-800";

// Never let the wiki catch-all shadow app or asset paths.
const RESERVED = new Set([
  "api", "builds", "games", "moderate", "login", "_next", "favicon.ico", "robots.txt",
  "sitemap.xml", "icon.png", "apple-icon.png", "w", "wiki",
]);

type Props = {
  params: Promise<{ slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function titleFromParams(slug: string[]): string | null {
  try {
    return slug.map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null; // malformed percent-encoding (e.g. "%zz")
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (RESERVED.has(slug[0] ?? "")) return {};
  const title = titleFromParams(slug);
  if (title === null) return {};
  const ref = normalizeTitle(title, getCube().slug);
  if (isTitleError(ref)) return {};
  return { title: `${ref.title} - Hidden Palace` };
}

export default async function WikiPage({ params, searchParams }: Props) {
  const { slug } = await params;
  if (slug.length === 0 || RESERVED.has(slug[0]!)) notFound();

  const cube = getCube();
  const title = titleFromParams(slug);
  if (title === null) notFound();
  const ref = normalizeTitle(title, cube.slug);
  if (isTitleError(ref)) notFound();

  const sp0 = await searchParams;
  const editing = sp0.edit !== undefined;

  // ?redirect=no lands on the redirect page itself instead of its target,
  // which is what the "Redirected from" link offers.
  const resolved = await cube.api.resolve(title, {
    followRedirect: !editing && sp0.redirect !== "no",
  });
  if (!resolved) {
    // Missing page: the edit view creates it; readers get a create prompt.
    const user = await cube.config.auth?.getUser({ headers: await headers() });
    const createHref = `/${ref.slug.split("/").map(encodeURIComponent).join("/")}`;
    if (editing) {
      if (!user) {
        return (
          <main>
            <h1 className="mb-4 text-2xl font-semibold">{ref.title}</h1>
            <p className="text-sm">
              This page does not exist yet.{" "}
              <Link className={LINK} href={`/login?next=${encodeURIComponent(`${createHref}?edit`)}`}>
                Log in
              </Link>{" "}
              to create it.
            </p>
          </main>
        );
      }
      return (
        <main>
          <h1 className="mb-4 text-2xl font-semibold">Creating: {ref.title}</h1>
          <WikiEditor
            title={ref.title}
            canonicalHref={createHref}
            initialMarkdown={""}
            baseRevision={null}
            isNew={true}
          />
        </main>
      );
    }
    return (
      <main>
        <h1 className="mb-4 text-2xl font-semibold">{ref.title}</h1>
        <p className="text-sm text-neutral-500">
          This page does not exist.{" "}
          <Link className={LINK} href={`${createHref}?edit`}>
            Create it
          </Link>
          .
        </p>
      </main>
    );
  }

  // Canonicalize display-form URLs to the dbkey form, keeping the view params.
  if (!(await canReadResolution(cube, resolved, async (page) =>
    page.visibility !== "moderator" || !!(await getModeratorFromHeaders(await headers()))))) {
    notFound();
  }
  const canonical = pageHref(resolved.redirectedFrom ?? resolved);
  const requested = `/${slug.map((s) => encodeURIComponent(decodeURIComponent(s))).join("/")}`;
  if (requested !== canonical && (resolved.redirectedFrom ?? resolved).ns === "main") {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(sp0)) {
      // Repeated params (?a=1&a=2) arrive as arrays; append each so the
      // redirect does not silently drop them.
      if (typeof v === "string") search.append(k, v);
      else if (Array.isArray(v)) for (const one of v) search.append(k, one);
      else search.append(k, "");
    }
    const qs = search.toString().replace(/=(?=&|$)/g, "");
    // Temporary, not permanent: the target depends on mutable redirect rows and
    // page titles, and a cached 308 would outlive both.
    redirect(canonical + (qs !== "" ? `?${qs}` : ""));
  }

  const view = editing ? "edit" : sp0.history !== undefined ? "history" : sp0.source !== undefined ? "source" : "read";
  // Only a positive integer selects a revision; anything else reads as "latest"
  // and must not light up the "not current" banner (Number("abc") is NaN, and
  // NaN !== undefined).
  const revNum = typeof sp0.rev === "string" ? Number(sp0.rev) : NaN;
  const revId = Number.isInteger(revNum) && revNum > 0 ? revNum : undefined;

  // Editing never follows redirects: editing a redirect edits the redirect.
  const target = editing ? { ns: ref.ns, slug: ref.slug } : resolved;
  const page = await cube.api.getPage(target, revId !== undefined ? { revId } : {});
  if (!page) notFound();

  if (page.visibility === "moderator") {
    const moderator = await getModeratorFromHeaders(await headers());
    if (!moderator) notFound();
  }

  if (view === "edit") {
    const user = await cube.config.auth?.getUser({ headers: await headers() });
    const editHref = pageHref(target);
    if (!user) {
      return (
        <main>
          <h1 className="mb-4 text-2xl font-semibold">{page.displayTitle ?? page.title}</h1>
          <p className="text-sm">
            <Link className={LINK} href={`/login?next=${encodeURIComponent(`${editHref}?edit`)}`}>
              Log in
            </Link>{" "}
            to edit this page. You can view the{" "}
            <Link className={LINK} href={`${editHref}?source`}>
              source
            </Link>{" "}
            without an account.
          </p>
        </main>
      );
    }
    return (
      <main>
        <h1 className="mb-4 text-2xl font-semibold">Editing: {page.displayTitle ?? page.title}</h1>
        <WikiEditor
          title={page.title}
          canonicalHref={editHref}
          initialMarkdown={page.markdown}
          baseRevision={page.revId}
          isNew={false}
        />
      </main>
    );
  }

  if (view === "history") {
    const revisions = await cube.api.listRevisions(resolved, { limit: 100 });
    return (
      <main>
        <h1 className="mb-4 text-2xl font-semibold">History: {page.displayTitle ?? page.title}</h1>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr><th className={TH}>Revision</th><th className={TH}>Date</th><th className={TH}>Author</th><th className={TH}>Comment</th><th className={TH}>Size</th></tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.id}>
                <td className={TD}>
                  <Link className={LINK} href={`${canonical}?rev=${r.id}`}>r{r.id}</Link>
                  {r.wikitextFallback && (
                    <span className="ml-1.5 rounded bg-neutral-200 px-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      wikitext
                    </span>
                  )}
                </td>
                <td className={TD}>{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className={TD}>{r.author}</td>
                <td className={TD}>{r.comment}{r.minor ? " (minor)" : ""}</td>
                <td className={TD}>{r.bytes}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-sm"><Link className={LINK} href={canonical}>Back to page</Link></p>
      </main>
    );
  }

  if (view === "source") {
    return (
      <main>
        <h1 className="mb-4 text-2xl font-semibold">Source: {page.displayTitle ?? page.title}</h1>
        <pre className={PRE}>{page.markdown}</pre>
        <p className="mt-4 text-sm"><Link className={LINK} href={canonical}>Back to page</Link></p>
      </main>
    );
  }

  // Revisions holding original MediaWiki wikitext render as source, never
  // through the markdown pipeline.
  const rendered = page.wikitextFallback
    ? null
    : await renderWikiMarkdown(cube, page, page.markdown);

  return (
    <main>
      {resolved.redirectedFrom && (
        <p className="mb-2 text-sm text-neutral-500">
          Redirected from{" "}
          <Link className={LINK} href={`${pageHref(resolved.redirectedFrom)}?redirect=no`}>
            {resolved.redirectedFrom.slug.replace(/_/g, " ")}
          </Link>
        </p>
      )}
      {revId !== undefined && (
        <p className="mb-2 rounded border border-amber-400 bg-amber-50 px-3 py-1.5 text-sm dark:border-amber-600 dark:bg-amber-950">
          Viewing revision r{revId} (not current).{" "}
          <Link className={LINK} href={canonical}>Show latest</Link>
        </p>
      )}
      <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-neutral-200 pb-2 dark:border-neutral-800">
        <h1 className="text-3xl font-semibold">{page.displayTitle ?? page.title}</h1>
        <nav className="flex gap-3 text-sm text-neutral-500">
          <Link className="hover:underline" href={`${canonical}?edit`}>edit</Link>
          <Link className="hover:underline" href={`${canonical}?source`}>source</Link>
          <Link className="hover:underline" href={`${canonical}?history`}>history</Link>
        </nav>
      </div>
      {rendered ? (
        <article className="wiki-article">{rendered.node}</article>
      ) : (
        <div>
          <p className="mb-2 rounded border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
            This revision holds the original MediaWiki source (imported verbatim).
          </p>
          <pre className={PRE}>{page.markdown}</pre>
        </div>
      )}
    </main>
  );
}
