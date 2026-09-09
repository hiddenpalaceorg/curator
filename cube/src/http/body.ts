export class BodyLimitError extends Error {}

export async function boundedRequest(request: Request, limit = 8 * 1024 * 1024): Promise<Request> {
  if (Number(request.headers.get("content-length")) > limit) {
    void request.body?.cancel().catch(() => {});
    throw new BodyLimitError("request body too large");
  }
  if (!request.body) return request;
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        void reader.cancel().catch(() => {});
        throw new BodyLimitError("request body too large");
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, body: bytes });
}
