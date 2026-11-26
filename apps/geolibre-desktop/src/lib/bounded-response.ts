/**
 * Reads a response body, refusing one that runs past `maxBytes`. Mirrors the
 * native `read_limited_body` helper, message included, so a capped fetch fails
 * the same way in both builds: the advertised length is rejected before a byte
 * is read, and the stream is counted as it arrives rather than buffered whole
 * and measured afterwards.
 */
export async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new Error(`Response exceeds the ${maxBytes}-byte download limit`);
  if (Number(response.headers.get("content-length")) > maxBytes) throw tooLarge();
  const reader = response.body?.getReader();
  // A bodyless response (an empty 204, a stubbed fetch) has nothing to stream;
  // `arrayBuffer` resolves it without reading past the ceiling.
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
