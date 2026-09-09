import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import pg from "pg";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { canReadMagImage } from "../src/lib/mag/access";
import { getExtract, getIssueExtracts, listMagazines, listIssues, amendExtract } from "../src/lib/mag/queries";
import config from "../next.config";

const pageSha = "aa".repeat(32), cropSha = "bb".repeat(32);

test("the public image optimizer cannot cache authorization-sensitive app images", () => {
  assert.equal(config.images?.unoptimized, true);
});

test("private pages are denied while public crops and moderator editing remain available", {skip:!process.env.PGHOST}, async () => {
  const database = `prism_mag_access_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({database:"postgres"});
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = new pg.Pool({database});
  try {
    await pool.query("CREATE EXTENSION pg_trgm; CREATE TABLE games(id bigserial PRIMARY KEY,name text,system text,slug text)");
    await pool.query(readFileSync(new URL("../db/migrations/012-magazines.sql", import.meta.url), "utf8"));
    await pool.query("INSERT INTO magazines(id,slug,title,pages_public) VALUES(1,'test','Test',false)");
    await pool.query("INSERT INTO magazine_issue(id,magazine_id,slug,label) VALUES(1,1,'1','One')");
    await pool.query("INSERT INTO magazine_page(id,issue_id,pdf_index,image_sha256) VALUES(1,1,1,$1)", [pageSha]);
    await pool.query("INSERT INTO magazine_extract(id,issue_id,kind) VALUES(1,1,'review')");
    await pool.query("INSERT INTO extract_region(extract_id,page_id,x,y,w,h,crop_sha256) VALUES(1,1,0,0,0.5,0.5,$1)", [cropSha]);
    assert.equal(await canReadMagImage(pool,pageSha,false),false);
    assert.equal(await canReadMagImage(pool,pageSha,true),true);
    assert.equal(await canReadMagImage(pool,cropSha,false),true);
    assert.equal(await canReadMagImage(pool,'cc'.repeat(32),true),false);
    assert.equal((await getExtract(pool,1))!.regions[0].page_sha256,null);
    assert.equal((await getExtract(pool,1))!.regions[0].crop_sha256,cropSha);
    assert.equal((await getIssueExtracts(pool,1))[0].regions[0].page_sha256,null);
    assert.equal((await getExtract(pool,1,true))!.regions[0].page_sha256,pageSha);
    assert.equal((await amendExtract(pool,1,{fields:{title:'Updated'}},'test'))!.regions[0].page_sha256,pageSha);
    assert.equal((await listMagazines(pool))[0].cover_sha,null);
    assert.equal((await listIssues(pool,1))[0].cover_sha,null);
    await pool.query("UPDATE magazines SET pages_public=true");
    assert.equal(await canReadMagImage(pool,pageSha,false),true);
    assert.equal((await getExtract(pool,1))!.regions[0].page_sha256,pageSha);
    assert.equal((await listMagazines(pool))[0].cover_sha,pageSha);
    await pool.query("UPDATE magazines SET pages_public=false; UPDATE magazine_extract SET status='rejected'");
    assert.equal(await canReadMagImage(pool,pageSha,false),false);
    assert.equal(await canReadMagImage(pool,cropSha,false),false);
    assert.equal(await canReadMagImage(pool,cropSha,true),true);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
});

test("blob and thumbnail routes authorize before storage, conversion and conditional responses", async () => {
  const mocks: Record<string,string> = {
    "test:state": `export const state={public:false,reads:0,converts:0};`,
    "@/lib/db": `import {state} from 'test:state';export const getPool=()=>({query:async(_q,p)=>({rows:[{allowed:state.public||p[1]}]})});`,
    "@/lib/auth": `export const getModerator=async(r)=>r.headers.get('x-moderation-token')==='fixture'?'test':null;`,
    "@/lib/blobstore": `import {Readable} from 'node:stream';import {state} from 'test:state';
      export const blobSize=async()=>{state.reads++;return 4;};
      export const openBlobStream=async()=>{state.reads++;return Readable.from([Buffer.from([137,80,78,71])]);};`,
    "@/lib/ffmpeg": `import {state} from 'test:state';export const isPhotoScaleWidth=w=>w===500||w===1000;
      export const ensurePhotoScale=async()=>{state.converts++;throw new Error('no converter');};`,
    "@/lib/mag/store": `export const MAG_NS='mag';`,
  };
  const result = await build({stdin:{contents:`export {GET as blob} from './src/app/api/mag/blob/[sha256]/route';
      export {GET as thumb} from './src/app/api/mag/blob/[sha256]/thumb/route';export {state} from 'test:state';`,
    resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',
    plugins:[{name:'image-fixtures',setup(b){
      b.onResolve({filter:/.*/},a=>a.path in mocks?{path:a.path,namespace:'fixture'}:undefined);
      b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'ts'}));
    }}]});
  const module={exports:{} as any};
  new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const {blob,thumb,state}=module.exports;
  const request=(etag:string,mod=false)=>{
    const r=new Request('https://example.test/api/mag/blob/'+pageSha,{headers:{'if-none-match':etag,...(mod?{'x-moderation-token':'fixture'}:{})}});
    return Object.assign(r,{nextUrl:new URL(r.url)});
  };
  const ctx={params:Promise.resolve({sha256:pageSha})};
  for(const [route,etag] of [[blob,`"${pageSha}-mag"`],[thumb,`"${pageSha}-magthumb-500"`]] as const){
    const denied=await route(request(etag),ctx);
    assert.equal(denied.status,404);
    assert.equal(denied.headers.get('cache-control'),'private, no-store');
    assert.equal(state.reads,0);assert.equal(state.converts,0);
    const allowed=await route(request(etag,true),ctx);
    assert.equal(allowed.status,304);
    assert.match(allowed.headers.get('vary'),/Cookie/);
    state.reads=0;
  }
  state.public=true;
  const publicImage=await blob(request(''),ctx);
  assert.equal(publicImage.status,200);
  assert.equal(publicImage.headers.get('location'),null);
  assert.equal((await publicImage.arrayBuffer()).byteLength,4);
  const fallback=await thumb(request(''),ctx);
  assert.equal(fallback.status,307);
  assert.equal(fallback.headers.get('location'),`/api/mag/blob/${pageSha}`);
  assert.equal(fallback.headers.get('cache-control'),'private, no-store');
  state.public=false;
  assert.equal((await blob(request(`"${pageSha}-mag"`),ctx)).status,404);
});
