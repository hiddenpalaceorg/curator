import type { NextRequest } from "next/server";
import { blobSize, openBlobStream } from "@/lib/blobstore";
import { SANDBOX_CSP, streamResponse } from "@/lib/http";
import { MAG_NS } from "@/lib/mag/store";
import { isSha256 } from "@/lib/validate";
import { getModerator } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { canReadMagImage, MAG_IMAGE_HEADERS } from "@/lib/mag/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mag/blob/<sha256> — one magazine image blob (page render or
// crop). Always authorizes before streaming, even with a public asset
// gateway configured. Serves images
// only: the mag/ namespace also holds source PDFs, which are moderator-only
// and refuse to leave through this route.
export async function GET(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!(await canReadMagImage(getPool(), sha256, !!(await getModerator(request)))))
    return Response.json({ error: "not found" }, { status: 404, headers: MAG_IMAGE_HEADERS });

  const size = await blobSize(sha256, MAG_NS);
  if (size === null) return Response.json({ error: "not found" }, { status: 404 });

  const contentType = sniffImage(await headOf(sha256));
  if (!contentType) return Response.json({ error: "not an image" }, { status: 415 });

  const etag = `"${sha256}-mag"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ...MAG_IMAGE_HEADERS, ETag: etag } });
  }
  const stream = await openBlobStream(sha256, undefined, MAG_NS);
  if (!stream) return Response.json({ error: "not found" }, { status: 404 });
  return streamResponse(stream, size, null, {
    "Content-Type": contentType,
    ...MAG_IMAGE_HEADERS,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": SANDBOX_CSP,
  });
}

async function headOf(sha256: string): Promise<Buffer | null> {
  const stream = await openBlobStream(sha256, { start: 0, end: 15 }, MAG_NS);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function sniffImage(head: Buffer | null): string | null {
  if (!head || head.length < 4) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  return null;
}
