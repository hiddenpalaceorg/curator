import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getModeratorFromHeaders } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { magazineHref } from "@/lib/mag/hrefs";
import { getIssue, getIssueExtracts, listIssuePages } from "@/lib/mag/queries";
import IssueBrowser, { type IssueExtractItem, type IssuePageItem } from "./IssueBrowser";
import RenderProgress from "./RenderProgress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Card text previews stay small so a 400-extract issue (price lists included,
// verbatim by policy) doesn't ship megabytes of JSON; the full text loads per
// extract on expand from /api/mag/extracts/<id>.
const TEXT_PREVIEW = 1200;

interface Params {
  params: Promise<{ slug: string; issue: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, issue } = await params;
  const row = await getIssue(getPool(), decodeURIComponent(slug), decodeURIComponent(issue));
  if (!row) return {};
  return {
    title: `${row.magazine_title} ${row.label}`,
    description: `Indexed contents of ${row.magazine_title} ${row.label}`,
  };
}

function preview(text: string | null): { text: string | null; truncated: boolean } {
  if (!text) return { text: null, truncated: false };
  if (text.length <= TEXT_PREVIEW) return { text, truncated: false };
  return { text: text.slice(0, TEXT_PREVIEW), truncated: true };
}

// /magazines/<slug>/<issue> — the showcase page: identity block, page strip
// with extract-region overlays, and every extract grouped by page with
// original/English text, entity chips, and inline moderation.
export default async function IssuePage({ params }: Params) {
  const { slug, issue: issueSlug } = await params;
  const pool = getPool();
  const issue = await getIssue(pool, decodeURIComponent(slug), decodeURIComponent(issueSlug));
  if (!issue) notFound();

  const moderator = !!(await getModeratorFromHeaders(await headers()));
  const [pages, extracts] = await Promise.all([
    listIssuePages(pool, issue.id),
    getIssueExtracts(pool, issue.id, moderator, moderator),
  ]);

  const pageItems: IssuePageItem[] = pages.map((p) => ({
    pdf_index: p.pdf_index,
    printed_label: p.printed_label,
    image_sha256: issue.pages_public || moderator ? p.image_sha256 : null,
    width: p.width,
    height: p.height,
  }));

  const items: IssueExtractItem[] = extracts.map((e) => {
    const orig = preview(e.text_original);
    const en = preview(e.text_en);
    return {
      id: e.id,
      kind: e.kind,
      section: e.section,
      seq: e.seq,
      title: e.title,
      language: e.language,
      text_original: orig.text,
      text_en: en.text,
      truncated: orig.truncated || en.truncated,
      translation: e.translation,
      summary_en: e.summary_en,
      data: e.data,
      is_fictional: e.is_fictional,
      sponsored: e.sponsored,
      content_warning: e.content_warning,
      status: e.status,
      regions: e.regions,
      games: e.games,
      people: e.people,
      systems: e.systems,
      tags: e.tags,
    };
  });

  const supplements = issue.supplements.filter((s) => s && typeof s.title === "string");
  const renderedPages = new Set(pages.filter((p) => p.image_sha256).map((p) => p.pdf_index));
  const rendering =
    !!issue.pdf_sha256 &&
    (pages.length === 0 ||
      (issue.page_count !== null && pages.filter((p) => p.image_sha256).length < issue.page_count) ||
      extracts.some((e) => e.regions.some((r) => !r.crop_sha256 && renderedPages.has(r.pdf_index))));

  return (
    <main className="mx-auto max-w-none px-4 py-10 sm:px-8">
      <div className="mx-auto max-w-5xl">
        <Link href={magazineHref(issue.magazine_slug)} className="text-sm text-neutral-500 hover:underline">
          &larr; {issue.magazine_title}
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          {issue.magazine_title} <span className="text-neutral-500">{issue.label}</span>
        </h1>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {issue.cover_date && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium dark:bg-neutral-800">
              {issue.cover_date.slice(0, issue.cover_date_precision === "year" ? 4 : issue.cover_date_precision === "month" ? 7 : 10)}
            </span>
          )}
          {issue.volume && <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">Vol. {issue.volume}</span>}
          {issue.number && <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">No. {issue.number}</span>}
          {issue.whole_number && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">whole no. {issue.whole_number}</span>
          )}
          {issue.price_raw && <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{issue.price_raw}</span>}
          {issue.page_count !== null && (
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">{issue.page_count} pages</span>
          )}
          <span className="rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
            {items.filter((e) => e.status !== "rejected").length} extracts
          </span>
          {issue.source_url && (
            <a href={issue.source_url} className="text-neutral-500 underline decoration-dotted hover:text-neutral-700 dark:hover:text-neutral-300" rel="nofollow noopener">
              scan source
            </a>
          )}
        </div>
        {supplements.length > 0 && (
          <p className="mt-2 text-xs text-neutral-500">
            Supplements:{" "}
            {supplements.map((s, i) => (
              <span key={i}>
                {i > 0 && ", "}
                {s.title}
                {s.present ? "" : " (not in this scan)"}
              </span>
            ))}
          </p>
        )}
        {issue.publisher_raw && <p className="mt-1 text-xs text-neutral-500">{issue.publisher_raw}</p>}

        {rendering && <RenderProgress issueId={issue.id} />}
      </div>

      <IssueBrowser
        issueId={issue.id}
        binding={issue.binding}
        pages={pageItems}
        extracts={items}
        pagesPublic={issue.pages_public || moderator}
        moderator={moderator}
      />
    </main>
  );
}
