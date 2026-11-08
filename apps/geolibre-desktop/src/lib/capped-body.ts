/**
 * Bounded body reader for plugin assets fetched over the network.
 *
 * The desktop command caps filesystem reads at `MAX_PLUGIN_ENTRY_BYTES`, so the
 * URL paths need the same cap: a large (or hostile) asset must be refused
 * instead of buffered whole in the webview. The limit is a parameter rather than
 * an import so this module stays dependency-free and unit-testable.
 */

/**
 * Read a response body, refusing anything past `limit` bytes.
 *
 * The declared length is checked first so an oversized asset is rejected before
 * it is downloaded; the stream is capped again because `content-length` is
 * absent on chunked responses and a server may understate it.
 *
 * @param response - response whose body is read.
 * @param limit - maximum accepted body size in bytes.
 * @returns the body bytes, or `null` when the body exceeds `limit`.
 */
export async function readCappedBody(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return null;
  }
  if (response.body === null) {
    const buffer = await response.arrayBuffer();
    return buffer.byteLength > limit ? null : new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
