import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ConversionQueue, ConversionBusy, conversionBusyResponse } from "../src/lib/conversion-queue";
import { socialPreviews, socialPreviewResponse, conversions } from "../src/lib/conversion-queue";

test("mixed conversion jobs share admission and identical jobs coalesce", async () => {
  const queue = new ConversionQueue(2, 2);
  let active = 0, peak = 0, started = 0;
  const release: Array<() => void> = [];
  const work = async () => {
    started++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => release.push(resolve));
    active--;
    return "converted";
  };
  const a = queue.run("video:a", work);
  const b = queue.run("pdf:b", work);
  const c = queue.run("issue:c", work);
  const d = queue.run("png:d", work);
  assert.equal(queue.run("issue:c", work), c);
  await Promise.resolve();
  assert.equal(started, 2); // queued input has not been loaded
  await assert.rejects(queue.run("audio:e", work), ConversionBusy);
  release.shift()!(); release.shift()!();
  await Promise.all([a, b]);
  await Promise.resolve();
  assert.equal(started, 4);
  release.shift()!(); release.shift()!();
  assert.deepEqual(await Promise.all([c, d]), ["converted", "converted"]);
  assert.equal(peak, 2);
});

test("errors and expired queue entries release admission", async () => {
  const queue = new ConversionQueue(1, 1, 10);
  await assert.rejects(queue.run("bad", async () => { throw new Error("decode"); }), /decode/);
  let release!: () => void;
  const active = queue.run("slow", () => new Promise<void>(resolve => { release = resolve; }));
  let started = false;
  const queued = queue.run("waiting", async () => { started = true; });
  await Promise.all([assert.rejects(queued, ConversionBusy), delay(20)]);
  assert.equal(started, false);
  release(); await active;
  assert.equal(await queue.run("waiting", async () => "retried"), "retried");
  const response = conversionBusyResponse(new ConversionBusy())!;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal(conversionBusyResponse(new Error("decode")), null);
});

test("cards are admitted before input loading, coalesce readable bodies, and never cache overload", async () => {
  const release: Array<() => void> = [];
  const held = Array.from({ length: 18 }, (_, i) => socialPreviews.run(`hold:${i}`,
    () => new Promise<void>(resolve => release.push(resolve))));
  let loaded = 0;
  const response = await socialPreviewResponse("overflow", async () => {
    loaded++; return new ArrayBuffer(1);
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(loaded, 0);
  for (let i = 0; i < 9; i++) {
    await Promise.resolve();
    release.splice(0).forEach(done => done());
    await new Promise<void>(done => setImmediate(done));
  }
  await Promise.all(held);

  const work = async () => {
    loaded++;
    // Leaf work has its own bounded lane; holding a card slot can't deadlock it.
    return conversions.run("card-leaf", async () => new Uint8Array([1, 2, 3]).buffer);
  };
  const [a, b] = await Promise.all([
    socialPreviewResponse("same-card", work), socialPreviewResponse("same-card", work),
  ]);
  assert.equal(loaded, 1);
  assert.deepEqual(new Uint8Array(await a.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const busy = await socialPreviewResponse("busy-leaf", async () => { throw new ConversionBusy(); });
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("cache-control"), "no-store");
});
