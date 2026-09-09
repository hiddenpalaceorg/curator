// ffmpeg-backed transcoding: MPEG-1/2 program streams (.mpg, DVD .vob), bare
// MPEG video elementary streams, and AVI to a format browsers actually play,
// and ADPCM-family WAVs (Xbox ADPCM and friends) to plain 16-bit PCM WAV.
// Like Ghostscript in gs.ts, ffmpeg is a soft dependency: feature-detected at
// runtime, and callers degrade (download-only viewer) when it's missing.
//
// The output format follows what the ffmpeg build can encode: H.264/AAC MP4
// (universal) when libx264 is present, else VP9/Opus WebM (all modern
// browsers) for the distro builds that omit GPL components. The cache lookup
// accepts either extension regardless of the local profile, so a transcode
// produced on a better-equipped machine and dropped into the store serves
// as-is.
//
// Unlike the PNG conversions, a transcode is too slow to redo per request, so
// results are cached in the blob store under .transcode/ (which can't collide
// with the two-hex-char blob dirs) and streamed from disk with Range support.
// Poster stills live under .thumb/ the same way.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assetStoreDir, withBlobFile } from "./blobstore";
import { conversions, ConversionBusy } from "./conversion-queue";

const execFileP = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
// ffprobe normally ships beside ffmpeg; follow a custom FFMPEG_BIN's naming.
const FFPROBE_BIN =
  process.env.FFPROBE_BIN ||
  (/ffmpeg[^/\\]*$/.test(FFMPEG_BIN) ? FFMPEG_BIN.replace(/ffmpeg([^/\\]*)$/, "ffprobe$1") : "ffprobe");

// A 5MB trailer transcodes in seconds, a 1GiB DVD VOB is upward of an hour of
// MPEG-2 decode + re-encode on a modest server — scale the kill switch with
// the input instead of guessing one number for both.
const TIMEOUT_BASE_MS = 120_000;
const TIMEOUT_PER_MB_MS = 6_000;
const TIMEOUT_MAX_MS = 6 * 3_600_000;

function transcodeTimeoutMs(inputBytes: number): number {
  return Math.min(TIMEOUT_BASE_MS + Math.ceil(inputBytes / 1e6) * TIMEOUT_PER_MB_MS, TIMEOUT_MAX_MS);
}

// A poster still decodes a few dozen frames even from a 1GiB input (the seek
// is on the input side), so a flat timeout is enough.
const THUMB_TIMEOUT_MS = 120_000;

/** Mimes ensureTranscode can convert. */
export function transcodable(mime: string): boolean {
  return mime === "video/mpeg" || mime === "video/x-msvideo";
}

export interface TranscodeProfile {
  mime: "video/mp4" | "video/webm";
  ext: ".mp4" | ".webm";
  args: string[];
}

const MP4_PROFILE: TranscodeProfile = {
  mime: "video/mp4",
  ext: ".mp4",
  args: [
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k",
    // moov atom up front so playback starts before the download completes.
    "-movflags", "+faststart",
    "-f", "mp4",
  ],
};

const WEBM_PROFILE: TranscodeProfile = {
  mime: "video/webm",
  ext: ".webm",
  args: [
    "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-deadline", "good",
    "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p",
    "-c:a", "libopus", "-b:a", "128k",
    "-f", "webm",
  ],
};

/** The output profile this `ffmpeg -encoders` listing supports, else null. */
export function detectProfile(encoders: string): TranscodeProfile | null {
  if (/^\s*V\S*\s+libx264\s/m.test(encoders)) return MP4_PROFILE;
  if (/^\s*V\S*\s+libvpx-vp9\s/m.test(encoders) && /^\s*A\S*\s+libopus\s/m.test(encoders)) {
    return WEBM_PROFILE;
  }
  return null;
}

// Feature detection, memoized for the process lifetime. A missing binary and
// a binary without a usable encoder pair degrade the same way.
let profile: Promise<TranscodeProfile | null> | null = null;

export function transcodeProfile(): Promise<TranscodeProfile | null> {
  profile ??= execFileP(FFMPEG_BIN, ["-hide_banner", "-encoders"], { timeout: 5_000 })
    .then(({ stdout }) => detectProfile(stdout))
    .catch(() => null);
  return profile;
}

/** Where a blob's cached transcode lives. Caller must have validated `sha256`. */
export function transcodePath(sha256: string, ext: string): string {
  return join(assetStoreDir(), ".transcode", `${sha256}${ext}`);
}

/** Where a blob's cached poster still lives. Caller must have validated `sha256`. */
export function thumbPath(sha256: string): string {
  return join(assetStoreDir(), ".thumb", `${sha256}.jpg`);
}

async function nonEmpty(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/** The cached transcode under either extension, no matter which profile this
 *  server would pick — precomputed MP4s must serve from a VP9-only box. */
async function cachedTranscode(sha256: string): Promise<{ path: string; mime: string } | null> {
  const mp4 = transcodePath(sha256, ".mp4");
  if (await nonEmpty(mp4)) return { path: mp4, mime: "video/mp4" };
  const webm = transcodePath(sha256, ".webm");
  if (await nonEmpty(webm)) return { path: webm, mime: "video/webm" };
  return null;
}

// One transcode per blob at a time: a gallery of players can fire several
// requests for the same asset before the first transcode finishes. The job
// entry keeps what the status probe needs to report progress.
interface Job {
  promise: Promise<{ path: string; mime: string }>;
  progressPath: string;
  durationUs: number | null;
}

const inFlight = new Map<string, Job>();

// Blobs whose last transcode attempt failed, so the status probe can answer
// "failed" instead of letting a client poll forever. A fresh ensureTranscode
// (a new playback attempt) clears the mark and retries.
const failed = new Set<string>();

/**
 * The cached browser-playable transcode for this blob, produced on first use.
 * Throws when ffmpeg is missing, errors on the input, or times out.
 */
export async function ensureTranscode(sha256: string): Promise<{ path: string; mime: string }> {
  const cached = await cachedTranscode(sha256);
  if (cached) return cached;
  const running = inFlight.get(sha256);
  if (running) return running.promise;

  failed.delete(sha256);
  const job: Job = {
    progressPath: "",
    durationUs: null,
    promise: undefined as unknown as Promise<{ path: string; mime: string }>,
  };
  job.promise = conversions.run(`video:${sha256}`, async () => {
    const p = await transcodeProfile();
    if (!p) throw new Error("ffmpeg not available");
    const out = transcodePath(sha256, p.ext);
    job.progressPath = `${out}.${randomBytes(4).toString("hex")}.progress`;
    return transcode(sha256, out, p, job);
  })
    .catch((err) => {
      if (!(err instanceof ConversionBusy)) failed.add(sha256);
      throw err;
    })
    .finally(() => {
      inFlight.delete(sha256);
      if (job.progressPath) rm(job.progressPath, { force: true }).catch(() => {});
    });
  inFlight.set(sha256, job);
  return job.promise;
}

/** Input duration in microseconds via ffprobe, or null (missing binary, or a
 *  stream it can't put a duration on). Best-effort — only progress reporting
 *  depends on it. */
async function probeDurationUs(path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      FFPROBE_BIN,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
      { timeout: 15_000 }
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1e6) : null;
  } catch {
    return null;
  }
}

/** Percent complete of a running job, from ffmpeg's -progress file, or null
 *  while it hasn't started writing (or the duration is unknown). */
async function jobPercent(job: Job): Promise<number | null> {
  if (!job.durationUs) return null;
  let text: string;
  try {
    text = await readFile(job.progressPath, "utf8");
  } catch {
    return null;
  }
  const matches = text.match(/^out_time_us=(\d+)$/gm);
  if (!matches?.length) return null;
  const outUs = Number(matches[matches.length - 1].slice("out_time_us=".length));
  return Math.max(0, Math.min(99, Math.round((outUs / job.durationUs) * 100)));
}

export type TranscodeStatus =
  | { state: "ready"; path: string; mime: string }
  | { state: "transcoding"; percent: number | null }
  | { state: "failed" }
  | { state: "none" };

/** Where this blob's transcode stands, without starting one. */
export async function transcodeStatus(sha256: string): Promise<TranscodeStatus> {
  const cached = await cachedTranscode(sha256);
  if (cached) return { state: "ready", ...cached };
  const running = inFlight.get(sha256);
  if (running) return { state: "transcoding", percent: await jobPercent(running) };
  if (failed.has(sha256)) return { state: "failed" };
  return { state: "none" };
}

async function transcode(
  sha256: string,
  out: string,
  p: TranscodeProfile,
  job: Job
): Promise<{ path: string; mime: string }> {
  await mkdir(dirname(out), { recursive: true });
  // ffmpeg needs a seekable local file — withBlobFile materializes the blob
  // when the store is remote (and is a no-op pass-through when it's local).
  const result = await withBlobFile(sha256, async (input) => {
    const size = (await stat(input)).size;
    job.durationUs = await probeDurationUs(input);
    // Private temp name in the final dir, atomically renamed on success, so a
    // concurrent request in another process never streams a partial file.
    const tmp = `${out}.${randomBytes(4).toString("hex")}.part`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-progress",
      job.progressPath,
      "-y",
      "-i",
      input,
      // First video + first audio track only: DVD VOBs carry alternate audio
      // tracks and subpicture/nav streams a browser player has no UI for.
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-dn",
      "-sn",
      // Deinterlace frames flagged interlaced (DVD content usually is), and
      // keep dimensions even (4:2:0 encoders reject odd sizes).
      "-vf",
      "yadif=deint=interlaced,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      ...p.args,
      tmp,
    ];
    try {
      await execFileP(FFMPEG_BIN, args, { timeout: transcodeTimeoutMs(size), maxBuffer: 4_000_000 });
      if ((await stat(tmp)).size === 0) throw new Error("empty transcode");
      await rename(tmp, out);
      return { path: out, mime: p.mime };
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  });
  if (result === null) throw new Error("blob missing from store");
  return result;
}

// One audio transcode per blob at a time, same reason as video transcodes.
const audioInFlight = new Map<string, Promise<string>>();

/**
 * The cached browser-playable PCM WAV for this audio blob, produced on first
 * use. For WAVs whose codec browsers won't decode (ADPCM variants, per the
 * wav.ts sniff). Every ffmpeg encodes pcm_s16le, so unlike video there is no
 * output-profile detection: a missing binary just rejects.
 * Throws when ffmpeg is missing, errors on the input, or times out.
 */
export async function ensureAudioTranscode(sha256: string): Promise<string> {
  const out = transcodePath(sha256, ".wav");
  if (await nonEmpty(out)) return out;
  let job = audioInFlight.get(sha256);
  if (!job) {
    job = conversions.run(`audio:${sha256}`, () => transcodeAudio(sha256, out)).finally(() => audioInFlight.delete(sha256));
    audioInFlight.set(sha256, job);
  }
  return job;
}

async function transcodeAudio(sha256: string, out: string): Promise<string> {
  await mkdir(dirname(out), { recursive: true });
  const result = await withBlobFile(sha256, async (input) => {
    const size = (await stat(input)).size;
    const tmp = `${out}.${randomBytes(4).toString("hex")}.part`;
    const args = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", input,
      "-map", "0:a:0",
      "-c:a", "pcm_s16le",
      "-f", "wav",
      tmp,
    ];
    try {
      await execFileP(FFMPEG_BIN, args, { timeout: transcodeTimeoutMs(size), maxBuffer: 4_000_000 });
      if ((await stat(tmp)).size === 0) throw new Error("empty transcode");
      await rename(tmp, out);
      return out;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  });
  if (result === null) throw new Error("blob missing from store");
  return result;
}

// One thumbnail per blob at a time, same reason as transcodes.
const thumbsInFlight = new Map<string, Promise<string>>();

/**
 * The cached poster still (JPEG) for this video blob, produced on first use.
 * Works for every stored video format — the still needs only a decoder.
 * Throws when ffmpeg is missing or can't find a frame.
 */
export async function ensureThumb(sha256: string): Promise<string> {
  const out = thumbPath(sha256);
  if (await nonEmpty(out)) return out;
  let job = thumbsInFlight.get(sha256);
  if (!job) {
    job = conversions.run(`thumb:${sha256}`, () => thumb(sha256, out)).finally(() => thumbsInFlight.delete(sha256));
    thumbsInFlight.set(sha256, job);
  }
  return job;
}

async function thumb(sha256: string, out: string): Promise<string> {
  const result = await withBlobFile(sha256, (input) => extractStillAdmitted(input, out));
  if (result === null) throw new Error("blob missing from store");
  return result;
}

/** Extract one representative poster still (JPEG) from a local video file
 *  into `out`. Shared by the asset thumb cache (via the blob store) and the
 *  media-upload poster path (which still has the uploaded file on disk).
 *  Throws when ffmpeg is missing or can't find a frame. */
export async function extractStill(input: string, out: string): Promise<string> {
  return conversions.run(`still:${input}:${out}`, () => extractStillAdmitted(input, out));
}

async function extractStillAdmitted(input: string, out: string): Promise<string> {
  await mkdir(dirname(out), { recursive: true });
  // A quarter in (bounded) skips studio logos and fade-ins; the thumbnail
  // filter then picks the most representative of the next frames, dodging
  // black frames around the seek point. Falls back to the very start for
  // clips too short to seek into.
  const durationUs = await probeDurationUs(input);
  const seekSec = durationUs ? Math.min(Math.max((durationUs / 1e6) * 0.25, 1), 45) : 3;
  const tmp = `${out}.${randomBytes(4).toString("hex")}.part`;
  const argsAt = (seek: number) => [
    "-hide_banner", "-loglevel", "error", "-y",
    ...(seek > 0 ? ["-ss", String(seek)] : []),
    "-i", input,
    "-map", "0:v:0", "-dn", "-sn", "-an",
    "-vf", "yadif=deint=interlaced,thumbnail=48,scale=trunc(min(iw\\,512)/2)*2:-2",
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2",
    tmp,
  ];
  try {
    for (const seek of seekSec > 0 ? [seekSec, 0] : [0]) {
      try {
        await execFileP(FFMPEG_BIN, argsAt(seek), { timeout: THUMB_TIMEOUT_MS, maxBuffer: 4_000_000 });
        if ((await stat(tmp)).size > 0) {
          await rename(tmp, out);
          return out;
        }
      } catch {
        // Retry from the start (a clip shorter than the seek), then give up.
      }
    }
    throw new Error("no frame extracted");
  } finally {
    await rm(tmp, { force: true });
  }
}

// One scaled photo per (blob, width) at a time, same reason as transcodes.
const photoScalesInFlight = new Map<string, Promise<string>>();

/** Widths the photo scale cache will produce: 500 for gallery/preview thumbs,
 *  1000 for high-quality OG photo rows and larger previews. */
export const PHOTO_SCALE_WIDTHS = [500, 1000] as const;
export type PhotoScaleWidth = (typeof PHOTO_SCALE_WIDTHS)[number];

export function isPhotoScaleWidth(v: number): v is PhotoScaleWidth {
  return (PHOTO_SCALE_WIDTHS as readonly number[]).includes(v);
}

export function photoScalePath(sha256: string, width: PhotoScaleWidth): string {
  return join(assetStoreDir(), ".thumb", `${sha256}.photo-${width}.jpg`);
}

/**
 * A cached scaled-down JPEG (≤`width`px wide) of a stored photo, produced on
 * first use. The OG card inlines photos and satori decodes them in-process,
 * and the browser makes jaggies of a 3000px scan crammed into a 200px cell —
 * multi-MB camera shots get shrunk once, out of process, with a real
 * resampler here. Throws when ffmpeg is missing, the blob is absent, or the
 * bytes don't decode.
 */
export async function ensurePhotoScale(sha256: string, ns = "", width: PhotoScaleWidth = 1000): Promise<string> {
  const out = photoScalePath(sha256, width);
  if (await nonEmpty(out)) return out;
  const key = `${sha256}:${width}`;
  let job = photoScalesInFlight.get(key);
  if (!job) {
    job = conversions.run(`photo:${key}`, () => scalePhoto(sha256, ns, out, width)).finally(() => photoScalesInFlight.delete(key));
    photoScalesInFlight.set(key, job);
  }
  return job;
}

async function scalePhoto(sha256: string, ns: string, out: string, width: PhotoScaleWidth): Promise<string> {
  const result = await withBlobFile(sha256, (input) => scaleStill(input, out, width), ns);
  if (result === null) throw new Error("blob missing from store");
  return result;
}

/** Re-encode a local image as a JPEG capped at `width`px wide (never
 *  upscaled; animations contribute their first frame) into `out`. Lanczos
 *  resampling: these are photos headed for thumbnails, sharpness wins. */
async function scaleStill(input: string, out: string, width: PhotoScaleWidth): Promise<string> {
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.${randomBytes(4).toString("hex")}.part`;
  try {
    await execFileP(
      FFMPEG_BIN,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", input,
        "-frames:v", "1",
        "-vf", `scale=trunc(min(iw\\,${width})/2)*2:-2:flags=lanczos`,
        "-c:v", "mjpeg", "-q:v", "4", "-f", "image2",
        tmp,
      ],
      { timeout: THUMB_TIMEOUT_MS, maxBuffer: 4_000_000 }
    );
    if ((await stat(tmp)).size === 0) throw new Error("empty scaled photo");
    await rename(tmp, out);
    return out;
  } finally {
    await rm(tmp, { force: true });
  }
}
