import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Execute the actual route bodies with storage/rendering replaced by counters.
// Keep the real admission queues and image selection code in the bundle.
async function routes() {
  const state = `export const state = { reads: 0, renders: 0, assets: false, hold: null };`;
  const mocks: Record<string, string> = {
    "test:state": state,
    "@/lib/db": `import {state} from 'test:state'; export const getPool=()=>({query:async(sql)=>({rows:
      sql.includes('FROM build_media') ? (state.assets?[]:[{sha256:'a'.repeat(64),content_type:'image/png',size:1,label:'front'}]) :
      sql.includes('FROM build_asset') ? [{sha256:'b'.repeat(64),mime:'image/png'}] :
      sql.includes('count(*)') ? [{n:0}] : [] })});`,
    "@/lib/blobstore": `import {state} from 'test:state'; export const readBlob=async()=>{state.reads++; if(state.hold)await state.hold;return Buffer.from('image');};`,
    "@/lib/queries": `export const resolveBuild=async()=>({sha256:'c'.repeat(64)});export const getBuildMeta=async()=>({sha256:'c'.repeat(64)});`,
    "@/lib/mag/queries": `export const getIssue=async()=>({id:1,pages_public:true});`,
    "@/lib/meta": `export const buildFacts=()=>[];export const displayTitle=()=>'';`,
    "@/lib/slug": `export const parseBuildParam=()=>({hex:'c',slug:''});export const SHORT_SHA_LEN=12;`,
    "@/lib/media": `export const MEDIA_NS='media';`,
    "@/lib/mag/store": `export const MAG_NS='mag';`,
    "@/lib/ffmpeg": `export const ensurePhotoScale=async()=>{throw new Error('unused');};`,
    "@/lib/imgpng": `export const pngConvertible=()=>false;export const toPng=(_mime,bytes)=>bytes;`,
    "next/og": `import {state} from 'test:state';export class ImageResponse {constructor(){state.renders++;}async arrayBuffer(){return new Uint8Array([1,2,3]).buffer;}}`,
  };
  const result = await build({
    stdin: { contents: `export {default as buildCard} from './src/app/builds/[buildId]/opengraph-image';
      export {default as magazineCard} from './src/app/magazines/[slug]/[issue]/opengraph-image';
      export {socialPreviews,conversions} from './src/lib/conversion-queue';export {state} from 'test:state';`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
    plugins: [{ name: "route-fixtures", setup(b) {
      b.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: "fixture" } : undefined);
      b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "ts" }));
    } }],
  });
  const module = { exports: {} as any };
  new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

test("build and magazine cards reject saturation before loading or rendering", async () => {
  const { buildCard, magazineCard, socialPreviews, state } = await routes();
  const release: Array<() => void> = [];
  const held = Array.from({length:18}, (_,i) => socialPreviews.run(`hold:${i}`, () => new Promise<void>(r => release.push(r))));
  try {
    for (const response of await Promise.all([
      buildCard({params:Promise.resolve({buildId:'test'})}),
      magazineCard({params:Promise.resolve({slug:'test',issue:'1'})}),
    ])) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(state.reads, 0);
    assert.equal(state.renders, 0);
  } finally {
    for(let i=0;i<9;i++) {
      release.splice(0).forEach(r=>r());
      await new Promise<void>(r=>setImmediate(r));
    }
    await Promise.all(held);
  }
});

test("duplicate cards retain both bodies and converter overload cannot cache an image-less card", async () => {
  const {buildCard, conversions, state} = await routes();
  let release!: () => void;
  state.hold = new Promise<void>(r=>{release=r;});
  const a = buildCard({params:Promise.resolve({buildId:'test'})});
  const b = buildCard({params:Promise.resolve({buildId:'test'})});
  await new Promise<void>(r=>setImmediate(r));
  assert.equal(state.reads, 1);
  release();
  const responses = await Promise.all([a,b]);
  assert.equal(state.renders, 1);
  for(const response of responses) assert.equal((await response.arrayBuffer()).byteLength, 3);

  state.assets = true;
  const releases: Array<() => void> = [];
  const held = Array.from({length:18},(_,i)=>conversions.run(`leaf:${i}`,()=>new Promise<void>(r=>releases.push(r))));
  try {
    const response = await buildCard({params:Promise.resolve({buildId:'test'})});
    assert.equal(response.status, 503);
    assert.equal(state.renders, 1);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    for(let i=0;i<9;i++) {
      releases.splice(0).forEach(r=>r());
      await new Promise<void>(r=>setImmediate(r));
    }
    await Promise.all(held);
  }
});
