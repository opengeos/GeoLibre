/** Small helpers shared by the file I/O modules. */

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// DuckDB-wasm (pthreads build) can hand back a Uint8Array backed by a
// SharedArrayBuffer, which `Blob`'s BlobPart type rejects. Copy into a plain
// ArrayBuffer so the binary save path type-checks and stays portable.
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}
