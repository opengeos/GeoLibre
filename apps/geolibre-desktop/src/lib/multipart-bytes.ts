export interface MultipartPart<T extends ArrayBufferLike = ArrayBuffer> {
  headers: ReadonlyMap<string, string>;
  body: Uint8Array<T>;
}

/** Locate framing without decoding binary payloads or allocating copies. */
function byteIndex(
  bytes: Uint8Array,
  needle: Uint8Array,
  start: number,
  end = bytes.length,
): number {
  const bounded = end === bytes.length ? bytes : bytes.subarray(0, end);
  outer: for (
    let i = bounded.indexOf(needle[0], start);
    i >= 0 && i <= end - needle.length;
    i = bounded.indexOf(needle[0], i + 1)
  ) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parse bounded MIME parts, preserving byte views and ignoring false delimiters. */
export function multipartBytes<T extends ArrayBufferLike>(
  bytes: Uint8Array<T>,
  boundary?: string,
  maxParts = 5000,
): MultipartPart<T>[] {
  const invalid = () => new Error("Invalid multipart response");
  boundary ??= /^--([^\r\n]+)\r?\n/.exec(new TextDecoder().decode(bytes.subarray(0, 80)))?.[1];
  if (!boundary || !/^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/.test(boundary))
    throw invalid();
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const crlf = encoder.encode("\r\n\r\n"),
    lf = encoder.encode("\n\n");
  let framing: 1 | 2 | undefined;
  const findBoundary = (
    start: number,
  ): { at: number; end: number; closing: boolean; newline: 1 | 2 } => {
    let at = byteIndex(bytes, delimiter, start);
    while (at >= 0) {
      if (at === 0 || (bytes[at - 1] === 10 && (framing !== 2 || bytes[at - 2] === 13))) {
        let end = at + delimiter.length;
        const closing = bytes[end] === 45 && bytes[end + 1] === 45;
        if (closing) end += 2;
        while (bytes[end] === 32 || bytes[end] === 9) end++;
        if (closing && end === bytes.length) return { at, end, closing, newline: framing ?? 2 };
        if (bytes[end] === 10) return { at, end: end + 1, closing, newline: 1 };
        if (bytes[end] === 13 && bytes[end + 1] === 10)
          return { at, end: end + 2, closing, newline: 2 };
      }
      at = byteIndex(bytes, delimiter, at + 1);
    }
    throw invalid();
  };
  let boundaryLine = findBoundary(0);
  framing = boundaryLine.newline;
  const parts: MultipartPart<T>[] = [];
  while (!boundaryLine.closing) {
    if (parts.length >= maxParts) throw invalid();
    const start = boundaryLine.end;
    const limit = Math.min(bytes.length, start + 16384);
    const a = byteIndex(bytes, crlf, start, limit),
      b = byteIndex(bytes, lf, start, limit);
    const emptyHeaders =
      bytes[start] === 10 ? 1 : bytes[start] === 13 && bytes[start + 1] === 10 ? 2 : 0;
    const headerEnd = emptyHeaders ? start : a < 0 ? b : b < 0 ? a : Math.min(a, b);
    if (headerEnd < 0) throw invalid();
    const headers = new Map<string, string>();
    const text = new TextDecoder()
      .decode(bytes.subarray(start, headerEnd))
      .replace(/\r?\n[ \t]+/g, " ");
    for (const line of text.split(/\r?\n/)) {
      if (!line && !text) continue;
      const match =
        /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\u0000-\u0008\u000a-\u001f\u007f]*)$/.exec(line);
      if (!match) throw invalid();
      const name = match[1].toLowerCase(),
        value = match[2].trim();
      if (
        headers.has(name) &&
        ["content-id", "content-type", "content-location", "content-transfer-encoding"].includes(
          name,
        )
      )
        throw invalid();
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }
    const bodyStart = headerEnd + (emptyHeaders || (headerEnd === a ? 4 : 2));
    boundaryLine = findBoundary(bodyStart);
    let bodyEnd = boundaryLine.at - framing;
    if (bodyEnd < bodyStart) {
      if (boundaryLine.at !== bodyStart) throw invalid();
      bodyEnd = bodyStart;
    }
    parts.push({ headers, body: bytes.subarray(bodyStart, bodyEnd) });
  }
  if (!parts.length) throw invalid();
  return parts;
}
