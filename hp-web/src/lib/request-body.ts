import { NextRequest } from "next/server";

/** Bound actual streamed bytes, even without a truthful Content-Length. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | Response> {
  const tooLarge = () => Response.json({ error: "request body too large" }, { status: 413 });
  if (Number(request.headers.get("content-length")) > limit) {
    void request.body?.cancel().catch(() => {});
    return tooLarge();
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        void reader.cancel().catch(() => {});
        return tooLarge();
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Check before a handler can swallow parse errors or perform a mutation. */
export function withBoundedBody<Args extends unknown[]>(
  handler: (request: NextRequest, ...args: Args) => Promise<Response>,
  limit = 1024 * 1024,
) {
  return async (request: NextRequest, ...args: Args): Promise<Response> => {
    if (!request.body) return handler(request, ...args);
    const bytes = await readBody(request, limit);
    if (bytes instanceof Response) return bytes;
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return handler(new NextRequest(request.url, { method: request.method, headers, body: bytes as BodyInit }), ...args);
  };
}
