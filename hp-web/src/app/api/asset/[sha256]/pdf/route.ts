import type { NextRequest } from "next/server";
import { getAssetMeta } from "@/lib/assets";
import { readBlob } from "@/lib/blobstore";
import { gsAvailable, gsToPdf, pdfConvertible } from "@/lib/gs";
import { IMMUTABLE_CACHE, PDF_CSP, contentDisposition } from "@/lib/http";
import { isSha256 } from "@/lib/validate";
import { conversions, conversionBusyResponse } from "@/lib/conversion-queue";

export const runtime = "nodejs";

// GET /api/asset/<sha256>/pdf — a PostScript/EPS/legacy-AI asset converted to
// PDF, vectors intact, for the client-side pdf.js viewer (zoom stays sharp at
// any scale, unlike the /png rasterization). Assets that already are PDFs
// redirect to the raw route; content-addressed, so responses cache hard.

// Matches the adapter's MAX_ASSET_SIZE, so any stored document is convertible.
const MAX_CONVERT_BYTES = 64 * 1024 * 1024;

export async function GET(_request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  const meta = await getAssetMeta(sha256);
  if (!meta) return Response.json({ error: "not found" }, { status: 404 });

  if (meta.mime === "application/pdf") {
    return Response.redirect(new URL(`/api/asset/${sha256}`, _request.url), 308);
  }
  if (!pdfConvertible(meta.mime) || !(await gsAvailable()) || meta.size > MAX_CONVERT_BYTES) {
    return Response.json({ error: `no PDF conversion for ${meta.mime}` }, { status: 415 });
  }

  let pdf: Buffer | null;
  try {
    pdf = await conversions.run(`pdf:${sha256}`, async () => {
      const bytes = await readBlob(sha256);
      return bytes === null ? null : gsToPdf(bytes);
    });
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    return Response.json({ error: "unconvertible document" }, { status: 415 });
  }
  if (pdf === null) return Response.json({ error: "asset bytes not in store" }, { status: 404 });

  const base = (meta.path.split("/").pop() || sha256).replace(/\.[^.]*$/, "");
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": contentDisposition(`${base}.pdf`, true),
      "Cache-Control": IMMUTABLE_CACHE,
      ETag: `"${sha256}-pdf"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": PDF_CSP,
    },
  });
}
