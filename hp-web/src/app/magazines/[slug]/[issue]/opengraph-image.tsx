// Social-preview card for a magazine issue: wordmark, magazine + issue label,
// fact chips (date, price, pages, extract count), and the cover render in the
// image pane. Same satori recipe as the build card, including the
// retry-without-image fallback.

import fsp from "node:fs/promises";
import { ImageResponse } from "next/og";
import { getPool } from "@/lib/db";
import { ensurePhotoScale } from "@/lib/ffmpeg";
import { MAG_NS } from "@/lib/mag/store";
import { getIssue, type IssueWithMagazine } from "@/lib/mag/queries";

export const runtime = "nodejs";
export const alt = "Magazine issue summary card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function findCover(issueId: number): Promise<string | null> {
  const r = await getPool().query(
    "SELECT image_sha256 FROM magazine_page WHERE issue_id=$1 AND pdf_index=1 AND image_sha256 IS NOT NULL",
    [issueId]
  );
  const sha = (r.rows[0] as { image_sha256: string } | undefined)?.image_sha256;
  if (!sha) return null;
  try {
    // Page renders are ~2200px JPEGs; the cached 1000px scale is card-sized.
    const scaled = await ensurePhotoScale(sha, MAG_NS, 1000);
    const bytes = await fsp.readFile(scaled);
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function facts(issue: IssueWithMagazine, extracts: number): string[] {
  const out: string[] = [];
  if (issue.cover_date) {
    out.push(issue.cover_date.slice(0, issue.cover_date_precision === "year" ? 4 : 7));
  }
  if (issue.price_raw) out.push(issue.price_raw);
  if (issue.page_count) out.push(`${issue.page_count} pages`);
  if (extracts > 0) out.push(`${extracts} extracts`);
  return out.slice(0, 4);
}

function Card({ issue, extracts, cover }: { issue: IssueWithMagazine; extracts: number; cover: string | null }) {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", background: "#0a0a0a", color: "#fafafa" }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 56,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 26, letterSpacing: 6, color: "#737373" }}>HIDDEN PALACE MAGAZINES</div>
          <div style={{ marginTop: 30, fontSize: 54, lineHeight: 1.15, lineClamp: 3, display: "block" }}>
            {`${issue.magazine_title} ${issue.label}`}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {facts(issue, extracts).map((f) => (
              <div
                key={f}
                style={{
                  border: "1px solid #333333",
                  borderRadius: 10,
                  padding: "8px 20px",
                  fontSize: 27,
                  color: "#d4d4d4",
                }}
              >
                {f}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 23, color: "#525252" }}>{"hiddenpalace.org/magazines"}</div>
        </div>
      </div>
      {cover && (
        <div
          style={{
            width: 480,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#171717",
            borderLeft: "1px solid #262626",
            padding: 24,
          }}
        >
          <img src={cover} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}

async function render(issue: IssueWithMagazine, extracts: number, cover: string | null): Promise<Response> {
  const img = new ImageResponse(<Card issue={issue} extracts={extracts} cover={cover} />, size);
  const buf = await img.arrayBuffer();
  return new Response(buf, {
    headers: { "Content-Type": contentType, "Cache-Control": "private, no-store" },
  });
}

export default async function OgImage({ params }: { params: Promise<{ slug: string; issue: string }> }) {
  const { slug, issue: issueSlug } = await params;
  const pool = getPool();
  const issue = await getIssue(pool, decodeURIComponent(slug), decodeURIComponent(issueSlug));
  if (!issue) return new Response("not found", { status: 404 });
  const count = await pool.query(
    "SELECT count(*)::int AS n FROM magazine_extract WHERE issue_id=$1 AND status <> 'rejected'",
    [issue.id]
  );
  const extracts = (count.rows[0] as { n: number }).n;
  // The cover pane respects the per-magazine pages_public toggle: when full
  // pages are unlisted, the unfurl card stays text-only too.
  const cover = issue.pages_public ? await findCover(issue.id) : null;
  try {
    return await render(issue, extracts, cover);
  } catch {
    return await render(issue, extracts, null);
  }
}
