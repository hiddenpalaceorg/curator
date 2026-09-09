// Minimal CMYK PSD/PSB parser, shared by the server flatten (lib/psd.ts) and
// the browser layer-viewer worker (psd.worker.ts). ag-psd refuses CMYK files
// outright, and the corpus's CMYK documents are print-press artwork — often
// saved without "Maximize Compatibility" (blank composite) and with every
// layer hidden, so the layer records are the only pixels there are.
//
// Deliberately small: 8-bit CMYK only, raw + PackBits channel compression,
// layer bounds/opacity/hidden/clipping/blend key/name. Masks, groups, and
// 16/32-bit stay out of scope — a failed parse falls back to the flattened
// composite (server) or the download card (client).
//
// No Buffer, no imports: this must bundle into a web worker untouched.
// Photoshop stores CMYK inverted (255 = no ink) — Pillow's "CMYK;I" — so
// RGB falls out as stored_channel x stored_black per pixel.

export interface CmykLayer {
  name: string;
  top: number;
  left: number;
  rows: number;
  cols: number;
  /** 0-1 like ag-psd. */
  opacity: number;
  hidden: boolean;
  clipping: boolean;
  /** ag-psd-style blend name ("multiply", "pass through", …). */
  blendMode: string;
  /** Premultiplied nothing — straight RGBA at rows x cols, null when the
   *  layer has no pixels (group marker, adjustment layer). */
  rgba: Uint8ClampedArray | null;
}

export interface CmykPsd {
  width: number;
  height: number;
  layers: CmykLayer[];
  /** The flattened composite as RGBA — blank white in files saved without
   *  "Maximize Compatibility". */
  composite: () => Uint8ClampedArray;
}

/** True when the header says 8-bit CMYK (the only mode this module reads). */
export function isCmykPsd(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 26 &&
    bytes[0] === 0x38 && // "8BPS"
    bytes[1] === 0x42 &&
    bytes[2] === 0x50 &&
    bytes[3] === 0x53 &&
    view(bytes).getUint16(24) === 4 &&
    view(bytes).getUint16(22) === 8
  );
}

// Photoshop blend keys → ag-psd blend names (the worker maps those onward to
// canvas composite ops).
const BLEND_KEYS: Record<string, string> = {
  norm: "normal",
  diss: "dissolve",
  dark: "darken",
  "mul ": "multiply",
  idiv: "color burn",
  lbrn: "linear burn",
  dkCl: "darker color",
  lite: "lighten",
  scrn: "screen",
  "div ": "color dodge",
  lddg: "linear dodge",
  lgCl: "lighter color",
  over: "overlay",
  sLit: "soft light",
  hLit: "hard light",
  vLit: "vivid light",
  lLit: "linear light",
  pLit: "pin light",
  hMix: "hard mix",
  diff: "difference",
  smud: "exclusion",
  fsub: "subtract",
  fdiv: "divide",
  "hue ": "hue",
  "sat ": "saturation",
  colr: "color",
  "lum ": "luminosity",
  pass: "pass through",
};

const MAX_PIXELS = 32_000_000;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Rounded a*b/255 (Pillow's MULDIV255). */
export function mulDiv255(a: number, b: number): number {
  const t = a * b + 128;
  return (t + (t >> 8)) >> 8;
}

/** PackBits: n >= 0 copies n+1 literals, n <= -1 repeats the next byte
 *  1-n times, -128 is a no-op. */
function unpackBits(bytes: Uint8Array, at: number, len: number, out: Uint8Array, outAt: number, expected: number): void {
  let i = at;
  const end = at + len;
  let o = outAt;
  const outEnd = outAt + expected;
  while (o < outEnd) {
    if (i >= end) throw new Error("truncated PackBits");
    const n = (bytes[i++] << 24) >> 24;
    if (n >= 0) {
      if (i + n + 1 > end || o + n + 1 > outEnd) throw new Error("corrupt PackBits");
      out.set(bytes.subarray(i, i + n + 1), o);
      i += n + 1;
      o += n + 1;
    } else if (n !== -128) {
      if (i >= end || o + 1 - n > outEnd) throw new Error("corrupt PackBits");
      out.fill(bytes[i++], o, o + 1 - n);
      o += 1 - n;
    }
  }
}

/** One channel's rows (u16 compression header + raw or PackBits payload). */
function decodeChannel(
  bytes: Uint8Array,
  at: number,
  len: number,
  rows: number,
  cols: number,
  psb: boolean
): Uint8Array {
  const dv = view(bytes);
  const compression = dv.getUint16(at);
  const out = new Uint8Array(rows * cols);
  if (compression === 0) {
    if (at + 2 + rows * cols > bytes.length) throw new Error("truncated channel");
    out.set(bytes.subarray(at + 2, at + 2 + rows * cols));
  } else if (compression === 1) {
    const entry = psb ? 4 : 2;
    let data = at + 2 + rows * entry;
    for (let y = 0; y < rows; y++) {
      const i = at + 2 + y * entry;
      const rowLen = psb ? dv.getUint32(i) : dv.getUint16(i);
      if (data + rowLen > at + len) throw new Error("truncated channel row");
      unpackBits(bytes, data, rowLen, out, y * cols, cols);
      data += rowLen;
    }
  } else {
    throw new Error(`unsupported channel compression ${compression}`);
  }
  return out;
}

function cmykToRgba(
  planes: Map<number, Uint8Array>,
  count: number,
  opaque = false
): Uint8ClampedArray {
  const c = planes.get(0)!;
  const m = planes.get(1)!;
  const y = planes.get(2)!;
  const k = planes.get(3)!;
  const alpha = opaque ? undefined : planes.get(-1);
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[i * 4] = mulDiv255(c[i], k[i]);
    rgba[i * 4 + 1] = mulDiv255(m[i], k[i]);
    rgba[i * 4 + 2] = mulDiv255(y[i], k[i]);
    rgba[i * 4 + 3] = alpha ? alpha[i] : 255;
  }
  return rgba;
}

/** Parse an 8-bit CMYK PSD/PSB. Throws on anything it can't read exactly. */
export function parseCmykPsd(bytes: Uint8Array, maxDecodedBytes = MAX_DECODED_BYTES): CmykPsd {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes <= 0 || maxDecodedBytes > MAX_DECODED_BYTES) {
    throw new Error("invalid PSD decoded-byte limit");
  }
  let decodedBytes = 0;
  const reserve = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > maxDecodedBytes - decodedBytes) {
      throw new Error("PSD decoded-byte budget exceeded");
    }
    decodedBytes += size;
  };
  if (!isCmykPsd(bytes)) throw new Error("not an 8-bit CMYK PSD");
  const dv = view(bytes);
  const psb = dv.getUint16(4) === 2;
  const fileChannels = dv.getUint16(12);
  const height = dv.getUint32(14);
  const width = dv.getUint32(18);
  if (width * height > MAX_PIXELS || width === 0 || height === 0) {
    throw new Error(`PSD too large: ${width}x${height}`);
  }
  // Leave room for the caller's flattened frame and PNG/canvas output.
  reserve(width * height * 8);

  let off = 26;
  off += 4 + dv.getUint32(off); // color mode data
  off += 4 + dv.getUint32(off); // image resources
  const sectionLen = psb ? Number(dv.getBigUint64(off)) : dv.getUint32(off);
  const imageAt = off + (psb ? 8 : 4) + sectionLen;

  // --- layer records -------------------------------------------------------
  const layers: CmykLayer[] = [];
  let p = off + (psb ? 8 : 4);
  const layerInfoLen = psb ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
  p += psb ? 8 : 4;
  if (layerInfoLen > 0) {
    const count = Math.abs(dv.getInt16(p));
    p += 2;
    if (count > 1000) throw new Error(`implausible layer count ${count}`);
    interface Rec {
      top: number;
      left: number;
      rows: number;
      cols: number;
      channels: { id: number; len: number }[];
      blendMode: string;
      opacity: number;
      clipping: boolean;
      hidden: boolean;
      name: string;
    }
    const recs: Rec[] = [];
    for (let i = 0; i < count; i++) {
      const top = dv.getInt32(p);
      const left = dv.getInt32(p + 4);
      const bottom = dv.getInt32(p + 8);
      const right = dv.getInt32(p + 12);
      p += 16;
      const nch = dv.getUint16(p);
      p += 2;
      const channels: { id: number; len: number }[] = [];
      for (let ch = 0; ch < nch; ch++) {
        channels.push({
          id: dv.getInt16(p),
          len: psb ? Number(dv.getBigUint64(p + 2)) : dv.getUint32(p + 2),
        });
        p += psb ? 10 : 6;
      }
      if (String.fromCharCode(...bytes.subarray(p, p + 4)) !== "8BIM") {
        throw new Error("bad layer blend signature");
      }
      const key = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
      const opacity = bytes[p + 8];
      const clipping = bytes[p + 9] !== 0;
      const flags = bytes[p + 10];
      p += 12;
      const extraLen = dv.getUint32(p);
      p += 4;
      const extraEnd = p + extraLen;
      // Extra data: mask block, blending ranges, then the pascal name.
      let name = "";
      try {
        let q = p;
        q += 4 + dv.getUint32(q); // mask data
        q += 4 + dv.getUint32(q); // blending ranges
        const nameLen = bytes[q];
        name = new TextDecoder("windows-1252").decode(bytes.subarray(q + 1, q + 1 + nameLen));
      } catch {
        // name stays "" — cosmetic only
      }
      p = extraEnd;
      const rows = bottom - top;
      const cols = right - left;
      if (rows < 0 || cols < 0 || rows * cols > MAX_PIXELS) throw new Error("bad layer bounds");
      recs.push({
        top,
        left,
        rows,
        cols,
        channels,
        blendMode: BLEND_KEYS[key] ?? "normal",
        opacity,
        clipping,
        hidden: (flags & 2) !== 0,
        name,
      });
    }
    // Channel image data follows the records, in the same order.
    for (const rec of recs) {
      const planes = new Map<number, Uint8Array>();
      const seen = new Set<number>();
      for (const ch of rec.channels) {
        if ((ch.id >= 0 && ch.id <= 3) || ch.id === -1) {
          if (seen.has(ch.id)) throw new Error("duplicate PSD channel");
          seen.add(ch.id);
          if (rec.rows > 0 && rec.cols > 0) {
            // Outside the tolerant decode catch: exhausting the document
            // budget must fail the whole file, not silently discard a layer.
            reserve(rec.rows * rec.cols);
            try {
              planes.set(ch.id, decodeChannel(bytes, p, ch.len, rec.rows, rec.cols, psb));
            } catch {
              // this layer renders without pixels rather than failing the file
            }
          }
        }
        p += ch.len; // masks (-2/-3) and spot channels: skipped, not parsed
      }
      const hasInks = [0, 1, 2, 3].every((id) => planes.has(id));
      if (hasInks) reserve(rec.rows * rec.cols * 4);
      layers.push({
        name: rec.name || "Layer",
        top: rec.top,
        left: rec.left,
        rows: rec.rows,
        cols: rec.cols,
        opacity: rec.opacity / 255,
        hidden: rec.hidden,
        clipping: rec.clipping,
        blendMode: rec.blendMode,
        rgba: hasInks ? cmykToRgba(planes, rec.rows * rec.cols) : null,
      });
    }
  }

  let compositePixels: Uint8ClampedArray | undefined;
  return {
    width,
    height,
    layers,
    composite: () => {
      if (compositePixels) return compositePixels;
      const compression = dv.getUint16(imageAt);
      const plane = width * height;
      reserve(plane * (compression === 1 ? 8 : 4));
      const planes = new Map<number, Uint8Array>();
      if (compression === 0) {
        for (let c = 0; c < 4; c++) {
          const at = imageAt + 2 + c * plane;
          if (at + plane > bytes.length) throw new Error("truncated composite");
          planes.set(c, bytes.subarray(at, at + plane));
        }
      } else if (compression === 1) {
        // One row-length table for ALL channels up front, then channel-major
        // PackBits rows (unlike per-layer channels, which each carry their own).
        const entry = psb ? 4 : 2;
        const table = imageAt + 2;
        let data = table + fileChannels * height * entry;
        for (let c = 0; c < 4; c++) {
          const out = new Uint8Array(plane);
          for (let y = 0; y < height; y++) {
            const i = table + (c * height + y) * entry;
            const len = psb ? dv.getUint32(i) : dv.getUint16(i);
            if (data + len > bytes.length) throw new Error("truncated composite");
            unpackBits(bytes, data, len, out, y * width, width);
            data += len;
          }
          planes.set(c, out);
        }
      } else {
        throw new Error(`unsupported composite compression ${compression}`);
      }
      compositePixels = cmykToRgba(planes, plane, true);
      return compositePixels;
    },
  };
}
