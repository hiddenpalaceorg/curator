// BMP/TGA/TIFF → PNG conversion. Link unfurlers (Discord, Slack, Twitter) and
// satori (the OG card renderer) only handle web image formats, but dumps carry
// raw BMP, TGA, and TIFF screenshots — convert those on the fly; formats we
// can't convert (ico, svg) fall back to the build's generated card. Browsers
// render BMP natively but not TGA or TIFF, so the viewer and gallery also
// route those through /api/asset/<sha>/png.

import bmp from "bmp-js";
import { PNG } from "pngjs";

/** Formats unfurlers render directly as og:image. */
export const WEB_SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/;

/** Mimes /api/asset/<sha>/png can convert. */
export function pngConvertible(mime: string): boolean {
  return mime === "image/bmp" || mime === "image/x-tga" || mime === "image/tiff";
}

/** Convert a pngConvertible asset to PNG. Throws on malformed input. */
export function toPng(mime: string, bytes: Buffer): Buffer {
  if (mime === "image/x-tga") return tgaToPng(bytes);
  if (mime === "image/tiff") return tiffToPng(bytes);
  return bmpToPng(bytes);
}

// Refuse to decode absurd dimensions (decode allocates width*height*4 up
// front, and headers are attacker-controlled bytes). Sized to admit hi-res
// print artwork scans (5760x3600 and up).
const MAX_PIXELS = 32_000_000;

// The standard BGRA channel masks — what every mainstream tool writes when it
// uses BI_BITFIELDS on 24/32bpp instead of plain BI_RGB.
const STD_MASKS = { r: 0xff0000, g: 0xff00, b: 0xff };

/**
 * Rewrite a BMP into the one layout bmp-js actually parses: 40-byte
 * BITMAPINFOHEADER, palette, pixels — with nothing in between. bmp-js never
 * seeks to the header's declared pixel-data offset, so V4/V5 headers (124
 * bytes from e.g. sips/Photoshop) decode shifted by the extra header bytes.
 * Its BI_BITFIELDS path is also broken (reads masks, then ignores them), so
 * standard-mask bitfields are converted to plain BI_RGB and anything with
 * exotic masks is rejected.
 */
function normalizeBmp(bytes: Buffer): Buffer {
  if (bytes.length < 54 || bytes.toString("latin1", 0, 2) !== "BM") {
    throw new Error("not a BMP");
  }
  const dataOffset = bytes.readUInt32LE(10);
  const dibSize = bytes.readUInt32LE(14);
  const bpp = bytes.readUInt16LE(28);
  const originalCompress = bytes.readUInt32LE(30);
  let compress = originalCompress;

  if (compress === 3) {
    // Masks sit at absolute 54 in both layouts (after a 40-byte header, or as
    // the V4/V5 header fields at DIB offset 40).
    const [r, g, b] = [54, 58, 62].map((o) => bytes.readUInt32LE(o));
    if (r !== STD_MASKS.r || g !== STD_MASKS.g || b !== STD_MASKS.b) {
      throw new Error("unsupported BMP channel masks");
    }
    compress = 0;
  }

  const colors = bytes.readUInt32LE(46);
  const paletteLen = bpp < 15 ? (colors === 0 ? 1 << bpp : colors) * 4 : 0;
  const canonicalOffset = 14 + 40 + paletteLen;
  if (dibSize === 40 && compress === originalCompress && dataOffset === canonicalOffset) {
    return bytes; // already the layout bmp-js expects
  }

  const fileHeader = Buffer.from(bytes.subarray(0, 14));
  fileHeader.writeUInt32LE(canonicalOffset, 10);
  const dib = Buffer.from(bytes.subarray(14, 54));
  dib.writeUInt32LE(40, 0);
  dib.writeUInt32LE(compress, 16);
  const palette = bytes.subarray(14 + dibSize, 14 + dibSize + paletteLen);
  return Buffer.concat([fileHeader, dib, palette, bytes.subarray(dataOffset)]);
}

/** Decode a BMP and re-encode as PNG. Throws on malformed input. */
export function bmpToPng(bytes: Buffer): Buffer {
  const normalized = normalizeBmp(bytes);
  const w = normalized.readInt32LE(18);
  const h = Math.abs(normalized.readInt32LE(22));
  if (w <= 0 || h === 0 || w * h > MAX_PIXELS) {
    throw new Error(`BMP dimensions out of range: ${w}x${h}`);
  }
  const { width, height, data } = bmp.decode(normalized); // ABGR per pixel
  const png = new PNG({ width, height });
  let maxAlpha = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i];
    if (a > maxAlpha) maxAlpha = a;
    png.data[i] = data[i + 3];
    png.data[i + 1] = data[i + 2];
    png.data[i + 2] = data[i + 1];
    png.data[i + 3] = a;
  }
  // Alpha-less BMPs (24bpp and lower) decode with alpha 0 everywhere; that
  // means opaque, not an invisible image.
  if (maxAlpha === 0) {
    for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255;
  }
  return PNG.sync.write(png);
}

// TGA decode, hand-rolled: the format is trivial and the npm decoders are as
// unmaintained as bmp-js. Covers what game dumps carry — 8bpp grayscale and
// color-mapped, 15/16bpp, 24/32bpp, raw and RLE, either vertical origin.
// Mirrors prism-core/src/tga.rs (the Windows GUI's TGA→BMP staging).

/** Expand a 5-bit channel to 8 bits by bit replication. */
function scale5(c: number): number {
  return (c << 3) | (c >> 2);
}

/** One pixel or palette entry in the file's layout → [r,g,b,a]. Formats
 *  without an alpha channel yield 0 — tgaToPng flips an all-zero alpha plane
 *  to opaque. */
function unpackTga(bytes: Buffer, o: number, bits: number): [number, number, number, number] {
  if (bits === 15 || bits === 16) {
    const v = bytes.readUInt16LE(o);
    return [scale5((v >> 10) & 31), scale5((v >> 5) & 31), scale5(v & 31), 0];
  }
  if (bits === 24) return [bytes[o + 2], bytes[o + 1], bytes[o], 0];
  return [bytes[o + 2], bytes[o + 1], bytes[o], bytes[o + 3]]; // 32
}

/** Decode a TGA and re-encode as PNG. Throws on malformed input. */
export function tgaToPng(bytes: Buffer): Buffer {
  if (bytes.length < 18) throw new Error("not a TGA");
  const idLen = bytes[0];
  const cmapType = bytes[1];
  const imageType = bytes[2];
  const cmapFirst = bytes.readUInt16LE(3);
  const cmapLen = bytes.readUInt16LE(5);
  const cmapBits = bytes[7];
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const depth = bytes[16];
  const desc = bytes[17];

  if (cmapType > 1 || ![1, 2, 3, 9, 10, 11].includes(imageType)) throw new Error("not a TGA");
  if (![8, 15, 16, 24, 32].includes(depth)) throw new Error(`unsupported TGA depth ${depth}`);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
    throw new Error(`TGA dimensions out of range: ${width}x${height}`);
  }
  const colorMapped = imageType === 1 || imageType === 9;
  const gray = imageType === 3 || imageType === 11;
  if (colorMapped && (cmapType !== 1 || depth !== 8)) {
    throw new Error("unsupported color-mapped TGA layout");
  }

  let off = 18 + idLen;

  // The palette rides along even when a truecolor image merely carries one;
  // decode entries only when pixels actually index into it.
  const palette: Array<[number, number, number, number]> = [];
  if (cmapType === 1) {
    if (![15, 16, 24, 32].includes(cmapBits)) {
      throw new Error(`unsupported TGA palette depth ${cmapBits}`);
    }
    const entryBytes = (cmapBits + 7) >> 3;
    const end = off + cmapLen * entryBytes;
    if (end > bytes.length) throw new Error("truncated TGA");
    if (colorMapped) {
      for (let i = 0; i < cmapLen; i++) palette.push(unpackTga(bytes, off + i * entryBytes, cmapBits));
    }
    off = end;
  }

  const bpp = (depth + 7) >> 3;
  const count = width * height;
  const px = Buffer.alloc(count * 4); // RGBA in file scan order

  const readPixel = (o: number): [number, number, number, number] => {
    if (o + bpp > bytes.length) throw new Error("truncated TGA");
    if (colorMapped) {
      const entry = palette[bytes[o] - cmapFirst];
      if (!entry) throw new Error("TGA palette index out of range");
      return entry;
    }
    if (gray) return [bytes[o], bytes[o], bytes[o], 0];
    return unpackTga(bytes, o, depth);
  };

  const put = (i: number, [r, g, b, a]: [number, number, number, number]) => {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = a;
  };

  if (imageType >= 9) {
    // RLE: header byte per packet — bit 7 = run, low 7 bits = count-1.
    let i = 0;
    while (i < count) {
      if (off >= bytes.length) throw new Error("truncated TGA");
      const hdr = bytes[off++];
      const n = (hdr & 0x7f) + 1;
      if (i + n > count) throw new Error("corrupt TGA RLE stream");
      if (hdr & 0x80) {
        const p = readPixel(off);
        off += bpp;
        for (let j = i; j < i + n; j++) put(j, p);
      } else {
        for (let j = i; j < i + n; j++) {
          put(j, readPixel(off));
          off += bpp;
        }
      }
      i += n;
    }
  } else {
    for (let j = 0; j < count; j++) {
      put(j, readPixel(off));
      off += bpp;
    }
  }

  // Alpha-less formats decode with alpha 0 everywhere; that means opaque, not
  // an invisible image (same convention as bmpToPng).
  let maxAlpha = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > maxAlpha) maxAlpha = px[i];
  if (maxAlpha === 0) for (let i = 3; i < px.length; i += 4) px[i] = 255;

  // Reorder scan lines to top-down; descriptor bit 5 = top origin,
  // bit 4 = right-to-left.
  const topOrigin = (desc & 0x20) !== 0;
  const rightToLeft = (desc & 0x10) !== 0;
  const png = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    const y = topOrigin ? row : height - 1 - row;
    for (let col = 0; col < width; col++) {
      const x = rightToLeft ? width - 1 - col : col;
      px.copy(png.data, (y * width + x) * 4, (row * width + col) * 4, (row * width + col) * 4 + 4);
    }
  }
  return PNG.sync.write(png);
}

// TIFF decode, hand-rolled like TGA — scoped to the baseline subset dumps
// carry: either byte order, first IFD only, strip-based chunky layout,
// uncompressed/PackBits/LZW (with the horizontal predictor), bilevel/
// grayscale/palette and 8-bit RGB(A)/CMYK. Tiled, planar, and fax/JPEG/
// deflate files are rejected; callers fall back to the generated card.

/** PackBits (TIFF §9): n >= 0 copies n+1 literals, n <= -1 repeats the next
 *  byte 1-n times, -128 is a no-op. */
function unpackBits(src: Buffer, expected: number): Buffer {
  const out = Buffer.alloc(expected);
  let i = 0;
  let o = 0;
  while (o < expected) {
    if (i >= src.length) throw new Error("truncated TIFF");
    const n = src.readInt8(i++);
    if (n >= 0) {
      if (i + n + 1 > src.length || o + n + 1 > expected) throw new Error("corrupt TIFF PackBits");
      src.copy(out, o, i, i + n + 1);
      i += n + 1;
      o += n + 1;
    } else if (n !== -128) {
      if (i >= src.length || o + 1 - n > expected) throw new Error("corrupt TIFF PackBits");
      out.fill(src[i++], o, o + 1 - n);
      o += 1 - n;
    }
  }
  return out;
}

/** TIFF-variant LZW (§13): MSB-first bit packing, 9- to 12-bit codes with the
 *  "early change" — code width bumps one code before the table forces it.
 *  Output past `expected` (writers that pad the last strip) is discarded. */
function lzwDecode(src: Buffer, expected: number): Buffer {
  const CLEAR = 256;
  const EOI = 257;
  const out = Buffer.alloc(expected);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let next = 258;
  let width = 9;
  let bit = 0;
  let o = 0;
  let prev = -1;

  const readCode = (): number => {
    if (bit + width > src.length * 8) return EOI; // ran off the end
    const p = bit >> 3;
    const chunk = (src[p] << 16) | ((src[p + 1] ?? 0) << 8) | (src[p + 2] ?? 0);
    const code = (chunk >>> (24 - (bit & 7) - width)) & ((1 << width) - 1);
    bit += width;
    return code;
  };

  /** First byte of the string a table code expands to. */
  const headOf = (code: number): number => {
    let c = code;
    let guard = 0;
    while (c >= 258) {
      c = prefix[c];
      if (++guard === 4096) throw new Error("corrupt TIFF LZW");
    }
    return c;
  };

  /** Copy `code`'s string to the output (clamped to `expected`); returns its
   *  first byte. */
  const emit = (code: number): number => {
    let sp = 0;
    let c = code;
    while (c >= 258) {
      stack[sp++] = suffix[c];
      c = prefix[c];
      if (sp === 4096) throw new Error("corrupt TIFF LZW");
    }
    if (o < expected) out[o++] = c;
    while (sp > 0 && o < expected) out[o++] = stack[--sp];
    return c;
  };

  while (o < expected) {
    const code = readCode();
    if (code === EOI) break;
    if (code === CLEAR) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (code > next || (prev === -1 && code >= 258)) throw new Error("corrupt TIFF LZW");
    if (prev === -1) {
      out[o++] = code;
      prev = code;
      continue;
    }
    if (code === next) {
      // KwKwK: the entry being defined refers to itself.
      prefix[next] = prev;
      suffix[next] = headOf(prev);
      next++;
      emit(code);
    } else {
      const first = emit(code);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first;
        next++;
      }
    }
    prev = code;
    if (next >= (1 << width) - 1 && width < 12) width++;
  }
  if (o < expected) throw new Error("truncated TIFF");
  return out;
}

/** Rounded a*b/255 — Pillow's MULDIV255, so CMYK output stays byte-exact
 *  with `Image.convert("RGB")` (and matches libtiff's tiff2rgba). */
function mulDiv255(a: number, b: number): number {
  const t = a * b + 128;
  return (t + (t >> 8)) >> 8;
}

/** Undo predictor 2 (horizontal differencing) in place, row by row. */
function undiff(data: Buffer, rows: number, rowBytes: number, spp: number): void {
  for (let y = 0; y < rows; y++) {
    const base = y * rowBytes;
    for (let i = spp; i < rowBytes; i++) {
      data[base + i] = (data[base + i] + data[base + i - spp]) & 0xff;
    }
  }
}

// IFD entry types the decoder consumes; everything else (ASCII, RATIONAL, …)
// only appears in tags it ignores.
const TIFF_TYPE_BYTES: Record<number, number> = { 1: 1, 3: 2, 4: 4 }; // BYTE, SHORT, LONG
const TIFF_TAGS = new Set([256, 257, 258, 259, 262, 266, 273, 277, 278, 279, 284, 317, 320, 322, 324, 332]);
const MAX_TIFF_VALUES = 2 * (1 << 20) + 1024;

/** Decode a TIFF and re-encode as PNG. Throws on malformed or out-of-scope
 *  input. */
export function tiffToPng(bytes: Buffer): Buffer {
  const order = bytes.length >= 8 ? bytes.toString("latin1", 0, 2) : "";
  if (order !== "II" && order !== "MM") throw new Error("not a TIFF");
  const le = order === "II";
  const u16 = (o: number): number => (le ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
  const u32 = (o: number): number => (le ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
  if (u16(2) !== 42) throw new Error("not a TIFF");

  // First IFD only — multi-page files show their first page.
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) throw new Error("truncated TIFF");
  const tags = new Map<number, number[]>();
  const descriptors = new Map<number, { size: number; count: number; at: number }>();
  const nEntries = u16(ifd);
  for (let i = 0; i < nEntries; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > bytes.length) throw new Error("truncated TIFF");
    const tag = u16(e);
    if (!TIFF_TAGS.has(tag)) continue;
    if (tag === 322 || tag === 324) throw new Error("unsupported tiled TIFF");
    if (descriptors.has(tag)) throw new Error("duplicate TIFF tag");
    const size = TIFF_TYPE_BYTES[u16(e + 2)];
    const count = u32(e + 4);
    if (!size || count === 0 || count > 1 << 20) throw new Error("invalid TIFF tag count");
    const at = size * count <= 4 ? e + 8 : u32(e + 8);
    if (at + size * count > bytes.length) throw new Error("truncated TIFF tag");
    descriptors.set(tag, { size, count, at });
  }
  const readValue = (size: number, at: number) => size === 1 ? bytes[at] : size === 2 ? u16(at) : u32(at);
  const scalar = (tag: number, fallback: number) => {
    const d = descriptors.get(tag);
    if (!d) return fallback;
    if (d.count !== 1) throw new Error("invalid TIFF scalar count");
    return readValue(d.size, d.at);
  };
  const decodedWidth = scalar(256, 0);
  const decodedHeight = scalar(257, 0);
  if (decodedWidth <= 0 || decodedHeight <= 0 || decodedWidth * decodedHeight > MAX_PIXELS) {
    throw new Error("TIFF dimensions out of range");
  }
  const stripRows = Math.min(scalar(278, decodedHeight) || decodedHeight, decodedHeight);
  const stripLimit = Math.ceil(decodedHeight / stripRows);
  let totalValues = 0;
  for (const [tag, { size, count, at }] of descriptors) {
    const cap = tag === 273 || tag === 279 ? stripLimit : tag === 258 ? 4 : tag === 320 ? 768 : 1;
    totalValues += count;
    if (count > cap || totalValues > MAX_TIFF_VALUES) throw new Error("TIFF metadata budget exceeded");
    const values = new Array<number>(count);
    for (let j = 0; j < count; j++) {
      values[j] = readValue(size, at + j * size);
    }
    tags.set(tag, values);
  }
  const tag1 = (t: number, dflt: number): number => tags.get(t)?.[0] ?? dflt;

  const width = tag1(256, 0);
  const height = tag1(257, 0);
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) {
    throw new Error(`TIFF dimensions out of range: ${width}x${height}`);
  }
  if (tags.has(322) || tags.has(324)) throw new Error("unsupported tiled TIFF");
  if (tag1(284, 1) !== 1) throw new Error("unsupported planar TIFF");
  if (tag1(266, 1) !== 1) throw new Error("unsupported TIFF fill order");
  const compression = tag1(259, 1);
  if (compression !== 1 && compression !== 5 && compression !== 32773) {
    throw new Error(`unsupported TIFF compression ${compression}`);
  }
  const photometric = tag1(262, -1);
  const spp = tag1(277, 1);
  const bits = tags.get(258) ?? [1];
  const predictor = tag1(317, 1);
  if (predictor !== 1 && (predictor !== 2 || bits.some((b) => b !== 8))) {
    throw new Error("unsupported TIFF predictor");
  }

  const gray = photometric === 0 || photometric === 1;
  const rgb = photometric === 2;
  const paletted = photometric === 3;
  const cmyk = photometric === 5;
  if (rgb) {
    if ((spp !== 3 && spp !== 4) || bits.some((b) => b !== 8)) {
      throw new Error("unsupported TIFF RGB layout");
    }
  } else if (cmyk) {
    // InkSet (332) 1 = CMYK; anything else names arbitrary ink separations.
    if (spp !== 4 || bits.some((b) => b !== 8) || tag1(332, 1) !== 1) {
      throw new Error("unsupported TIFF CMYK layout");
    }
  } else if (gray || paletted) {
    if (spp !== 1 || ![1, 4, 8].includes(bits[0])) {
      throw new Error("unsupported TIFF sample layout");
    }
  } else {
    throw new Error(`unsupported TIFF photometric ${photometric}`);
  }

  let pal = new Uint8Array(0); // interleaved RGB per index
  if (paletted) {
    const cmap = tags.get(320);
    const n = 1 << bits[0];
    if (!cmap || cmap.length < 3 * n) throw new Error("missing TIFF color map");
    // Entries are 16-bit per spec (all R, then G, then B); buggy writers store
    // 8-bit values, which would render near-black — pass those through.
    const shift = cmap.some((v) => v > 255) ? 8 : 0;
    pal = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
      pal[i * 3] = cmap[i] >> shift;
      pal[i * 3 + 1] = cmap[n + i] >> shift;
      pal[i * 3 + 2] = cmap[2 * n + i] >> shift;
    }
  }

  const bitsPerPixel = rgb || cmyk ? spp * 8 : bits[0];
  const rowBytes = (width * bitsPerPixel + 7) >> 3;
  const rowsPerStrip = Math.min(tag1(278, height) || height, height);
  const offsets = tags.get(273);
  if (!offsets) throw new Error("missing TIFF strip offsets");
  const nStrips = Math.ceil(height / rowsPerStrip);
  if (offsets.length < nStrips) throw new Error("truncated TIFF");
  // Lazy writers omit byte counts on uncompressed files; the geometry
  // determines them anyway.
  const counts = tags.get(279) ?? (compression === 1 ? offsets.map(() => 0) : null);
  if (!counts || counts.length < nStrips) throw new Error("missing TIFF strip byte counts");

  const png = new PNG({ width, height });
  const px = png.data;

  /** The x-th single-sample value in the row starting at `base`. */
  const sample1 = (data: Buffer, base: number, x: number): number => {
    const b = bits[0];
    if (b === 8) return data[base + x];
    if (b === 4) return (data[base + (x >> 1)] >> ((x & 1) === 0 ? 4 : 0)) & 15;
    return (data[base + (x >> 3)] >> (7 - (x & 7))) & 1;
  };

  const writeRow = (data: Buffer, base: number, yOut: number): void => {
    let o = yOut * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      if (rgb) {
        const p = base + x * spp;
        px[o] = data[p];
        px[o + 1] = data[p + 1];
        px[o + 2] = data[p + 2];
        px[o + 3] = spp === 4 ? data[p + 3] : 255;
      } else if (cmyk) {
        // Uncalibrated ink → RGB (any embedded ICC profile is ignored):
        // channel = (255 - ink) scaled by what black leaves uncovered.
        const p = base + x * spp;
        const nk = 255 - data[p + 3];
        px[o] = nk - mulDiv255(data[p], nk);
        px[o + 1] = nk - mulDiv255(data[p + 1], nk);
        px[o + 2] = nk - mulDiv255(data[p + 2], nk);
        px[o + 3] = 255;
      } else if (paletted) {
        const p = sample1(data, base, x) * 3;
        px[o] = pal[p];
        px[o + 1] = pal[p + 1];
        px[o + 2] = pal[p + 2];
        px[o + 3] = 255;
      } else {
        const s = sample1(data, base, x);
        const v = bits[0] === 8 ? s : bits[0] === 4 ? s * 17 : s * 255;
        const g = photometric === 0 ? 255 - v : v; // 0 = WhiteIsZero
        px[o] = g;
        px[o + 1] = g;
        px[o + 2] = g;
        px[o + 3] = 255;
      }
    }
  };

  for (let s = 0; s < nStrips; s++) {
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    const expected = rows * rowBytes;
    const off = offsets[s];
    let data: Buffer;
    if (compression === 1) {
      if (off + expected > bytes.length) throw new Error("truncated TIFF");
      const raw = bytes.subarray(off, off + expected);
      data = predictor === 2 ? Buffer.from(raw) : raw; // undiff mutates
    } else {
      if (off + counts[s] > bytes.length) throw new Error("truncated TIFF");
      const raw = bytes.subarray(off, off + counts[s]);
      data = compression === 5 ? lzwDecode(raw, expected) : unpackBits(raw, expected);
    }
    if (predictor === 2) undiff(data, rows, rowBytes, spp);
    for (let y = 0; y < rows; y++) writeRow(data, y * rowBytes, s * rowsPerStrip + y);
  }

  return PNG.sync.write(png);
}
