import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCmykPsd } from "../src/lib/psd-cmyk";

function packedLayers(psb: boolean, duplicate = false): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 65535); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const size = (n: number) => {
    if (!psb) return u32(n);
    const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b;
  };
  const rowSize = psb ? u32 : u16;
  const row = Buffer.from([129, 255]); // 128 white samples
  const channel = Buffer.concat([u16(1), rowSize(2), rowSize(2), row, row]);
  const ids = duplicate ? [-1, -1, 1, 2, 3] : [-1, 0, 1, 2, 3];
  const record = Buffer.concat([
    u32(0), u32(0), u32(2), u32(128), u16(5),
    ...ids.map(id => Buffer.concat([u16(id), size(channel.length)])),
    Buffer.from("8BIMnorm"), Buffer.from([255, 0, 0, 0]),
    u32(12), u32(0), u32(0), Buffer.alloc(4),
  ]);
  const layerInfo = Buffer.concat([u16(2), record, record, ...Array.from({ length: 10 }, () => channel)]);
  const layerSection = Buffer.concat([size(layerInfo.length), layerInfo]);
  const composite = Buffer.concat([u16(1), ...Array.from({ length: 8 }, () => rowSize(2)), ...Array.from({ length: 8 }, () => row)]);
  return Buffer.concat([
    Buffer.from("8BPS"), u16(psb ? 2 : 1), Buffer.alloc(6), u16(4), u32(2), u32(128),
    u16(8), u16(4), u32(0), u32(0), size(layerSection.length), layerSection, composite,
  ]);
}

test("PSD and PSB charge all layer, composite and output allocations", () => {
  for (const psb of [false, true]) {
    const bytes = packedLayers(psb);
    assert.ok(bytes.length < 512);
    assert.throws(() => parseCmykPsd(bytes, 6655), /budget/);
    const layersOnly = parseCmykPsd(bytes, 6656);
    assert.equal(layersOnly.layers.length, 2);
    assert.throws(() => layersOnly.composite(), /budget/);
    const full = parseCmykPsd(bytes, 8704);
    assert.deepEqual([...full.layers[0].rgba!.subarray(0, 4)], [255, 255, 255, 255]);
    const composite = full.composite();
    assert.equal(composite.length, 1024);
    assert.equal(full.composite(), composite);
    assert.throws(() => parseCmykPsd(packedLayers(psb, true)), /duplicate/);
  }
});
