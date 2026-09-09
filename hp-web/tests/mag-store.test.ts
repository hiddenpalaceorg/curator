import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cropRegionPng, jpegSize, magImageUrl, pdfPageCount } from "../src/lib/mag/store";

const execFileP = promisify(execFile);

let gsChecked: Promise<boolean> | null = null;
function haveGs(): Promise<boolean> {
  gsChecked ??= execFileP(process.env.GHOSTSCRIPT_BIN || "gs", ["-h"], { timeout: 5000 })
    .then(({ stdout }) => /ghostscript/i.test(stdout))
    .catch(() => false);
  return gsChecked;
}

let ffmpegChecked: Promise<boolean> | null = null;
function haveFfmpeg(): Promise<boolean> {
  ffmpegChecked ??= execFileP(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  return ffmpegChecked;
}

/** Minimal marker stream: SOI, APP0 filler, SOF0 with the given dimensions. */
function fakeJpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(2 + 2 + 15);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

test("jpegSize reads SOF dimensions and rejects non-JPEGs", () => {
  assert.deepEqual(jpegSize(fakeJpeg(512, 256)), { width: 512, height: 256 });
  assert.deepEqual(jpegSize(fakeJpeg(2200, 3003)), { width: 2200, height: 3003 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
  assert.equal(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
});

test("magImageUrl always uses the authorized app route", () => {
  const saved = process.env.ASSET_PUBLIC_BASE;
  try {
    process.env.ASSET_PUBLIC_BASE = "https://prism.example.org/";
    assert.equal(magImageUrl("ab".repeat(32)), `/api/mag/blob/${"ab".repeat(32)}`);
    delete process.env.ASSET_PUBLIC_BASE;
    assert.equal(magImageUrl("ab".repeat(32)), `/api/mag/blob/${"ab".repeat(32)}`);
  } finally {
    if (saved === undefined) delete process.env.ASSET_PUBLIC_BASE;
    else process.env.ASSET_PUBLIC_BASE = saved;
  }
});

test("pdfPageCount counts pages of a generated pdf", async (t) => {
  if (!(await haveGs())) return t.skip("ghostscript not installed");
  const dir = await mkdtemp(join(tmpdir(), "magtest-"));
  try {
    const pdf = join(dir, "three.pdf");
    await execFileP(process.env.GHOSTSCRIPT_BIN || "gs", [
      "-dBATCH", "-dNOPAUSE", "-q", "-sDEVICE=pdfwrite", `-sOutputFile=${pdf}`,
      "-c", "showpage showpage showpage",
    ]);
    assert.equal(await pdfPageCount(pdf), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function pngSize(buf: Buffer): { width: number; height: number } {
  assert.equal(buf.readUInt32BE(0), 0x89504e47);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("cropRegionPng crops the padded rectangle", async (t) => {
  if (!(await haveFfmpeg())) return t.skip("ffmpeg not installed");
  const dir = await mkdtemp(join(tmpdir(), "magtest-"));
  try {
    const page = join(dir, "page.jpg");
    await execFileP(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=1000x1400", "-frames:v", "1", page,
    ]);
    const out = join(dir, "crop.png");
    await cropRegionPng(page, { width: 1000, height: 1400 }, { x: 0.1, y: 0.1, w: 0.5, h: 0.25 }, out);
    const size = pngSize(await readFile(out));
    // 0.5 of 1000 plus 1% padding each side = 520; 0.25 of 1400 + padding = 378.
    assert.equal(size.width, 520);
    assert.equal(size.height, 378);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cropRegionPng clamps at page edges", async (t) => {
  if (!(await haveFfmpeg())) return t.skip("ffmpeg not installed");
  const dir = await mkdtemp(join(tmpdir(), "magtest-"));
  try {
    const page = join(dir, "page.jpg");
    await execFileP(process.env.FFMPEG_BIN || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=800x600", "-frames:v", "1", page,
    ]);
    const out = join(dir, "crop.png");
    await cropRegionPng(page, { width: 800, height: 600 }, { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }, out);
    const size = pngSize(await readFile(out));
    assert.ok(size.width >= 80 && size.width <= 96, `width ${size.width}`);
    assert.ok(size.height >= 60 && size.height <= 72, `height ${size.height}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cropRegionPng survives a page file that is not an image", async (t) => {
  if (!(await haveFfmpeg())) return t.skip("ffmpeg not installed");
  const dir = await mkdtemp(join(tmpdir(), "magtest-"));
  try {
    const page = join(dir, "page.jpg");
    await writeFile(page, "definitely not a jpeg");
    await assert.rejects(
      cropRegionPng(page, { width: 100, height: 100 }, { x: 0, y: 0, w: 1, h: 1 }, join(dir, "out.png"))
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
