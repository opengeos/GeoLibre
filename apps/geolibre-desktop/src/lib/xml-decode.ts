// Charset-aware decoding for XML responses read as raw bytes (the native Tauri
// fetch hands back bytes, not a Response). Shared by the OGC capabilities
// fetch and the WFS GetFeature path; dependency-free so both stay importable
// under the node test runner.

/**
 * Decodes XML response bytes (capabilities, GML) to text, honoring a
 * non-UTF-8 charset. The HTTP `Content-Type` charset (when present) wins; otherwise the charset declared in
 * the XML prolog (`<?xml … encoding="ISO-8859-1"?>`) is used, defaulting to
 * UTF-8. `Response.text()` only honors the HTTP header, so both the browser and
 * the Tauri byte paths run through this to avoid mojibake from a legacy Latin-1
 * service that declares its charset only in the prolog.
 */
export function decodeXmlBytes(bytes: Uint8Array, httpCharset?: string): string {
  // The prolog is ASCII, so decode a short head to read the declared charset.
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, 256));
  const prologCharset = head.match(/encoding=["']([\w-]+)["']/i)?.[1];
  const label = httpCharset || prologCharset || "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Extracts the `charset` from a `Content-Type` header value, if any. */
export function charsetFromContentType(contentType: string | null): string | undefined {
  return contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
}
