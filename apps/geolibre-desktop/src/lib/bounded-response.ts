/** A transport-owned size refusal with the shared native/browser wording. */
export class ResponseLimitError extends Error {
  constructor(maxBytes: number) {
    super(`Response exceeds the ${maxBytes}-byte download limit`);
    this.name = "ResponseLimitError";
  }
}

/** Read within a byte ceiling, rejecting declared size before streaming. */
export async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ResponseLimitError(maxBytes);
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
