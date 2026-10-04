/**
 * Where the remote NetCDF worker loads h5wasm from in a production build.
 *
 * The client sends the main build's h5wasm chunk URL with the `open` request;
 * the worker stores it here before the reader first imports h5wasm. Kept apart
 * from `h5wasm-from-main.ts` so setting it does not evaluate that module, which
 * fetches h5wasm at evaluation time.
 */
let url: string | null = null;

/**
 * Record the main build's h5wasm chunk URL.
 *
 * @param next - The absolute chunk URL, or null when the client has none (dev).
 */
export function setH5wasmUrl(next: string | null | undefined): void {
  if (next) url = next;
}

/**
 * The recorded h5wasm chunk URL.
 *
 * @returns The URL set by {@link setH5wasmUrl}.
 * @throws If no URL was recorded, which means the client predates this build.
 */
export function getH5wasmUrl(): string {
  if (!url) {
    throw new Error("The NetCDF reader worker was not told where to load h5wasm from.");
  }
  return url;
}
