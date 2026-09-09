import { withBoundedBody } from "@/lib/request-body";
import type { NextRequest } from "next/server";
import { requireModerator } from "@/lib/auth";
import { contributionTarget, revalidateBuildPages } from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { upsertSkip, type SkipFlags } from "@/lib/media";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH /api/build/<sha256>/skip { notes?, screenshots?, video?, physical? }:
// moderator-only toggles marking a completeness category as not applicable
// to this build (its 0 in the /builds columns stops rendering orange).
// Omitted fields keep their stored value.
async function boundedPATCH(request: NextRequest, ctx: { params: Promise<{ sha256: string }> }) {
  const denied = await requireModerator(request);
  if (denied) return denied;
  const { sha256 } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const flags: Partial<SkipFlags> = {};
  const FIELDS: Array<[string, keyof SkipFlags]> = [
    ["notes", "skip_notes"],
    ["screenshots", "skip_screenshots"],
    ["video", "skip_video"],
    ["physical", "skip_physical"],
  ];
  for (const [key, col] of FIELDS) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") {
      return Response.json({ error: `${key} must be a boolean` }, { status: 400 });
    }
    flags[col] = v;
  }
  if (!Object.keys(flags).length) {
    return Response.json({ error: "nothing to update (notes, screenshots, video, physical)" }, { status: 400 });
  }

  const pool = getPool();
  const target = await contributionTarget(pool, sha256);
  if (!target) return Response.json({ error: "not found" }, { status: 404 });

  const saved = await upsertSkip(pool, sha256, flags);
  await revalidateBuildPages(sha256, target.name);
  return Response.json({ sha256, ...saved });
}

export const PATCH = withBoundedBody(boundedPATCH);
