// Magazine asset pipeline: page renders and region crops, derived on the
// server from the issue's source PDF so every ingest stores one PDF instead
// of hundreds of images (the bucket gateway sustains ~3.5 PUT/s).
//
// Page renders are JPEG (scans are photographic; PNG would be ~10x the bytes
// at corpus scale). Region crops are PNG per the extraction spec. Both live
// in the blob store under the mag/ namespace, content-addressed, and served
// through the public gateway like build media. The source PDF also lives
// under mag/ but is moderator-only — no public route ever hands out its URL.
//
// Rendering follows the transcode pattern: in-process jobs keyed by issue,
// progress read from the DB (pages/regions with blobs vs without), so a
// restart resumes by re-running the job over whatever is missing. Ghostscript
// and ffmpeg are soft dependencies, like gs.ts/ffmpeg.ts.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { storeBlobFromFile, withBlobFile } from "../blobstore";
import { hashFile } from "../media";
import { gsAvailable } from "../gs";

const execFileP = promisify(execFile);

const GS_BIN = process.env.GHOSTSCRIPT_BIN || "gs";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const QPDF_BIN = process.env.QPDF_BIN || "qpdf";

/** Store namespace for all magazine blobs (see blobstore key layout). */
export const MAG_NS = "mag/";

/** Target long edge of a page render, px. Magazine scans are ~150-300dpi;
 *  2200px keeps small print legible in crops without ballooning the corpus. */
const TARGET_LONG_EDGE = 2200;
const MIN_DPI = 72;
const MAX_DPI = 300;
const JPEG_QUALITY = 85;

/** Pages per Ghostscript invocation: bounds each timeout, and makes progress
 *  observable in the DB between chunks. */
const RENDER_CHUNK = 16;
const RENDER_CHUNK_TIMEOUT_MS = 30_000 + RENDER_CHUNK * 15_000;
const PAGE_COUNT_TIMEOUT_MS = 120_000;
const CROP_TIMEOUT_MS = 60_000;

/** Crop padding, fraction of the page dimension on each side — vision-model
 *  boxes run tight, and a hair of margin keeps descenders and frames whole. */
const CROP_PAD = 0.01;

/** Always pass through association-aware authorization, including crops. */
export function magImageUrl(sha256: string): string {
  return `/api/mag/blob/${sha256}`;
}

/** JPEG pixel dimensions from the SOF marker; null when the bytes are not a
 *  parseable JPEG. Enough of a decoder to size Ghostscript's output. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    // SOF0-SOF15 minus DHT(C4)/JPG(C8)/DAC(CC): frame header with dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

/** Page count of a local PDF. qpdf when present (exact, instant), else a
 *  Ghostscript nullpage pass ("Processing pages 1 through N"). Ghostscript
 *  10.x dropped the PostScript pdfpagecount operator, so banner parsing is
 *  the portable fallback. */
export async function pdfPageCount(input: string): Promise<number> {
  try {
    const { stdout } = await execFileP(QPDF_BIN, ["--show-npages", input], {
      timeout: PAGE_COUNT_TIMEOUT_MS,
    });
    const n = parseInt(stdout.trim(), 10);
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // qpdf missing or unhappy; fall through to gs.
  }
  if (!(await gsAvailable())) throw new Error("no pdf page counter available (qpdf or ghostscript)");
  // No -q here: the "Processing pages 1 through N" banner IS the output.
  const { stdout, stderr } = await execFileP(
    GS_BIN,
    ["-dSAFER", "-dBATCH", "-dNOPAUSE", "-P-", "-sDEVICE=nullpage", input],
    { timeout: PAGE_COUNT_TIMEOUT_MS, maxBuffer: 16_000_000 }
  );
  const banner = `${stdout}\n${stderr}`;
  const through = /Processing pages \d+ through (\d+)/.exec(banner);
  if (through) return parseInt(through[1], 10);
  let last = 0;
  for (const m of banner.matchAll(/^Page (\d+)$/gm)) last = Math.max(last, parseInt(m[1], 10));
  if (last > 0) return last;
  throw new Error("could not determine pdf page count");
}

/** Render pages [first..last] of a local PDF into `dir` as p-<n>.jpg (n is
 *  the absolute pdf index). Returns the rendered indexes in order. */
async function gsRenderRange(input: string, dir: string, first: number, last: number, dpi: number): Promise<number[]> {
  if (!(await gsAvailable())) throw new Error("ghostscript not available");
  await execFileP(
    GS_BIN,
    [
      "-dSAFER", "-dBATCH", "-dNOPAUSE", "-q", "-P-", "-sstdout=%stderr",
      "-sDEVICE=jpeg", `-dJPEGQ=${JPEG_QUALITY}`,
      `-r${dpi}`,
      "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
      `-dFirstPage=${first}`, `-dLastPage=${last}`,
      // %d restarts at 1 per invocation; rename to absolute indexes below.
      "-sOutputFile=" + join(dir, "out-%d.jpg"),
      input,
    ],
    { timeout: RENDER_CHUNK_TIMEOUT_MS, maxBuffer: 16_000_000 }
  );
  const produced: number[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const m = /^out-(\d+)\.jpg$/.exec(name);
    if (!m) continue;
    const abs = first + parseInt(m[1], 10) - 1;
    await rename(join(dir, name), join(dir, `p-${abs}.jpg`));
    produced.push(abs);
  }
  return produced.sort((a, b) => a - b);
}

/** Probe the DPI that lands the long edge near TARGET_LONG_EDGE: render page
 *  1 at 150dpi, measure, rescale once, clamp. One DPI per issue keeps the
 *  render uniform (page sizes within an issue are uniform in practice). */
async function probeDpi(input: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), `magprobe-${randomBytes(4).toString("hex")}-`));
  try {
    await gsRenderRange(input, dir, 1, 1, 150);
    const size = jpegSize(await readFile(join(dir, "p-1.jpg")));
    if (!size) return 150;
    const long = Math.max(size.width, size.height);
    if (!long) return 150;
    return Math.max(MIN_DPI, Math.min(MAX_DPI, Math.round((150 * TARGET_LONG_EDGE) / long)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Crop a rectangle (normalized page coords) out of a rendered page into a
 *  PNG at `out`, with CROP_PAD margin. Throws when ffmpeg is missing or the
 *  rectangle degenerates. */
export async function cropRegionPng(
  pageFile: string,
  page: { width: number; height: number },
  region: { x: number; y: number; w: number; h: number },
  out: string
): Promise<void> {
  const x0 = Math.max(0, region.x - CROP_PAD);
  const y0 = Math.max(0, region.y - CROP_PAD);
  const x1 = Math.min(1, region.x + region.w + CROP_PAD);
  const y1 = Math.min(1, region.y + region.h + CROP_PAD);
  const px = Math.round(x0 * page.width);
  const py = Math.round(y0 * page.height);
  const pw = Math.max(8, Math.min(page.width - px, Math.round((x1 - x0) * page.width)));
  const ph = Math.max(8, Math.min(page.height - py, Math.round((y1 - y0) * page.height)));
  if (pw < 8 || ph < 8) throw new Error("degenerate crop");
  await execFileP(
    FFMPEG_BIN,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", pageFile,
      "-vf", `crop=${pw}:${ph}:${px}:${py}`,
      "-frames:v", "1", "-c:v", "png", "-f", "image2",
      out,
    ],
    { timeout: CROP_TIMEOUT_MS, maxBuffer: 4_000_000 }
  );
  if ((await stat(out)).size === 0) throw new Error("empty crop");
}

// ── issue asset job ──────────────────────────────────────────────────────────

const issueJobs = new Map<number, Promise<void>>();
const issueJobErrors = new Map<number, string>();

export interface IssueAssetStatus {
  state: "idle" | "working" | "failed";
  error?: string;
  pages_total: number;
  pages_rendered: number;
  crops_total: number;
  crops_done: number;
}

/** Progress from the DB — restart-safe, no in-memory bookkeeping needed
 *  beyond the running-job map. */
export async function issueAssetStatus(pool: Pool, issueId: number): Promise<IssueAssetStatus> {
  const r = await pool.query(
    `SELECT
       coalesce((SELECT page_count FROM magazine_issue WHERE id=$1), 0)::int AS declared,
       (SELECT count(*) FROM magazine_page WHERE issue_id=$1 AND image_sha256 IS NOT NULL)::int AS pages_rendered,
       (SELECT count(*) FROM extract_region r JOIN magazine_extract e ON e.id=r.extract_id
         WHERE e.issue_id=$1)::int AS crops_total,
       (SELECT count(*) FROM extract_region r JOIN magazine_extract e ON e.id=r.extract_id
         WHERE e.issue_id=$1 AND r.crop_sha256 IS NOT NULL)::int AS crops_done`,
    [issueId]
  );
  const row = r.rows[0] as { declared: number; pages_rendered: number; crops_total: number; crops_done: number };
  const working = issueJobs.has(issueId);
  const error = issueJobErrors.get(issueId);
  return {
    state: working ? "working" : error ? "failed" : "idle",
    ...(error && !working ? { error } : {}),
    pages_total: row.declared,
    pages_rendered: row.pages_rendered,
    crops_total: row.crops_total,
    crops_done: row.crops_done,
  };
}

/** Whether anything is left for the job to do (used by the status route to
 *  self-heal after a restart, like the transcode status route). */
export async function issueAssetsPending(pool: Pool, issueId: number): Promise<boolean> {
  const s = await issueAssetStatus(pool, issueId);
  if (s.state === "working") return false;
  const pdf = await pool.query("SELECT pdf_sha256 FROM magazine_issue WHERE id=$1", [issueId]);
  const hasPdf = !!pdf.rows[0]?.pdf_sha256;
  const pagesPending = hasPdf && (s.pages_total === 0 || s.pages_rendered < s.pages_total);
  return pagesPending || s.crops_done < s.crops_total;
}

/** Kick (or join) the render+crop job for an issue. Idempotent per process;
 *  progress is durable in the DB, so re-kicking after a crash just finishes
 *  the remainder. */
export function ensureIssueAssets(pool: Pool, issueId: number): Promise<void> {
  let job = issueJobs.get(issueId);
  if (!job) {
    issueJobErrors.delete(issueId);
    job = runIssueAssets(pool, issueId)
      .catch((e) => {
        issueJobErrors.set(issueId, e instanceof Error ? e.message : String(e));
        throw e;
      })
      .finally(() => issueJobs.delete(issueId));
    issueJobs.set(issueId, job);
    // Detach: callers that only kick must not crash on a background failure.
    job.catch(() => {});
  }
  return job;
}

async function runIssueAssets(pool: Pool, issueId: number): Promise<void> {
  const issue = await pool.query(
    "SELECT id::int AS id, pdf_sha256, page_count FROM magazine_issue WHERE id=$1",
    [issueId]
  );
  const row = issue.rows[0] as { id: number; pdf_sha256: string | null; page_count: number | null } | undefined;
  if (!row) throw new Error("issue not found");
  if (row.pdf_sha256) await renderMissingPages(pool, issueId, row.pdf_sha256);
  await cropMissingRegions(pool, issueId);
}

async function renderMissingPages(pool: Pool, issueId: number, pdfSha: string): Promise<void> {
  const done = await withBlobFile(
    pdfSha,
    async (input) => {
      const total = await pdfPageCount(input);
      await pool.query(
        "UPDATE magazine_issue SET page_count=$2, updated_at=now() WHERE id=$1 AND (page_count IS NULL OR page_count<>$2)",
        [issueId, total]
      );
      const have = await pool.query(
        "SELECT pdf_index FROM magazine_page WHERE issue_id=$1 AND image_sha256 IS NOT NULL",
        [issueId]
      );
      const rendered = new Set<number>(have.rows.map((r: { pdf_index: number }) => Number(r.pdf_index)));
      if (rendered.size >= total) return true;

      const dpi = await probeDpi(input);
      for (let first = 1; first <= total; first += RENDER_CHUNK) {
        const last = Math.min(total, first + RENDER_CHUNK - 1);
        let all = true;
        for (let p = first; p <= last; p++) if (!rendered.has(p)) all = false;
        if (all) continue;
        const dir = await mkdtemp(join(tmpdir(), `magrender-${randomBytes(4).toString("hex")}-`));
        try {
          const produced = await gsRenderRange(input, dir, first, last, dpi);
          for (const abs of produced) {
            if (rendered.has(abs)) continue;
            const file = join(dir, `p-${abs}.jpg`);
            const size = jpegSize(await readFile(file));
            if (!size) throw new Error(`page ${abs}: unparseable render`);
            const sha = await hashFile(file);
            await storeBlobFromFile(sha, file, { ns: MAG_NS, keepSource: true });
            await pool.query(
              `INSERT INTO magazine_page (issue_id, pdf_index, width, height, image_sha256, rendered_at)
               VALUES ($1,$2,$3,$4,$5,now())
               ON CONFLICT (issue_id, pdf_index) DO UPDATE
                 SET width=$3, height=$4, image_sha256=$5, rendered_at=now()`,
              [issueId, abs, size.width, size.height, sha]
            );
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      return true;
    },
    MAG_NS
  );
  if (done === null) throw new Error("issue pdf blob missing from store");
}

async function cropMissingRegions(pool: Pool, issueId: number): Promise<void> {
  const pending = await pool.query(
    `SELECT r.id::int AS id, r.x, r.y, r.w, r.h,
            p.image_sha256 AS page_sha, p.width::int AS width, p.height::int AS height
     FROM extract_region r
     JOIN magazine_extract e ON e.id = r.extract_id
     JOIN magazine_page p ON p.id = r.page_id
     WHERE e.issue_id=$1 AND r.crop_sha256 IS NULL AND p.image_sha256 IS NOT NULL
     ORDER BY r.id`,
    [issueId]
  );
  for (const region of pending.rows as {
    id: number; x: number; y: number; w: number; h: number;
    page_sha: string; width: number; height: number;
  }[]) {
    const dir = await mkdtemp(join(tmpdir(), `magcrop-${randomBytes(4).toString("hex")}-`));
    try {
      const out = join(dir, "crop.png");
      const ok = await withBlobFile(
        region.page_sha,
        async (pageFile) => {
          await cropRegionPng(pageFile, region, region, out);
          return true;
        },
        MAG_NS
      );
      if (ok === null) continue; // page blob missing; a later render pass will restore it
      const sha = await hashFile(out);
      await storeBlobFromFile(sha, out, { ns: MAG_NS, keepSource: true });
      await pool.query("UPDATE extract_region SET crop_sha256=$2 WHERE id=$1 AND crop_sha256 IS NULL", [
        region.id,
        sha,
      ]);
    } catch {
      // One bad region (hostile bbox, truncated page) must not stall the
      // issue; it stays NULL and shows as pending in the status counts.
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
