import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { bmpToPng, pngConvertible, tgaToPng, tiffToPng, toPng, WEB_SAFE_IMAGE } from "../src/lib/imgpng";

// Hand-crafted 2x1 24bpp BMP: left pixel pure red, right pixel pure blue
// (rows are BGR on disk, padded to 4 bytes) — pins the ABGR→RGBA swizzle.
function tinyBmp(): Buffer {
  const row = Buffer.from([0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0, 0]);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0); // header size
  dib.writeInt32LE(2, 4); // width
  dib.writeInt32LE(1, 8); // height
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(24, 14); // bpp
  dib.writeUInt32LE(row.length, 20); // image size
  const hdr = Buffer.alloc(14);
  hdr.write("BM");
  hdr.writeUInt32LE(14 + 40 + row.length, 2);
  hdr.writeUInt32LE(54, 10); // pixel data offset
  return Buffer.concat([hdr, dib, row]);
}

test("bmpToPng keeps channel order and makes 24bpp opaque", () => {
  const png = PNG.sync.read(bmpToPng(tinyBmp()));
  assert.equal(png.width, 2);
  assert.equal(png.height, 1);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]); // red, opaque
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 255, 255]); // blue, opaque
});

// 2x1 32bpp BMP with a 124-byte V5 header and standard-mask BI_BITFIELDS
// (what sips/Photoshop write) — pins the header normalization: bmp-js alone
// mis-decodes these by reading extended-header bytes as pixels.
function tinyBmpV5(): Buffer {
  const row = Buffer.from([0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00, 0xff]); // BGRA: red, blue
  const dib = Buffer.alloc(124);
  dib.writeUInt32LE(124, 0); // V5 header size
  dib.writeInt32LE(2, 4); // width
  dib.writeInt32LE(1, 8); // height
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(32, 14); // bpp
  dib.writeUInt32LE(3, 16); // BI_BITFIELDS
  dib.writeUInt32LE(row.length, 20);
  dib.writeUInt32LE(0xff0000, 40); // R mask
  dib.writeUInt32LE(0xff00, 44); // G mask
  dib.writeUInt32LE(0xff, 48); // B mask
  dib.writeUInt32LE(0xff000000, 52); // A mask
  const hdr = Buffer.alloc(14);
  hdr.write("BM");
  hdr.writeUInt32LE(14 + 124 + row.length, 2);
  hdr.writeUInt32LE(14 + 124, 10); // pixel data offset past the V5 header
  return Buffer.concat([hdr, dib, row]);
}

test("bmpToPng handles V5-header bitfields BMPs (sips/Photoshop output)", () => {
  const png = PNG.sync.read(bmpToPng(tinyBmpV5()));
  assert.equal(png.width, 2);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]); // red
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 255, 255]); // blue
});

test("bmpToPng rejects exotic channel masks", () => {
  const weird = tinyBmpV5();
  weird.writeUInt32LE(0xf800, 14 + 40); // RGB565-style red mask
  assert.throws(() => bmpToPng(weird), /masks/);
});

test("bmpToPng throws on garbage and absurd dimensions", () => {
  assert.throws(() => bmpToPng(Buffer.from("not a bmp")));
  const huge = tinyBmp();
  huge.writeInt32LE(1_000_000, 18); // width
  huge.writeInt32LE(1_000_000, 22); // height
  assert.throws(() => bmpToPng(huge), /dimensions/);
});

test("web-safe and convertible mime classification", () => {
  for (const m of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.ok(WEB_SAFE_IMAGE.test(m), m);
  }
  for (const m of ["image/bmp", "image/x-tga", "image/x-icon", "image/svg+xml", "image/tiff"]) {
    assert.ok(!WEB_SAFE_IMAGE.test(m), m);
  }
  assert.ok(pngConvertible("image/bmp"));
  assert.ok(pngConvertible("image/x-tga"));
  assert.ok(pngConvertible("image/tiff"));
  assert.ok(!pngConvertible("image/x-icon"));
  assert.ok(!pngConvertible("image/svg+xml"));
});

// 18-byte TGA header for a bare (palette-less) image.
function tgaHeader(imageType: number, w: number, h: number, depth: number, desc: number): Buffer {
  const hd = Buffer.alloc(18);
  hd[2] = imageType;
  hd.writeUInt16LE(w, 12);
  hd.writeUInt16LE(h, 14);
  hd[16] = depth;
  hd[17] = desc;
  return hd;
}

test("tgaToPng flips bottom-origin rows and makes 24bpp opaque", () => {
  // 2x2 bottom-origin: file rows run bottom-up, so the file's second row
  // (red, blue — BGR on disk) must come out as the top of the PNG.
  const tga = Buffer.concat([
    tgaHeader(2, 2, 2, 24, 0),
    Buffer.from([0, 255, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0]),
  ]);
  const png = PNG.sync.read(tgaToPng(tga));
  assert.equal(png.width, 2);
  assert.equal(png.height, 2);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]); // red
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 255, 255]); // blue
  assert.deepEqual([...png.data.subarray(8, 12)], [0, 255, 0, 255]); // green
});

test("tgaToPng decodes RLE packets and keeps real alpha", () => {
  // 3x1 top-origin RLE: a run of two half-transparent reds + one literal blue.
  const tga = Buffer.concat([
    tgaHeader(10, 3, 1, 32, 0x20),
    Buffer.from([0x81, 0, 0, 255, 128, 0x00, 255, 0, 0, 255]),
  ]);
  const png = PNG.sync.read(tgaToPng(tga));
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 128]);
  assert.deepEqual([...png.data.subarray(4, 8)], [255, 0, 0, 128]);
  assert.deepEqual([...png.data.subarray(8, 12)], [0, 0, 255, 255]);
});

test("tgaToPng resolves color-mapped pixels through the palette", () => {
  // 2x1 indexed: palette entry 0 = magenta, 1 = cyan (24-bit BGR entries).
  const hd = tgaHeader(1, 2, 1, 8, 0x20);
  hd[1] = 1; // color map present
  hd.writeUInt16LE(2, 5); // 2 entries
  hd[7] = 24;
  const tga = Buffer.concat([hd, Buffer.from([255, 0, 255, 255, 255, 0]), Buffer.from([0, 1])]);
  const png = PNG.sync.read(tgaToPng(tga));
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 255, 255]); // magenta
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 255, 255, 255]); // cyan
});

test("tgaToPng expands 5-bit channels to full range", () => {
  // 1x1 16bpp ARGB1555 pure white — 5-bit channels must scale to 255.
  const px = Buffer.alloc(2);
  px.writeUInt16LE(0x7fff, 0);
  const png = PNG.sync.read(tgaToPng(Buffer.concat([tgaHeader(2, 1, 1, 16, 0x20), px])));
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 255, 255, 255]);
});

test("tgaToPng throws on garbage, absurd dimensions, and truncation", () => {
  assert.throws(() => tgaToPng(Buffer.from("definitely not a tga")));
  const huge = Buffer.concat([tgaHeader(2, 65535, 65535, 24, 0), Buffer.alloc(4)]);
  assert.throws(() => tgaToPng(huge), /dimensions/);
  assert.throws(() => tgaToPng(tgaHeader(2, 4, 4, 24, 0)), /truncated/);
});

// Minimal TIFF writer for fixtures: 8-byte header, image data at offset 8,
// then the IFD and any out-of-line values. Entries: [tag, type, values]
// (types: 1 BYTE, 3 SHORT, 4 LONG).
function tinyTiff(entries: Array<[number, number, number[]]>, data: Buffer, le = true): Buffer {
  const w16 = (b: Buffer, v: number, o: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b: Buffer, v: number, o: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const sizes: Record<number, number> = { 1: 1, 3: 2, 4: 4 };
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const ifdAt = 8 + data.length;
  const extraAt = ifdAt + 2 + sorted.length * 12 + 4;
  const header = Buffer.alloc(8);
  header.write(le ? "II" : "MM", 0, "latin1");
  w16(header, 42, 2);
  w32(header, ifdAt, 4);
  const ifd = Buffer.alloc(2 + sorted.length * 12 + 4); // trailing next-IFD = 0
  w16(ifd, sorted.length, 0);
  const extras: Buffer[] = [];
  let extraLen = 0;
  sorted.forEach(([tag, type, values], i) => {
    const o = 2 + i * 12;
    w16(ifd, tag, o);
    w16(ifd, type, o + 2);
    w32(ifd, values.length, o + 4);
    const size = sizes[type];
    const put = (b: Buffer, off: number) =>
      values.forEach((v, j) => {
        if (size === 1) b[off + j] = v;
        else if (size === 2) w16(b, v, off + j * 2);
        else w32(b, v, off + j * 4);
      });
    if (size * values.length <= 4) {
      put(ifd, o + 8);
    } else {
      const blob = Buffer.alloc(size * values.length);
      put(blob, 0);
      w32(ifd, extraAt + extraLen, o + 8);
      extras.push(blob);
      extraLen += blob.length;
    }
  });
  return Buffer.concat([header, data, ifd, ...extras]);
}

// 2x1 uncompressed RGB: red, blue.
function rgbTiff(le: boolean): Buffer {
  return tinyTiff(
    [
      [256, 3, [2]], // ImageWidth
      [257, 3, [1]], // ImageLength
      [258, 3, [8, 8, 8]], // BitsPerSample (out-of-line: 6 bytes)
      [259, 3, [1]], // Compression: none
      [262, 3, [2]], // Photometric: RGB
      [273, 4, [8]], // StripOffsets
      [277, 3, [3]], // SamplesPerPixel
      [279, 4, [6]], // StripByteCounts
    ],
    Buffer.from([255, 0, 0, 0, 0, 255]),
    le
  );
}

test("tiffToPng decodes uncompressed RGB in both byte orders", () => {
  for (const le of [true, false]) {
    const png = PNG.sync.read(tiffToPng(rgbTiff(le)));
    assert.equal(png.width, 2);
    assert.equal(png.height, 1);
    assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255], `le=${le}`);
    assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 255, 255], `le=${le}`);
  }
});

test("TIFF ignores unknown metadata without allocating its numeric arrays", () => {
  for (const le of [true, false]) {
    const entries: Array<[number, number, number[]]> = [
      [256, 3, [1]], [257, 3, [1]], [258, 3, [8]], [262, 3, [1]], [273, 4, [8]],
    ];
    for (let tag = 500; tag < 504; tag++) entries.push([tag, 1, new Array(65536).fill(0)]);
    const fixture = tinyTiff(entries, Buffer.from([123]), le);
    const OriginalArray = Array;
    let largest = 0;
    globalThis.Array = new Proxy(OriginalArray, {
      construct(target, args, newTarget) {
        if (args.length === 1 && typeof args[0] === "number") largest = Math.max(largest, args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
    try {
      const png = PNG.sync.read(tiffToPng(fixture));
      assert.deepEqual([...png.data], [123, 123, 123, 255]);
      assert.ok(largest < 65536);
    } finally { globalThis.Array = OriginalArray; }
  }
});

test("TIFF rejects duplicate and oversized consumed metadata before decoding", () => {
  const base: Array<[number, number, number[]]> = [
    [256, 3, [1]], [257, 3, [1]], [258, 3, [8]], [262, 3, [1]], [273, 4, [8]],
  ];
  assert.throws(() => tiffToPng(tinyTiff([...base, [256, 3, [1]]], Buffer.from([0]))), /duplicate/);
  assert.throws(() => tiffToPng(tinyTiff([...base, [279, 4, new Array(65536).fill(1)]], Buffer.from([0]))), /budget/);
  assert.throws(() => tiffToPng(tinyTiff(base.map(e => e[0] === 256 ? [256, 4, [1, 1]] : e), Buffer.from([0]))), /scalar/);
});

test("tiffToPng keeps alpha from an RGBA extra sample", () => {
  const tif = tinyTiff(
    [
      [256, 3, [1]],
      [257, 3, [1]],
      [258, 3, [8, 8, 8, 8]],
      [259, 3, [1]],
      [262, 3, [2]],
      [273, 4, [8]],
      [277, 3, [4]],
      [279, 4, [4]],
      [338, 3, [2]], // ExtraSamples: unassociated alpha
    ],
    Buffer.from([255, 0, 0, 128])
  );
  assert.deepEqual([...PNG.sync.read(tiffToPng(tif)).data], [255, 0, 0, 128]);
});

test("tiffToPng expands PackBits runs across grayscale strips", () => {
  // 4x2 8-bit grayscale, one strip per row: row 0 a PackBits run of 200s,
  // row 1 four literals — pins strip iteration and both packet forms.
  const data = Buffer.from([0xfd, 200, 3, 10, 20, 30, 40]);
  const tif = tinyTiff(
    [
      [256, 3, [4]],
      [257, 3, [2]],
      [258, 3, [8]],
      [259, 3, [32773]],
      [262, 3, [1]], // BlackIsZero
      [273, 4, [8, 10]],
      [278, 3, [1]], // RowsPerStrip
      [279, 4, [2, 5]],
    ],
    data
  );
  const png = PNG.sync.read(tiffToPng(tif));
  assert.deepEqual([...png.data.subarray(0, 4)], [200, 200, 200, 255]);
  assert.deepEqual([...png.data.subarray(16, 20)], [10, 10, 10, 255]);
  assert.deepEqual([...png.data.subarray(28, 32)], [40, 40, 40, 255]);
});

test("tiffToPng expands bilevel and 4-bit grayscale, honoring WhiteIsZero", () => {
  // 8x1 1-bit WhiteIsZero: 0xA0 = bits 1,0,1,0,0,0,0,0 — set bits are black.
  const bilevel = tinyTiff(
    [
      [256, 3, [8]],
      [257, 3, [1]],
      [259, 3, [1]],
      [262, 3, [0]], // WhiteIsZero (BitsPerSample defaults to 1)
      [273, 4, [8]],
      [279, 4, [1]],
    ],
    Buffer.from([0xa0])
  );
  const bl = PNG.sync.read(tiffToPng(bilevel));
  assert.deepEqual([...bl.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...bl.data.subarray(4, 8)], [255, 255, 255, 255]);
  assert.deepEqual([...bl.data.subarray(8, 12)], [0, 0, 0, 255]);

  // 3x1 4-bit grayscale: nibbles 0, 15, 8 → 0, 255, 136.
  const gray4 = tinyTiff(
    [
      [256, 3, [3]],
      [257, 3, [1]],
      [258, 3, [4]],
      [259, 3, [1]],
      [262, 3, [1]],
      [273, 4, [8]],
      [279, 4, [2]],
    ],
    Buffer.from([0x0f, 0x80])
  );
  const g4 = PNG.sync.read(tiffToPng(gray4));
  assert.deepEqual([...g4.data.subarray(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...g4.data.subarray(4, 8)], [255, 255, 255, 255]);
  assert.deepEqual([...g4.data.subarray(8, 12)], [136, 136, 136, 255]);
});

test("tiffToPng resolves palettes, including 8-bit-quirk colormaps", () => {
  // 2x1 4-bit palette: entry 0 magenta, entry 1 cyan (ColorMap is all R,
  // then all G, then all B). Once with spec 16-bit values, once with the
  // buggy-writer 8-bit values some tools emit.
  const cmap = (max: number): number[] => {
    const r = new Array(48).fill(0);
    r[0] = max; r[32] = max; // entry 0: R + B
    r[17] = max; r[33] = max; // entry 1: G + B
    return r;
  };
  for (const max of [65535, 255]) {
    const tif = tinyTiff(
      [
        [256, 3, [2]],
        [257, 3, [1]],
        [258, 3, [4]],
        [259, 3, [1]],
        [262, 3, [3]], // Palette
        [273, 4, [8]],
        [279, 4, [1]],
        [320, 3, cmap(max)],
      ],
      Buffer.from([0x01]) // nibbles 0, 1
    );
    const png = PNG.sync.read(tiffToPng(tif));
    assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 255, 255], `max=${max}`);
    assert.deepEqual([...png.data.subarray(4, 8)], [0, 255, 255, 255], `max=${max}`);
  }
});

test("tiffToPng converts CMYK inks in both byte orders", () => {
  // 4x1: no ink (white), pure cyan, pure black, and a rounding case —
  // C=128 under K=128 must match Pillow's MULDIV255 arithmetic exactly.
  const inks = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 255, 128, 0, 0, 128]);
  for (const le of [true, false]) {
    const tif = tinyTiff(
      [
        [256, 3, [4]],
        [257, 3, [1]],
        [258, 3, [8, 8, 8, 8]],
        [259, 3, [1]],
        [262, 3, [5]], // Separated (CMYK)
        [273, 4, [8]],
        [277, 3, [4]],
        [279, 4, [16]],
      ],
      inks,
      le
    );
    const png = PNG.sync.read(tiffToPng(tif));
    assert.deepEqual([...png.data.subarray(0, 4)], [255, 255, 255, 255], `le=${le}`);
    assert.deepEqual([...png.data.subarray(4, 8)], [0, 255, 255, 255], `le=${le}`);
    assert.deepEqual([...png.data.subarray(8, 12)], [0, 0, 0, 255], `le=${le}`);
    assert.deepEqual([...png.data.subarray(12, 16)], [63, 127, 127, 255], `le=${le}`);
  }
});

test("tiffToPng decodes PackBits CMYK and rejects non-CMYK separations", () => {
  // 2x1 cyan + black behind one literal PackBits packet — pins the 4-sample
  // row width through the compressed path.
  const packed = Buffer.from([7, 255, 0, 0, 0, 0, 0, 0, 255]);
  const tif = tinyTiff(
    [
      [256, 3, [2]],
      [257, 3, [1]],
      [258, 3, [8, 8, 8, 8]],
      [259, 3, [32773]],
      [262, 3, [5]],
      [273, 4, [8]],
      [277, 3, [4]],
      [279, 4, [packed.length]],
    ],
    packed
  );
  const png = PNG.sync.read(tiffToPng(tif));
  assert.deepEqual([...png.data.subarray(0, 4)], [0, 255, 255, 255]);
  assert.deepEqual([...png.data.subarray(4, 8)], [0, 0, 0, 255]);

  const cmyk1x1 = (extra: Array<[number, number, number[]]>): Buffer =>
    tinyTiff(
      [
        [256, 3, [1]],
        [257, 3, [1]],
        [258, 3, [8, 8, 8, 8]],
        [259, 3, [1]],
        [262, 3, [5]],
        [273, 4, [8]],
        [277, 3, [4]],
        [279, 4, [4]],
        ...extra,
      ],
      Buffer.from([0, 0, 0, 0])
    );
  assert.throws(() => tiffToPng(cmyk1x1([[332, 3, [2]]])), /CMYK/); // InkSet: not CMYK
  const spp3 = tinyTiff(
    [
      [256, 3, [1]],
      [257, 3, [1]],
      [258, 3, [8, 8, 8]],
      [259, 3, [1]],
      [262, 3, [5]],
      [273, 4, [8]],
      [277, 3, [3]],
      [279, 4, [3]],
    ],
    Buffer.from([0, 0, 0])
  );
  assert.throws(() => tiffToPng(spp3), /CMYK/);
});

/** Pack 9-bit LZW codes MSB-first (enough for streams that never grow the
 *  code width). */
function lzwPack(codes: number[]): Buffer {
  const out = Buffer.alloc(Math.ceil((codes.length * 9) / 8));
  codes.forEach((c, i) => {
    for (let b = 0; b < 9; b++) {
      if (c & (0x100 >> b)) out[(i * 9 + b) >> 3] |= 0x80 >> ((i * 9 + b) & 7);
    }
  });
  return out;
}

test("tiffToPng decodes LZW with the horizontal predictor", () => {
  // 4x1 RGB, all red. Differenced row: [255,0,0, 0,0,0 ×3]; its LZW stream
  // (hand-traced) exercises the KwKwK self-reference path three times.
  const stream = lzwPack([256, 255, 0, 259, 260, 261, 0, 257]);
  const tif = tinyTiff(
    [
      [256, 3, [4]],
      [257, 3, [1]],
      [258, 3, [8, 8, 8]],
      [259, 3, [5]], // LZW
      [262, 3, [2]],
      [273, 4, [8]],
      [277, 3, [3]],
      [279, 4, [stream.length]],
      [317, 3, [2]], // horizontal predictor
    ],
    stream
  );
  const png = PNG.sync.read(tiffToPng(tif));
  for (let x = 0; x < 4; x++) {
    assert.deepEqual([...png.data.subarray(x * 4, x * 4 + 4)], [255, 0, 0, 255], `x=${x}`);
  }
});

test("tiffToPng throws on garbage, out-of-scope layouts, and truncation", () => {
  assert.throws(() => tiffToPng(Buffer.from("definitely not a tiff")));
  const huge = rgbTiff(true);
  huge.writeUInt16LE(65535, 8 + 6 + 2 + 8); // width entry value (tag 256 sorts first)
  huge.writeUInt16LE(65535, 8 + 6 + 2 + 12 + 8); // height entry value
  assert.throws(() => tiffToPng(huge), /dimensions/);
  const base: Array<[number, number, number[]]> = [
    [256, 3, [2]], [257, 3, [1]], [258, 3, [8, 8, 8]], [259, 3, [1]],
    [262, 3, [2]], [273, 4, [8]], [277, 3, [3]], [279, 4, [6]],
  ];
  const px = Buffer.from([255, 0, 0, 0, 0, 255]);
  assert.throws(() => tiffToPng(tinyTiff([...base, [322, 3, [16]], [323, 3, [16]]], px)), /tiled/);
  assert.throws(() => tiffToPng(tinyTiff([...base, [284, 3, [2]]], px)), /planar/);
  assert.throws(() => tiffToPng(tinyTiff([...base.filter(e => e[0] !== 259), [259, 3, [6]]], px)), /compression/);
  assert.throws(() => tiffToPng(tinyTiff([...base.filter(e => e[0] !== 273), [273, 4, [1 << 20]]], px)), /truncated/);
});

test("toPng dispatches by mime", () => {
  const tga = Buffer.concat([tgaHeader(2, 1, 1, 24, 0x20), Buffer.from([0, 0, 255])]);
  assert.deepEqual([...PNG.sync.read(toPng("image/x-tga", tga)).data], [255, 0, 0, 255]);
  assert.deepEqual([...PNG.sync.read(toPng("image/bmp", tinyBmp())).data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...PNG.sync.read(toPng("image/tiff", rgbTiff(true))).data.subarray(0, 4)], [255, 0, 0, 255]);
});
