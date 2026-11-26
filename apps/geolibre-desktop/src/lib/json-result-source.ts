export interface JsonSourceSpan {
  start: number;
  end: number;
}
const decoder = new TextDecoder();
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const numericByte = (byte: number) =>
  (byte >= 48 && byte <= 57) ||
  byte === 43 ||
  byte === 45 ||
  byte === 46 ||
  byte === 69 ||
  byte === 101;

function skipSpace(bytes: Uint8Array, position: number, end: number): number {
  while (position < end && whitespace(bytes[position])) position++;
  return position;
}

function stringEnd(bytes: Uint8Array, start: number, end: number): number {
  for (let position = start + 1; position < end; position++) {
    if (bytes[position] === 92) position++;
    else if (bytes[position] === 34) return position + 1;
  }
  throw new Error("Invalid JSON source string");
}

/** Scan a value already validated by JSON.parse without recursion or numeric conversion. */
function valueEnd(bytes: Uint8Array, start: number, end: number): number {
  if (bytes[start] === 34) return stringEnd(bytes, start, end);
  let depth = 0;
  for (let position = start; position < end; position++) {
    const byte = bytes[position];
    if (byte === 34) position = stringEnd(bytes, position, end) - 1;
    else if (byte === 123 || byte === 91) depth++;
    else if (byte === 125 || byte === 93) {
      if (!depth) return position;
      if (--depth === 0) return position + 1;
    } else if (!depth && (byte === 44 || whitespace(byte))) return position;
  }
  return end;
}

/** Locate object member value bytes; duplicate keys retain JSON.parse's last value. */
export function jsonMemberSpans(
  bytes: Uint8Array,
  span: JsonSourceSpan = { start: 0, end: bytes.length },
): Map<string, JsonSourceSpan> {
  const start =
    span.start === 0 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? 3
      : span.start;
  let position = skipSpace(bytes, start, span.end);
  const members = new Map<string, JsonSourceSpan>();
  if (bytes[position++] !== 123) return members;
  while ((position = skipSpace(bytes, position, span.end)) < span.end && bytes[position] !== 125) {
    const keyEnd = stringEnd(bytes, position, span.end);
    const key: string = JSON.parse(decoder.decode(bytes.subarray(position, keyEnd)));
    position = skipSpace(bytes, keyEnd, span.end) + 1;
    const start = skipSpace(bytes, position, span.end),
      end = valueEnd(bytes, start, span.end);
    members.set(key, { start, end });
    position = skipSpace(bytes, end, span.end);
    if (bytes[position] === 44) position++;
    else break;
  }
  return members;
}

/** Locate legacy output-array records without materializing a second JSON tree. */
export function jsonArraySpans(bytes: Uint8Array, span: JsonSourceSpan): JsonSourceSpan[] {
  let position = skipSpace(bytes, span.start, span.end);
  const values: JsonSourceSpan[] = [];
  if (bytes[position++] !== 91) return values;
  while ((position = skipSpace(bytes, position, span.end)) < span.end && bytes[position] !== 93) {
    const end = valueEnd(bytes, position, span.end);
    values.push({ start: position, end });
    position = skipSpace(bytes, end, span.end);
    if (bytes[position] === 44) position++;
    else break;
  }
  return values;
}

/** Detect numeric tokens whose original representation would change on serialization. */
export function jsonNumbersNeedSource(bytes: Uint8Array, span: JsonSourceSpan): boolean {
  for (let position = span.start; position < span.end; position++) {
    const byte = bytes[position];
    if (byte === 34) position = stringEnd(bytes, position, span.end) - 1;
    else if (byte === 45 || (byte >= 48 && byte <= 57)) {
      const start = position;
      position++;
      while (position < span.end && numericByte(bytes[position])) position++;
      const token = decoder.decode(bytes.subarray(start, position));
      if (JSON.stringify(Number(token)) !== token) return true;
      position--;
    }
  }
  return false;
}
