/**
 * Bounded body reader for responses fetched over the network on behalf of
 * plugins.
 *
 * The desktop command caps filesystem reads at `MAX_PLUGIN_ENTRY_BYTES`, so the
 * URL paths need the same ceiling or a large (or hostile) asset would be
 * buffered whole in the webview. This is the one implementation; the text
 * variant in `plugin-registry.ts` decodes what this returns.
 */

/**
 * Read a response body as bytes, enforcing a hard byte ceiling.
 *
 * The `Content-Length` header is a fast-fail; the streaming reader is the real
 * enforcement for responses that omit it (chunked/compressed) or understate it.
 *
 * @param response - response whose body is read.
 * @param maxBytes - the byte ceiling.
 * @param label - what is being fetched, for the error message.
 * @returns the body bytes.
 * @throws when the body exceeds `maxBytes`, or when the stream fails.
 */
export async function readBodyBytesWithCap(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const tooLarge = () =>
    new Error(
      `Could not fetch ${label}: response exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB size limit.`,
    );
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // No stream available: some environments and test doubles expose only the
    // convenience readers. Prefer bytes, then fall back to text so the ceiling
    // is still enforced either way.
    if (typeof response.arrayBuffer === "function") {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        throw tooLarge();
      }
      return new Uint8Array(buffer);
    }
    const bytes = new TextEncoder().encode(await response.text());
    if (bytes.byteLength > maxBytes) {
      throw tooLarge();
    }
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    // Release the stream lock on a mid-stream read failure (or the size abort
    // above) so the connection can be reused or collected.
    await reader.cancel().catch(() => {});
    throw error;
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
