// Helpers for projects too large to serialize into a single string.
//
// A project embedding a large local vector layer (an Add Vector Layer file big
// enough to load as tiles) can serialize past the engine's maximum string
// length, ~536 MB in V8. The throw that raises is not a typed signal, so this
// module names it once for every caller (Save, Save As, Share) and measures
// embedded data without building that one string (GeoLibre#3025).

import type { FeatureCollection } from "geojson";

/**
 * Messages engines raise when a string passes their maximum length, which is
 * how "this project is too large to serialize" surfaces.
 *
 * Matched by text rather than by error class because there is no typed signal:
 * V8 (Chromium, WebView2) throws `RangeError: Invalid string length`,
 * JavaScriptCore (the macOS and Linux Tauri webviews) reports an out-of-memory
 * error, and SpiderMonkey says "allocation size overflow". Matching only V8's
 * wording would leave desktop users on every other webview with the generic
 * failure message instead of the guidance this exists to give.
 *
 * Deliberately narrow: a genuine serialization bug (a cycle, say, which reads
 * "Converting circular structure to JSON") must not be filed under size.
 */
const SERIALIZATION_TOO_LARGE_PATTERN =
  /invalid string length|out of memory|allocation size overflow|string too long/i;

/**
 * Whether an error means a value was too large to serialize into one string.
 *
 * Only the string-length cap counts. A `RangeError` alone is too broad: a stack
 * overflow raises one too, and pointing that at PMTiles/FlatGeobuf would send
 * the user chasing a size problem they do not have.
 *
 * @param error The caught value.
 * @returns True when the error is an engine's string-length or allocation cap.
 */
export function isSerializationTooLargeError(error: unknown): boolean {
  return error instanceof Error && SERIALIZATION_TOO_LARGE_PATTERN.test(error.message);
}

/**
 * UTF-8 byte length of a string, counted without allocating an encoded copy.
 *
 * @param text The string to measure.
 * @returns Its size in UTF-8 bytes. A lone surrogate counts as the three-byte
 *   U+FFFD it encodes to, matching {@link TextEncoder}.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A valid surrogate pair is one four-byte code point.
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/**
 * UTF-8 byte size of `JSON.stringify(collection)`, measured one feature at a
 * time so no single string holds the whole collection.
 *
 * Stringifying a large collection in one call throws once the text passes the
 * engine's string cap, which is exactly the case the save prompt's size warning
 * exists for. Each feature is stringified alone and the envelope (every key but
 * `features`) once, so the result equals the encoded length of the full string
 * for any collection that would have fit.
 *
 * @param collection The features to measure.
 * @returns The size in bytes the collection occupies when serialized compactly.
 */
export function featureCollectionByteLength(collection: FeatureCollection): number {
  const { features } = collection;
  // The envelope already contains the `[]` the features are spliced into.
  let bytes = utf8ByteLength(JSON.stringify({ ...collection, features: [] }));
  for (let index = 0; index < features.length; index++) {
    // An entry JSON.stringify cannot represent is written as null, as it would
    // be inside the array.
    bytes += utf8ByteLength(JSON.stringify(features[index]) ?? "null");
  }
  // One comma between each pair of features.
  if (features.length > 1) bytes += features.length - 1;
  return bytes;
}
