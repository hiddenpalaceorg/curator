import fsp from "node:fs/promises";
import type { NextRequest } from "next/server";
import { storeBlobFromFile } from "@/lib/blobstore";
import { requireContributor, revalidateBuildPages } from "@/lib/contrib";
import { getPool } from "@/lib/db";
import { extractStill } from "@/lib/ffmpeg";
import { conversionBusyResponse } from "@/lib/conversion-queue";
import {
  MEDIA_NS,
  dropMediaSession,
  finishMediaSession,
  hashFile,
  inferMediaLabel,
  insertMedia,
  isMediaToken,
  mediaStagingPath,
  mediaView,
  readMediaSession,
  sniffMedia,
  updateMediaSession,
  withMediaSession,
} from "@/lib/media";
import { isSha256 } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Client chunks stay well under proxy body limits; reject anything absurd.
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

// PUT /api/build/<sha256>/media/upload/<token>?offset=N: append one chunk to
// an open upload session. The first chunk is sniffed (magic bytes decide the
// stored content type; the client's claim is ignored) and must agree with the
// session's kind. A stale offset answers 409 { offset } so the client can
// resume. When the staged bytes reach the claimed size the file is hashed,
// stored under the media/ namespace (with a poster still for videos), and
// recorded; the response carries { done: true, media }.
//
// Every step here is safe to repeat, because the client retries: an offset the
// server has already consumed answers 409 with the truth, and a session whose
// row already exists replays { done: true } rather than 404-ing bytes that did
// in fact land. One token is served one request at a time (withMediaSession),
// so a retry arriving alongside the request it is retrying queues behind it.
export async function PUT(
  request: NextRequest,
  ctx: { params: Promise<{ sha256: string; token: string }> }
) {
  const { sha256, token } = await ctx.params;
  if (!isSha256(sha256)) return Response.json({ error: "invalid sha256" }, { status: 400 });
  if (!isMediaToken(token)) return Response.json({ error: "invalid token" }, { status: 400 });

  const pool = getPool();
  const gate = await requireContributor(request, pool, sha256);
  if (!gate.ok) return gate.response;
  const { target } = gate;

  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");

  // Advisory pre-check, before the body is pulled over the wire. A resume, or
  // a retry of a chunk that did land, is answered from what is already on disk:
  // making a client push 8MB only to be told 409 is the wrong move on exactly
  // the flaky connections this protocol exists for. Racy by nature (no lock
  // yet), so it only ever short-circuits. The binding checks are in append().
  const known = await readMediaSession(token);
  if (known && known.build === sha256) {
    if (known.done) return Response.json({ done: true, media: known.done });
    const st = await fsp.stat(mediaStagingPath(token)).catch(() => null);
    if (st && st.size < known.size && offset !== st.size) {
      return Response.json({ offset: st.size }, { status: 409 });
    }
  }

  // Read the body outside the lock: it streams from the client, and holding
  // the token while it arrives would serialise a retry behind the very request
  // it is meant to overtake. A client that stalls mid-body would wedge its own
  // rescue for the whole client_body_timeout.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CHUNK_BYTES) {
    return Response.json({ error: "chunk too large" }, { status: 413 });
  }
  const chunk = Buffer.from(await request.arrayBuffer());

  return withMediaSession(token, () => append(pool, sha256, token, target, chunk, offset));
}

async function append(
  pool: ReturnType<typeof getPool>,
  sha256: string,
  token: string,
  target: { name: string },
  chunk: Buffer,
  offset: number
): Promise<Response> {
  const session = await readMediaSession(token);
  if (!session || session.build !== sha256) {
    return Response.json({ error: "no such upload session" }, { status: 404 });
  }
  // Already finalised: hand back the same row this session produced.
  if (session.done) return Response.json({ done: true, media: session.done });
  const staging = mediaStagingPath(token);
  const st = await fsp.stat(staging).catch(() => null);
  if (!st) return Response.json({ error: "no such upload session" }, { status: 404 });
  let staged = st.size;
  if (staged > session.size) {
    await dropMediaSession(token);
    return Response.json({ error: "corrupt upload session" }, { status: 400 });
  }

  if (staged < session.size) {
    if (!Number.isInteger(offset) || offset < 0) {
      return Response.json({ error: "invalid offset" }, { status: 400 });
    }
    if (offset !== staged) return Response.json({ offset: staged }, { status: 409 });

    if (!chunk.length) return Response.json({ error: "empty chunk" }, { status: 400 });
    if (chunk.length > MAX_CHUNK_BYTES) {
      return Response.json({ error: "chunk too large" }, { status: 413 });
    }
    if (staged + chunk.length > session.size) {
      return Response.json({ error: "chunk exceeds the claimed size" }, { status: 400 });
    }

    if (staged === 0) {
      const sniffed = sniffMedia(chunk);
      if (!sniffed) {
        await dropMediaSession(token);
        return Response.json(
          { error: "unsupported format (png, jpeg, gif, webp, mp4, or webm)" },
          { status: 415 }
        );
      }
      if (sniffed.video !== (session.kind === "video")) {
        await dropMediaSession(token);
        return Response.json(
          {
            error: sniffed.video
              ? "that file is a video, upload it as the video kind"
              : `${session.kind} uploads must be images`,
          },
          { status: 415 }
        );
      }
      session.contentType = sniffed.contentType;
      await updateMediaSession(token, session);
    }

    await fsp.appendFile(staging, chunk);
    staged = (await fsp.stat(staging)).size;
    if (staged < session.size) return Response.json({ done: false, offset: staged });
    if (staged > session.size) {
      await dropMediaSession(token);
      return Response.json({ error: "corrupt upload session" }, { status: 400 });
    }
  }

  // Complete (possibly a retry after a failed finalize): hash, store, record.
  if (!session.contentType) {
    await dropMediaSession(token);
    return Response.json({ error: "corrupt upload session" }, { status: 400 });
  }
  const blobSha = await hashFile(staging);

  let poster = session.poster ?? null;
  if (session.poster === undefined && session.contentType.startsWith("video/")) {
    const posterTmp = `${staging}.poster.jpg`;
    try {
      await extractStill(staging, posterTmp);
      poster = await hashFile(posterTmp);
      await storeBlobFromFile(poster, posterTmp, { ns: MEDIA_NS });
    } catch (error) {
      const busy = conversionBusyResponse(error);
      if (busy) return busy;
      // No usable ffmpeg or no decodable frame: the video plays without one.
      await fsp.rm(posterTmp, { force: true });
      poster = null;
    }
    // Remember the verdict either way, so a retried finalize does not run
    // ffmpeg over a multi-hundred-MB capture again.
    session.poster = poster;
    await updateMediaSession(token, session);
  }

  // keepSource: the staged bytes stay put until the row exists. Storing is
  // content-addressed and idempotent, so a retry after a failed insert redoes
  // it for free, whereas consuming the file here would strand an upload whose
  // blob landed but whose insert did not, with nothing left to retry from.
  // Costs the local backend a copy where it used to rename (the s3 backend
  // this runs on in production streams the file and never consumed it anyway).
  await storeBlobFromFile(blobSha, staging, { ns: MEDIA_NS, keepSource: true });

  const row = await insertMedia(pool, {
    build_sha256: sha256,
    kind: session.kind,
    sha256: blobSha,
    poster_sha256: poster,
    filename: session.filename,
    content_type: session.contentType,
    size: session.size,
    author: session.author,
    label: session.kind === "physical" ? (session.label ?? inferMediaLabel(session.filename)) : null,
  });
  const media = mediaView(row);
  await finishMediaSession(token, session, media);
  // Awaited: the client refreshes the build page the moment it reads this, and
  // that refresh can land on either slot.
  await revalidateBuildPages(sha256, target.name);
  return Response.json({ done: true, media });
}
