import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, utimes, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assetBlobPath, assetStagingPath, assetStagingStats, inventoryAssetBytes, storeIdentity } from "../src/lib/blobstore";
import { initializeUploadQuota, withUploadQuota, reapUploadQuotaStaging } from "../src/lib/upload-quota";

async function uploadRoute() {
  const mocks: Record<string,string> = {
    'test:state': `export const state={pool:null,sha:'',size:0};`,
    '@/lib/db': `import {state} from 'test:state';export const getPool=()=>state.pool;`,
    '@/lib/submission-assets': `import {state} from 'test:state';export const MAX_BUILD_ASSET_BYTES=100;
      export const referencedAssets=async()=>({sizes:new Map([[state.sha,state.size]]),totalBytes:state.size});`,
    '@/lib/ratelimit': `export const rateLimitCheck=()=>({ok:true});export const clientKey=()=>'';`,
  };
  const bundle = await build({stdin:{contents:`export {PUT} from './src/app/api/submissions/[sha256]/assets/[assetSha]/route';
      export {state} from 'test:state';`,resolveDir:fileURLToPath(new URL('..',import.meta.url)),loader:'ts'},
    bundle:true,write:false,platform:'node',format:'cjs',packages:'external',
    plugins:[{name:'upload-fixture',setup(b){
      b.onResolve({filter:/.*/},a=>a.path in mocks?{path:a.path,namespace:'fixture'}:undefined);
      b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:mocks[a.path],loader:'ts'}));
    }}]});
  const module={exports:{} as any};
  new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  return module.exports;
}

test("durable quota includes old objects and serializes reservations", { skip: !process.env.PGHOST }, async () => {
  // Explicit local-test opt-in, never inherit DATABASE_URL into a fixture.
  const database = `prism_quota_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ database: "postgres" });
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = new pg.Pool({ database });
  const oldStore = process.env.ASSET_STORE_DIR;
  process.env.ASSET_STORE_DIR = await mkdtemp(join(tmpdir(), "prism-quota-test-"));
  const a = "aa".repeat(32), b = "bb".repeat(32), approved = "cc".repeat(32), orphan = "dd".repeat(32);
  const store = async (sha: string, size: number) => {
    await mkdir(dirname(assetBlobPath(sha)), { recursive: true });
    await writeFile(assetBlobPath(sha), Buffer.alloc(size));
    return Response.json({ status: "stored" });
  };
  try {
    assert.equal((await pool.query("SELECT current_database() AS name")).rows[0].name, database);
    await pool.query("CREATE TABLE build_asset(sha256 text,size bigint)");
    await pool.query(readFileSync(new URL("../db/migrations/013-upload-quota.sql", import.meta.url), "utf8"));
    assert.equal((await withUploadQuota(pool, a, 5, () => assert.fail("not initialized"))).status, 503);
    await store(orphan, 5);
    await store(approved, 20);
    await pool.query("INSERT INTO build_asset VALUES ($1,$2)", [approved, 20]);
    await initializeUploadQuota(pool, inventoryAssetBytes());
    assert.equal((await pool.query("SELECT store_identity FROM upload_quota_config")).rows[0].store_identity, storeIdentity());
    await pool.query("UPDATE upload_quota_config SET limit_bytes=10");
    assert.equal((await withUploadQuota(pool, a, 5, () => store(a, 5))).status, 200);
    assert.equal((await withUploadQuota(pool, b, 1, () => assert.fail("quota exceeded"))).status, 507);
    assert.equal((await withUploadQuota(pool, approved, 20, () => store(approved, 20))).status, 200);
    assert.equal((await withUploadQuota(pool, a, 5, async () => Response.json({ status: "exists" }))).status, 200);
    await assert.rejects(initializeUploadQuota(pool, inventoryAssetBytes()), /already initialized/);

    // Independent digests cannot both reserve six bytes of a ten-byte budget.
    await pool.query("DELETE FROM upload_quota");
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = withUploadQuota(pool, a, 6, async () => { entered(); await waiting; return store(a, 6); });
    await started;
    assert.equal((await withUploadQuota(pool, b, 6, () => assert.fail("concurrent over-reservation"))).status, 507);
    assert.equal((await withUploadQuota(pool, a, 6, () => assert.fail("same-digest write overlap"))).status, 429);
    // Streaming work does not retain one of the shared pool's connections.
    assert.equal((await Promise.race([pool.query("SELECT 1 AS ok").then(() => "ok"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 500))])), "ok");
    release();
    await first;
    await assert.rejects(withUploadQuota(pool, b, 4, async () => { throw new Error("failed before storage"); }), /failed before storage/);
    assert.equal((await pool.query("SELECT 1 FROM upload_quota WHERE sha256=$1", [b])).rowCount, 0);
    assert.equal((await pool.query("SELECT bytes::text FROM upload_quota WHERE sha256=$1", [a])).rows[0].bytes, "6");

    // Stale staging can be reclaimed even when no fresh reservation fits.
    await mkdir(dirname(assetStagingPath(b)), {recursive:true});
    await writeFile(assetStagingPath(b), Buffer.alloc(4));
    const stale = new Date(Date.now()-48*3600_000);
    await utimes(assetStagingPath(b),stale,stale);
    await pool.query("INSERT INTO upload_quota(sha256,bytes) VALUES($1,4)",[b]);
    assert.equal((await withUploadQuota(pool, 'ee'.repeat(32), 1, () => assert.fail("full quota"))).status,507);
    await reapUploadQuotaStaging(pool);
    await assert.rejects(stat(assetStagingPath(b)), {code:'ENOENT'});
    assert.equal((await pool.query("SELECT 1 FROM upload_quota WHERE sha256=$1",[b])).rowCount,0);

    // A slow writer retains ownership through the reaper's stat/delete path.
    let finish!: () => void, notify!: () => void;
    const gate = new Promise<void>(r=>{finish=r;});
    const enteredLease = new Promise<void>(r=>{notify=r;});
    const writing = withUploadQuota(pool,b,4,async()=>{
      await writeFile(assetStagingPath(b),'1234');
      await utimes(assetStagingPath(b),stale,stale);
      notify(); await gate;
      return Response.json({status:'partial',offset:4});
    });
    await enteredLease;
    try {
      await reapUploadQuotaStaging(pool);
      assert.equal((await readFile(assetStagingPath(b))).toString(),'1234');
      assert.equal((await withUploadQuota(pool,b,4,()=>assert.fail('overlapping restart'))).status,429);
    } finally {finish();await writing;}
    assert.equal((await pool.query("SELECT active FROM upload_quota WHERE sha256=$1",[b])).rows[0].active,0);
    await reapUploadQuotaStaging(pool);
    await assert.rejects(stat(assetStagingPath(b)),{code:'ENOENT'});

    // Actual route: a concurrent restart cannot truncate a streaming upload,
    // nor may opportunistic reaping remove its deliberately aged partial file.
    const route = await uploadRoute();
    const token = '12'.repeat(16);
    const content = Buffer.from('abc');
    const sha = createHash('sha256').update(content).digest('hex');
    Object.assign(route.state,{pool,sha,size:content.length});
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(content.subarray(0,1));}});
    const url = `https://example.test/api/submissions/${'ff'.repeat(32)}/assets/${sha}?offset=0`;
    const ctx = {params:Promise.resolve({sha256:'ff'.repeat(32),assetSha:sha})};
    const uploading = route.PUT(new Request(url,{method:'PUT',body,headers:{'x-upload-token':token},duplex:'half'} as RequestInit),ctx);
    try {
      let started = false;
      for(let i=0;i<100;i++) {
        if(await stat(assetStagingPath(sha,token)).then(s=>s.size===1,()=>false)){started=true;break;}
        await new Promise(r=>setTimeout(r,5));
      }
      assert.equal(started,true);
      await utimes(assetStagingPath(sha,token),stale,stale);
      const overlap = await route.PUT(new Request(url,{method:'PUT',body:'abc'}),ctx);
      assert.equal(overlap.status,429);
      assert.equal((await readFile(assetStagingPath(sha,token))).toString(),'a');
      controller.enqueue(content.subarray(1));controller.close();
      assert.equal((await uploading).status,201);
      assert.equal((await readFile(assetBlobPath(sha))).toString(),'abc');
      assert.equal((await pool.query('SELECT bytes::text,active FROM upload_quota WHERE sha256=$1',[sha])).rows[0].bytes,'3');
    } catch(error) {controller.error(error);await uploading.catch(()=>{});throw error;}

    // An existing immutable blob remains idempotent even at the exact cap.
    await pool.query('UPDATE upload_quota_config SET limit_bytes=9');
    assert.equal((await route.PUT(new Request(url,{method:'PUT',body:'abc'}),ctx)).status,200);

    // Remote uploads reserve their temporary second copy before any S3 call.
    const endpoint = process.env.ASSET_S3_ENDPOINT;
    try {
      process.env.ASSET_S3_ENDPOINT='http://127.0.0.1:1';
      await pool.query('UPDATE upload_quota_config SET store_identity=$1',[storeIdentity()]);
      assert.equal((await withUploadQuota(pool,'ee'.repeat(32),5,()=>assert.fail('remote copy exceeds quota'))).status,507);
    } finally {
      if(endpoint===undefined) delete process.env.ASSET_S3_ENDPOINT; else process.env.ASSET_S3_ENDPOINT=endpoint;
      await pool.query('UPDATE upload_quota_config SET store_identity=$1',[storeIdentity()]);
    }
  } finally {
    if (oldStore === undefined) delete process.env.ASSET_STORE_DIR; else process.env.ASSET_STORE_DIR = oldStore;
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
});

test("private upload capabilities isolate restarts, offsets and retained-byte charges", {skip:!process.env.PGHOST}, async () => {
  const database=`prism_upload_owners_${process.pid}_${Date.now()}`;
  const admin=new pg.Pool({database:'postgres'});
  await admin.query(`CREATE DATABASE ${database}`);
  const pool=new pg.Pool({database});
  const oldStore=process.env.ASSET_STORE_DIR;
  process.env.ASSET_STORE_DIR=await mkdtemp(join(tmpdir(),'prism-owner-test-'));
  try {
    await pool.query('CREATE TABLE build_asset(sha256 text,size bigint)');
    for(const migration of ['013-upload-quota.sql']) {
      await pool.query(readFileSync(new URL(`../db/migrations/${migration}`,import.meta.url),'utf8'));
    }
    const legacy='77'.repeat(32);
    await mkdir(dirname(assetStagingPath(legacy)),{recursive:true});
    await writeFile(assetStagingPath(legacy),Buffer.alloc(20));
    await pool.query('INSERT INTO build_asset VALUES($1,20)',[legacy]);
    await initializeUploadQuota(pool,inventoryAssetBytes());
    await pool.query('UPDATE upload_quota_config SET limit_bytes=20');
    assert.equal((await withUploadQuota(pool,legacy,20,()=>assert.fail('legacy partial exemption'),'77'.repeat(16))).status,507);
    const oldDate=new Date(Date.now()-48*3600_000);
    await utimes(assetStagingPath(legacy),oldDate,oldDate);
    await reapUploadQuotaStaging(pool);
    await pool.query('UPDATE upload_quota_config SET limit_bytes=20');
    const route=await uploadRoute();
    const sha=createHash('sha256').update('abcdef').digest('hex');
    const a='aa'.repeat(16), b='bb'.repeat(16);
    Object.assign(route.state,{pool,sha,size:6});
    const put=(token:string|null,offset:number,body:string)=>route.PUT(new Request(
      `https://example.test/api/submissions/${'ff'.repeat(32)}/assets/${route.state.sha}?offset=${offset}`,
      {method:'PUT',body,headers:token===null?{}:{'x-upload-token':token}}),
      {params:Promise.resolve({sha256:'ff'.repeat(32),assetSha:route.state.sha})});
    assert.equal((await put(a,0,'abc')).status,202);
    const stolenOffset=await put(b,3,'def');
    assert.equal(stolenOffset.status,409);
    assert.equal((await stolenOffset.json()).offset,0);
    assert.equal((await readFile(assetStagingPath(sha,a))).toString(),'abc');
    await pool.query('UPDATE upload_quota_config SET limit_bytes=7');
    assert.equal((await put(b,0,'xy')).status,507); // second copy must reserve additional room
    await pool.query('UPDATE upload_quota_config SET limit_bytes=20');
    assert.equal((await put(b,0,'xy')).status,202);
    assert.equal((await put(a,0,'ab')).status,202);
    assert.equal((await readFile(assetStagingPath(sha,b))).toString(),'xy');
    assert.deepEqual(await assetStagingStats(sha),{bytes:4,count:2});
    assert.equal((await put(a,2,'cdef')).status,201);
    assert.equal((await readFile(assetBlobPath(sha))).toString(),'abcdef');
    assert.deepEqual((await pool.query('SELECT bytes::text,stored_bytes::text FROM upload_quota WHERE sha256=$1',[sha])).rows[0],{bytes:'8',stored_bytes:'6'});
    await pool.query('INSERT INTO build_asset VALUES($1,6)',[sha]);
    await pool.query('UPDATE upload_quota_config SET limit_bytes=5');
    assert.equal((await withUploadQuota(pool,'cc'.repeat(32),4,()=>assert.fail('private copy must stay charged'),'cc'.repeat(16))).status,507);
    // Cleanup uses the digest lease and accounts the retained copy separately.
    const stale=new Date(Date.now()-48*3600_000);
    await utimes(assetStagingPath(sha,b),stale,stale);
    await reapUploadQuotaStaging(pool);
    assert.deepEqual(await assetStagingStats(sha),{bytes:0,count:0});

    // Unupgraded callers retain safe one-shot uploads, never shared resumes.
    route.state.sha=createHash('sha256').update('ghijkl').digest('hex');
    await pool.query('UPDATE upload_quota_config SET limit_bytes=100');
    assert.equal((await put(null,0,'gh')).status,400);
    assert.equal((await put(null,2,'ijkl')).status,400);
    assert.equal((await put('../bad',0,'ghijkl')).status,400);
    assert.equal((await put(a,0,'')).status,400);
    assert.deepEqual(await assetStagingStats(route.state.sha),{bytes:0,count:0});
    assert.equal((await put(null,0,'ghijkl')).status,201);

    // Empty/invalid attempts cannot accumulate unlimited capability files.
    route.state.sha=createHash('sha256').update('mnopqr').digest('hex');
    for(let i=0;i<32;i++) await writeFile(assetStagingPath(route.state.sha,i.toString(16).padStart(32,'0')),'m');
    await pool.query('INSERT INTO upload_quota(sha256,bytes,stored_bytes) VALUES($1,32,0)',[route.state.sha]);
    assert.equal((await put(a,0,'m')).status,429);
    assert.equal((await put('0'.repeat(32),1,'n')).status,202); // existing owner still progresses
    assert.equal((await readFile(assetStagingPath(route.state.sha,'0'.repeat(32)))).toString(),'mn');
  } finally {
    if(oldStore===undefined) delete process.env.ASSET_STORE_DIR;else process.env.ASSET_STORE_DIR=oldStore;
    await pool.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();
  }
});
