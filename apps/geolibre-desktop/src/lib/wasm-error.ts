/**
 * Message extraction for values thrown by the WebAssembly conversion engines.
 *
 * `geolibre-wasm` is a wasm-bindgen module, and a Rust `Err(JsValue)` crosses
 * the boundary as a bare **string**, not an `Error`. Code that only reads
 * `err instanceof Error ? err.message : fallback` therefore throws away the one
 * useful thing the engine said. That is how GeoLibre#1743's Raster to COG
 * failure surfaced as "Could not convert this file." when the engine had in
 * fact reported "raster too large to fully decode in 32-bit WASM:
 * 110162x51992 x 1 band(s) = 5727542704 cells".
 */

/**
 * The human-readable message carried by a thrown value, whatever its shape.
 *
 * Handles the three forms these code paths actually see: an `Error` (thrown by
 * our own code and by `fetch`), a bare string (wasm-bindgen's `JsValue`
 * rejection), and an object carrying a string `message` (some DOM exceptions
 * and structured-cloned errors from workers).
 *
 * @param thrown - The caught value.
 * @param fallback - Message to use when `thrown` carries nothing readable.
 * @returns The extracted message, or `fallback`.
 */
export function messageFromThrown(thrown: unknown, fallback: string): string {
  if (thrown instanceof Error) return thrown.message || fallback;
  if (typeof thrown === "string") return thrown.trim() || fallback;
  if (typeof thrown === "object" && thrown !== null) {
    const { message } = thrown as { message?: unknown };
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

/**
 * Whether a conversion failure is the engine refusing a raster for its size.
 *
 * `geolibre-wasm` (re-verified against the bundled build) reports this as
 * "raster too large to fully decode in 32-bit WASM: WxH x N band(s) = C cells",
 * and that phrase is the only signal it exposes, so the match is coupled to the
 * wording. Re-verify it when bumping `geolibre-wasm`; a reworded message
 * degrades to showing the engine's text alone, not to a crash.
 *
 * The engine's own message names internal APIs (`geotiff_info`, `CogStream`)
 * that mean nothing to someone converting a file, so recognizing this case lets
 * the UI add what to actually do instead.
 *
 * Matched on the whole documented phrase rather than a fragment of it,
 * deliberately: the two ways this can be wrong are not symmetric. Missing a
 * reworded refusal only drops a hint the engine's own text partly covers, while
 * matching some other failure would tell someone to go and install GDAL over a
 * problem that has nothing to do with size.
 *
 * @param message - The message extracted by {@link messageFromThrown}.
 * @returns True when the raster exceeds what the browser engine can decode.
 */
export function isRasterTooLargeForWasm(message: string): boolean {
  return /raster too large to fully decode in 32-bit wasm/i.test(message);
}
