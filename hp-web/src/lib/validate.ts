// Input validation + size caps for untrusted request bodies (resource-exhaustion guard).

import type { BuildRecord, Node } from "./types";

// Must fit a MAX_FILES/MAX_ASSETS-sized record: each file or asset entry is a
// few hundred bytes of JSON, so cap-sized records run tens of MB.
export const MAX_BODY_BYTES = 64_000_000;

/** Longest accepted submitter nickname (display/attribution only). */
export const MAX_NICKNAME_LEN = 100;

const MAX_FILES = 200_000;
const MAX_SIGNATURE_VALUES = 4096;
const MAX_MEDIA = 4096;
const MAX_AUDIO_FP = 200_000;
// Asset extraction spans every viewable (image/audio/text) file in a build, and
// real dumps carry tens of thousands — this only guards against absurdity.
const MAX_ASSETS = 100_000;

/** True if `s` is a lowercase 64-hex sha256. */
export function isSha256(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

type ValidateResult =
  | { ok: true; record: BuildRecord }
  | { ok: false; error: string };

/** Validate an untrusted BuildRecord shape and enforce upper bounds. */
export function validateBuildRecord(rec: unknown): ValidateResult {
  if (typeof rec !== "object" || rec === null) {
    return { ok: false, error: "record must be an object" };
  }
  const r = rec as Record<string, unknown>;
  const image = r.image as Record<string, unknown> | undefined;
  const sha = image?.sha256;
  if (typeof sha !== "string" || !isSha256(sha)) {
    return { ok: false, error: "image.sha256 must be a 64-char lowercase hex string" };
  }

  if (r.structural != null) {
    if (typeof r.structural !== "object" || Array.isArray(r.structural)) {
      return { ok: false, error: "structural must be an object" };
    }
    const count = (r.structural as Record<string, unknown>).file_count;
    if (count != null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
      return { ok: false, error: "structural.file_count must be a nonnegative safe integer" };
    }
  }

  // Walk the contents tree with an explicit stack; bail early past the file cap.
  const contents = r.contents;
  if (contents !== undefined && !Array.isArray(contents)) {
    return { ok: false, error: "contents must be an array" };
  }
  let fileCount = 0;
  const stack: Node[] = Array.isArray(contents) ? [...(contents as Node[])] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n && n.type === "dir") {
      if (Array.isArray(n.children)) stack.push(...n.children);
    } else {
      fileCount++;
      if (fileCount > MAX_FILES) {
        return { ok: false, error: `contents exceeds ${MAX_FILES} files` };
      }
    }
  }

  const chunkSig = r.chunk_signature as Record<string, unknown> | null | undefined;
  if (chunkSig && Array.isArray(chunkSig.values) && chunkSig.values.length > MAX_SIGNATURE_VALUES) {
    return { ok: false, error: `chunk_signature.values exceeds ${MAX_SIGNATURE_VALUES} entries` };
  }

  const media = r.media;
  if (media !== undefined) {
    if (!Array.isArray(media)) {
      return { ok: false, error: "media must be an array" };
    }
    if (media.length > MAX_MEDIA) {
      return { ok: false, error: `media exceeds ${MAX_MEDIA} entries` };
    }
    for (const m of media as Array<Record<string, unknown>>) {
      const fp = m?.audio_fp;
      if (Array.isArray(fp) && fp.length > MAX_AUDIO_FP) {
        return { ok: false, error: `media[].audio_fp exceeds ${MAX_AUDIO_FP} entries` };
      }
    }
  }

  const assets = r.assets;
  if (assets != null) {
    if (!Array.isArray(assets)) {
      return { ok: false, error: "assets must be an array" };
    }
    if (assets.length > MAX_ASSETS) {
      return { ok: false, error: `assets exceeds ${MAX_ASSETS} entries` };
    }
  }

  return { ok: true, record: rec as BuildRecord };
}
