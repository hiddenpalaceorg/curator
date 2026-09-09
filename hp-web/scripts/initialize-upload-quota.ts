import pg from "pg";
import { inventoryAssetBytes } from "../src/lib/blobstore";
import { initializeUploadQuota } from "../src/lib/upload-quota";
import { loadDotEnv } from "./dotenv";

loadDotEnv();
if (process.argv[2] !== "--initialize") throw new Error("Stop old upload workers and import jobs, then pass --initialize");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try { await initializeUploadQuota(pool, inventoryAssetBytes()); console.log("Upload quota inventory complete"); }
finally { await pool.end(); }
