/** Bounds retained request bytes even when Content-Length is missing or inaccurate. */
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds the allowed size.");
    this.name = "RequestBodyTooLargeError";
  }
}

export async function readLimitedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("A positive byte limit is required.");
  }
  const declared = Number(req.headers.get("content-length") || "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
    // Cancellation is best-effort: a stalled producer must not delay rejection.
    if (req.body) void req.body.cancel().catch(() => {});
    throw new RequestBodyTooLargeError();
  }
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  // A fixed buffer also bounds overhead for streams made of tiny/empty chunks.
  const buffer = new Uint8Array(maxBytes);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError();
      }
      buffer.set(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return buffer.slice(0, total);
}
