/**
 * A minimal PDF object reader: enough of the file structure to walk the page
 * tree and read a page's dictionaries, which is all GeoPDF import needs from
 * the document itself (pdf.js renders the pixels). GH #3523.
 *
 * Covers classic cross-reference tables, cross-reference streams (PDF 1.5) with
 * PNG predictors, compressed object streams, incremental updates (`/Prev`),
 * and indirect `/Length`s. A damaged cross-reference falls back to scanning the
 * file for `N G obj` headers. Encrypted documents are refused: their strings
 * and streams would need decrypting first.
 */
import { Inflate, Unzlib } from "fflate";

/** A PDF name, e.g. `/Type`. */
export class PdfName {
  constructor(readonly name: string) {}
}

/** An indirect reference, e.g. `12 0 R`. */
export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}

/** A stream: its dictionary and its raw (still encoded) bytes. */
export class PdfStream {
  constructor(
    readonly dict: PdfDict,
    readonly raw: Uint8Array,
  ) {}
}

export type PdfDict = Map<string, PdfValue>;
export type PdfValue =
  | number
  | boolean
  | null
  | string
  | PdfName
  | PdfRef
  | PdfStream
  | PdfValue[]
  | PdfDict;

/** Raised for a document this reader cannot interpret. */
export class PdfReadError extends Error {}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const MAX_STREAM_BYTES = 256 * 1024 * 1024;

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

/** Bytes to a Latin-1 string, for keywords and raw text. */
function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  for (let i = start; i < end; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 0x8000)));
  }
  return out;
}

/** Decode a PDF text string: UTF-16BE with a BOM, UTF-8 with a BOM, else Latin-1. */
function decodeTextString(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder().decode(new Uint8Array(bytes.slice(3)));
  }
  return String.fromCharCode(...bytes);
}

/** Tokenizes and parses PDF objects from a byte buffer. */
class Parser {
  pos: number;

  constructor(
    private readonly bytes: Uint8Array,
    start: number,
    /** Resolves an indirect stream `/Length`; absent inside object streams. */
    private readonly resolveLength?: (ref: PdfRef) => PdfValue,
  ) {
    this.pos = start;
  }

  private skipSpace(): void {
    const { bytes } = this;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos];
      if (WHITESPACE.has(b)) {
        this.pos++;
      } else if (b === 0x25) {
        // A comment runs to the end of the line.
        while (this.pos < bytes.length && bytes[this.pos] !== 0x0a && bytes[this.pos] !== 0x0d) {
          this.pos++;
        }
      } else {
        return;
      }
    }
  }

  /** The next bare keyword or number token, without consuming it. */
  private peekWord(): string {
    this.skipSpace();
    let end = this.pos;
    while (end < this.bytes.length && isRegular(this.bytes[end])) end++;
    return latin1(this.bytes, this.pos, end);
  }

  readWord(): string {
    const word = this.peekWord();
    this.pos += word.length;
    return word;
  }

  /**
   * Parse one object.
   *
   * Returns:
   *   The object; a trailing `N G R` becomes a {@link PdfRef}, and a dictionary
   *   followed by `stream` becomes a {@link PdfStream}.
   */
  parseObject(): PdfValue {
    this.skipSpace();
    const { bytes } = this;
    if (this.pos >= bytes.length) throw new PdfReadError("Unexpected end of PDF data");
    const b = bytes[this.pos];
    if (b === 0x2f) return this.parseName();
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray();
    if (b === 0x3c) {
      if (bytes[this.pos + 1] === 0x3c) {
        const dict = this.parseDict();
        return this.maybeStream(dict);
      }
      return this.parseHexString();
    }
    const word = this.readWord();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    const num = Number(word);
    if (word === "" || !Number.isFinite(num)) {
      throw new PdfReadError(`Unexpected PDF token "${word || String.fromCharCode(b)}"`);
    }
    // `N G R` is an indirect reference: look ahead without committing.
    if (Number.isInteger(num) && num >= 0) {
      const save = this.pos;
      const gen = this.readWord();
      if (/^\d+$/.test(gen) && this.readWord() === "R") return new PdfRef(num, Number(gen));
      this.pos = save;
    }
    return num;
  }

  private parseName(): PdfName {
    this.pos++; // the slash
    let end = this.pos;
    while (end < this.bytes.length && isRegular(this.bytes[end])) end++;
    const raw = latin1(this.bytes, this.pos, end);
    this.pos = end;
    return new PdfName(
      raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    );
  }

  private parseLiteralString(): string {
    const { bytes } = this;
    this.pos++; // the opening parenthesis
    const out: number[] = [];
    let depth = 1;
    while (this.pos < bytes.length) {
      const b = bytes[this.pos++];
      if (b === 0x5c) {
        const next = bytes[this.pos++];
        const simple: Record<number, number> = {
          0x6e: 0x0a,
          0x72: 0x0d,
          0x74: 0x09,
          0x62: 0x08,
          0x66: 0x0c,
        };
        if (next in simple) out.push(simple[next]);
        else if (next === 0x0d) {
          if (bytes[this.pos] === 0x0a) this.pos++; // a line continuation
        } else if (next === 0x0a) {
          // A line continuation.
        } else if (next >= 0x30 && next <= 0x37) {
          let octal = next - 0x30;
          for (let i = 0; i < 2 && bytes[this.pos] >= 0x30 && bytes[this.pos] <= 0x37; i++) {
            octal = octal * 8 + (bytes[this.pos++] - 0x30);
          }
          out.push(octal & 0xff);
        } else out.push(next);
      } else if (b === 0x28) {
        depth++;
        out.push(b);
      } else if (b === 0x29) {
        if (--depth === 0) break;
        out.push(b);
      } else out.push(b);
    }
    return decodeTextString(out);
  }

  private parseHexString(): string {
    const { bytes } = this;
    this.pos++; // the opening angle bracket
    let hex = "";
    while (this.pos < bytes.length && bytes[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(bytes[this.pos++]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.pos++;
    if (hex.length % 2) hex += "0";
    const out: number[] = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return decodeTextString(out);
  }

  private parseArray(): PdfValue[] {
    this.pos++;
    const items: PdfValue[] = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) throw new PdfReadError("Unterminated PDF array");
      if (this.bytes[this.pos] === 0x5d) {
        this.pos++;
        return items;
      }
      items.push(this.parseObject());
    }
  }

  private parseDict(): PdfDict {
    this.pos += 2;
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) throw new PdfReadError("Unterminated PDF dictionary");
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return dict;
      }
      const key = this.parseObject();
      if (!(key instanceof PdfName)) throw new PdfReadError("PDF dictionary key is not a name");
      dict.set(key.name, this.parseObject());
    }
  }

  private maybeStream(dict: PdfDict): PdfDict | PdfStream {
    const save = this.pos;
    if (this.peekWord() !== "stream") {
      this.pos = save;
      return dict;
    }
    this.pos += "stream".length;
    // The keyword ends with CRLF or LF.
    if (this.bytes[this.pos] === 0x0d) this.pos++;
    if (this.bytes[this.pos] === 0x0a) this.pos++;
    const start = this.pos;
    let length = dict.get("Length");
    if (length instanceof PdfRef) length = this.resolveLength?.(length) ?? null;
    let end: number;
    if (
      typeof length === "number" &&
      length >= 0 &&
      start + length <= this.bytes.length &&
      latin1(this.bytes, start + length, Math.min(this.bytes.length, start + length + 12)).includes(
        "endstream",
      )
    ) {
      end = start + length;
    } else {
      // A missing or wrong /Length: search for the keyword instead.
      const idx = indexOf(this.bytes, "endstream", start);
      if (idx < 0) throw new PdfReadError("Unterminated PDF stream");
      end = idx;
      while (end > start && (this.bytes[end - 1] === 0x0a || this.bytes[end - 1] === 0x0d)) end--;
    }
    this.pos = end;
    const after = indexOf(this.bytes, "endstream", end);
    if (after >= 0) this.pos = after + "endstream".length;
    return new PdfStream(dict, this.bytes.subarray(start, end));
  }
}

/** Position of an ASCII needle in bytes at or after `from`, or -1. */
function indexOf(bytes: Uint8Array, needle: string, from = 0): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = from; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Position of the last occurrence of an ASCII needle, or -1. */
function lastIndexOf(bytes: Uint8Array, needle: string): number {
  for (let i = bytes.length - needle.length; i >= 0; i--) {
    let ok = true;
    for (let j = 0; j < needle.length && ok; j++) ok = bytes[i + j] === needle.charCodeAt(j);
    if (ok) return i;
  }
  return -1;
}

/** Undo a PNG predictor (`/Predictor` 10-15) over rows of `columns` bytes. */
function unpredictPng(data: Uint8Array, columns: number, bytesPerPixel: number): Uint8Array {
  const rowLength = columns + 1;
  const rows = Math.floor(data.length / rowLength);
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const filter = data[r * rowLength];
    for (let c = 0; c < columns; c++) {
      const raw = data[r * rowLength + 1 + c];
      const left = c >= bytesPerPixel ? out[r * columns + c - bytesPerPixel] : 0;
      const up = r > 0 ? out[(r - 1) * columns + c] : 0;
      const upLeft = r > 0 && c >= bytesPerPixel ? out[(r - 1) * columns + c - bytesPerPixel] : 0;
      let value: number;
      switch (filter) {
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          value = raw;
      }
      out[r * columns + c] = value & 0xff;
    }
  }
  return out;
}

type XrefEntry =
  | { type: 0 }
  | { type: 1; offset: number }
  | { type: 2; stream: number; index: number };

/** True for a token that is a non-negative integer (not an empty read). */
function isUint(word: string): boolean {
  return /^\d+$/.test(word);
}

/**
 * Inflate a zlib (or raw deflate) stream, refusing to produce more than
 * `limit` bytes. The streaming decoder stops as soon as the output passes the
 * limit, so a small "decompression bomb" cannot allocate gigabytes first.
 */
export function boundedInflate(data: Uint8Array, limit: number, raw: boolean): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const onData = (chunk: Uint8Array) => {
    if (overflow) return;
    total += chunk.length;
    if (total > limit) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
  };
  const inflater = raw ? new Inflate(onData) : new Unzlib(onData);
  // Feed in slices so the size check runs while decoding, not after.
  const SLICE = 64 * 1024;
  for (let at = 0; at < data.length && !overflow; at += SLICE) {
    const end = Math.min(data.length, at + SLICE);
    inflater.push(data.subarray(at, end), end === data.length);
  }
  if (overflow) throw new PdfStreamTooLargeError("PDF stream too large");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A stream that inflates past the size budget; final, never retried. */
class PdfStreamTooLargeError extends Error {}

/** A parsed PDF document: its trailer, and object lookup by reference. */
export class PdfDocument {
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfValue>();
  private readonly objectStreams = new Map<
    number,
    { data: Uint8Array; offsets: Map<number, number> }
  >();
  readonly trailer: PdfDict;

  constructor(private readonly bytes: Uint8Array) {
    if (indexOf(bytes.subarray(0, 1024), "%PDF-") < 0) throw new PdfReadError("Not a PDF file");
    let trailer: PdfDict | null = null;
    try {
      trailer = this.readXrefChain();
    } catch {
      trailer = null;
    }
    // Refuse encryption before any recovery can replace the trailer that says so.
    if (trailer?.has("Encrypt")) throw new PdfReadError("Encrypted PDFs are not supported");
    // A trailer can parse while its offsets are stale: recover unless the
    // catalog and its page tree actually resolve.
    if (!trailer || !this.catalogResolves(trailer)) trailer = this.scanObjects();
    this.trailer = trailer;
    if (this.trailer.has("Encrypt")) throw new PdfReadError("Encrypted PDFs are not supported");
  }

  /** Whether a trailer's `/Root` resolves to a catalog with a page tree. */
  private catalogResolves(trailer: PdfDict): boolean {
    try {
      const root = this.dict(trailer.get("Root"));
      return root !== null && this.dict(root.get("Pages")) !== null;
    } catch {
      return false;
    }
  }

  /** Follow `startxref` and every `/Prev`, newest entries winning. */
  private readXrefChain(): PdfDict {
    const marker = lastIndexOf(this.bytes, "startxref");
    if (marker < 0) throw new PdfReadError("No startxref");
    const parser = new Parser(this.bytes, marker + "startxref".length);
    let offset: number | null = Number(parser.readWord());
    let trailer: PdfDict | null = null;
    const seen = new Set<number>();
    while (offset !== null && Number.isFinite(offset) && !seen.has(offset)) {
      seen.add(offset);
      const section = this.readXrefSection(offset);
      if (!trailer) trailer = section;
      const stm = section.get("XRefStm");
      if (typeof stm === "number" && !seen.has(stm)) {
        seen.add(stm);
        this.readXrefSection(stm);
      }
      const prev = section.get("Prev");
      offset = typeof prev === "number" ? prev : null;
    }
    if (!trailer) throw new PdfReadError("No trailer");
    return trailer;
  }

  /** Read one cross-reference section; entries already known are kept. */
  private readXrefSection(offset: number): PdfDict {
    const parser = new Parser(this.bytes, offset, (ref) => this.get(ref));
    const save = parser.pos;
    if (parser.readWord() === "xref") {
      for (;;) {
        const word = parser.readWord();
        if (word === "trailer") break;
        // readWord() returns "" without advancing at a delimiter or the end of
        // the file; accepting it as 0 would loop forever on a damaged table.
        const countWord = parser.readWord();
        if (!isUint(word) || !isUint(countWord)) throw new PdfReadError("Bad xref");
        const first = Number(word);
        const count = Number(countWord);
        for (let i = 0; i < count; i++) {
          const offsetWord = parser.readWord();
          const genWord = parser.readWord();
          const kind = parser.readWord();
          if (!isUint(offsetWord) || !isUint(genWord) || (kind !== "n" && kind !== "f")) {
            throw new PdfReadError("Bad xref entry");
          }
          // A newer revision's entry wins, a free ("f") one included, so a
          // deleted object does not come back from an older revision.
          if (this.xref.has(first + i)) continue;
          this.xref.set(
            first + i,
            kind === "n" ? { type: 1, offset: Number(offsetWord) } : { type: 0 },
          );
        }
      }
      const trailer = parser.parseObject();
      if (!(trailer instanceof Map)) throw new PdfReadError("Bad trailer");
      return trailer;
    }
    // A cross-reference stream: `N G obj << /Type /XRef ... >> stream`.
    parser.pos = save;
    parser.readWord();
    parser.readWord();
    if (parser.readWord() !== "obj") throw new PdfReadError("Bad xref stream");
    const stream = parser.parseObject();
    if (!(stream instanceof PdfStream)) throw new PdfReadError("Bad xref stream");
    const { dict } = stream;
    const widths = (dict.get("W") as number[] | undefined) ?? [];
    const size = dict.get("Size") as number;
    const index = (dict.get("Index") as number[] | undefined) ?? [0, size];
    const data = this.decodeStream(stream);
    const rowLength = widths.reduce((sum, w) => sum + w, 0);
    if (!(rowLength > 0)) throw new PdfReadError("Bad xref widths");
    const field = (row: number, which: number, fallback: number) => {
      const width = widths[which];
      if (!width) return fallback;
      let start = row * rowLength;
      for (let k = 0; k < which; k++) start += widths[k];
      let value = 0;
      for (let k = 0; k < width; k++) value = value * 256 + data[start + k];
      return value;
    };
    let row = 0;
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let i = 0; i < index[s + 1]; i++, row++) {
        if ((row + 1) * rowLength > data.length) break;
        const num = index[s] + i;
        if (this.xref.has(num)) continue;
        const type = field(row, 0, 1);
        if (type === 0) this.xref.set(num, { type: 0 });
        else if (type === 1) this.xref.set(num, { type: 1, offset: field(row, 1, 0) });
        else if (type === 2)
          this.xref.set(num, { type: 2, stream: field(row, 1, 0), index: field(row, 2, 0) });
      }
    }
    return dict;
  }

  /** Recover from a broken cross-reference by scanning for object headers. */
  private scanObjects(): PdfDict {
    const text = latin1(this.bytes);
    const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;
    let trailer: PdfDict | null = null;
    this.xref.clear();
    this.cache.clear();
    while ((match = re.exec(text))) {
      const offset = match.index + match[0].indexOf(match[1]);
      this.xref.set(Number(match[1]), { type: 1, offset });
    }
    // The last trailer dictionary, or any catalog found by type.
    const trailerAt = text.lastIndexOf("trailer");
    if (trailerAt >= 0) {
      try {
        const value = new Parser(this.bytes, trailerAt + "trailer".length).parseObject();
        if (value instanceof Map) trailer = value;
      } catch {
        trailer = null;
      }
    }
    if (!trailer?.has("Root")) {
      for (const num of this.xref.keys()) {
        const value = this.tryGet(new PdfRef(num, 0));
        const dict = value instanceof PdfStream ? value.dict : value;
        if (dict instanceof Map && nameOf(dict.get("Type")) === "Catalog") {
          // Keep an Encrypt marker from a trailer that lost only its /Root.
          const recovered: PdfDict = new Map([["Root", new PdfRef(num, 0)]]);
          if (trailer?.has("Encrypt")) recovered.set("Encrypt", trailer.get("Encrypt")!);
          trailer = recovered;
          break;
        }
        // An xref stream also carries the trailer keys.
        if (
          value instanceof PdfStream &&
          nameOf(value.dict.get("Type")) === "XRef" &&
          value.dict.has("Root")
        ) {
          trailer = value.dict;
        }
      }
    }
    if (!trailer?.has("Root")) throw new PdfReadError("No document catalog");
    return trailer;
  }

  private tryGet(ref: PdfRef): PdfValue {
    try {
      return this.get(ref);
    } catch {
      return null;
    }
  }

  /** Decode a stream's data through its filters (FlateDecode only). */
  decodeStream(stream: PdfStream): Uint8Array {
    const filter = this.resolve(stream.dict.get("Filter"));
    const filters = Array.isArray(filter)
      ? filter.map((f) => nameOf(this.resolve(f)))
      : filter
        ? [nameOf(filter)]
        : [];
    const parms = this.resolve(stream.dict.get("DecodeParms") ?? stream.dict.get("DP"));
    let data = stream.raw;
    filters.forEach((name, i) => {
      if (name !== "FlateDecode" && name !== "Fl") {
        throw new PdfReadError(`Unsupported PDF stream filter ${name}`);
      }
      const encoded = data;
      try {
        data = boundedInflate(encoded, MAX_STREAM_BYTES, false);
      } catch (error) {
        if (error instanceof PdfStreamTooLargeError) throw new PdfReadError(error.message);
        // Some writers emit raw deflate without the zlib header.
        try {
          data = boundedInflate(encoded, MAX_STREAM_BYTES, true);
        } catch (rawError) {
          throw new PdfReadError(
            rawError instanceof PdfStreamTooLargeError ? rawError.message : "Corrupt PDF stream",
          );
        }
      }
      const parm = this.resolve(Array.isArray(parms) ? parms[i] : parms);
      if (parm instanceof Map) {
        const predictor = (parm.get("Predictor") as number | undefined) ?? 1;
        if (predictor >= 10) {
          const colors = (parm.get("Colors") as number | undefined) ?? 1;
          const bits = (parm.get("BitsPerComponent") as number | undefined) ?? 8;
          const columns = (parm.get("Columns") as number | undefined) ?? 1;
          const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
          data = unpredictPng(data, Math.ceil((columns * colors * bits) / 8), bytesPerPixel);
        } else if (predictor !== 1) {
          throw new PdfReadError(`Unsupported PDF predictor ${predictor}`);
        }
      }
    });
    return data;
  }

  /** The object a reference points to (null when it does not exist). */
  get(ref: PdfRef): PdfValue {
    if (this.cache.has(ref.num)) return this.cache.get(ref.num)!;
    const entry = this.xref.get(ref.num);
    if (!entry || entry.type === 0) return null;
    // Guard against a self-referencing /Length while this object parses.
    this.cache.set(ref.num, null);
    let value: PdfValue;
    if (entry.type === 1) {
      const parser = new Parser(this.bytes, entry.offset, (r) => this.get(r));
      parser.readWord(); // object number
      parser.readWord(); // generation
      if (parser.readWord() !== "obj") throw new PdfReadError(`Object ${ref.num} not found`);
      value = parser.parseObject();
    } else {
      const objectStream = this.objectStream(entry.stream);
      const offset = objectStream.offsets.get(ref.num);
      value = offset === undefined ? null : new Parser(objectStream.data, offset).parseObject();
    }
    this.cache.set(ref.num, value);
    return value;
  }

  private objectStream(num: number): { data: Uint8Array; offsets: Map<number, number> } {
    const cached = this.objectStreams.get(num);
    if (cached) return cached;
    const stream = this.get(new PdfRef(num, 0));
    if (!(stream instanceof PdfStream)) throw new PdfReadError(`Object stream ${num} not found`);
    const data = this.decodeStream(stream);
    const count = stream.dict.get("N") as number;
    const first = stream.dict.get("First") as number;
    const header = new Parser(data, 0);
    const offsets = new Map<number, number>();
    if (!Number.isInteger(count) || !Number.isInteger(first) || count < 0) {
      throw new PdfReadError(`Bad object stream ${num}`);
    }
    for (let i = 0; i < count; i++) {
      const numWord = header.readWord();
      const offsetWord = header.readWord();
      if (!isUint(numWord) || !isUint(offsetWord))
        throw new PdfReadError(`Bad object stream ${num}`);
      offsets.set(Number(numWord), first + Number(offsetWord));
    }
    const result = { data, offsets };
    this.objectStreams.set(num, result);
    return result;
  }

  /** Dereference a value until it is not a reference. */
  resolve(value: PdfValue | undefined): PdfValue {
    let current: PdfValue = value ?? null;
    for (let depth = 0; current instanceof PdfRef && depth < 32; depth++)
      current = this.get(current);
    return current instanceof PdfRef ? null : current;
  }

  /** A dictionary value, dereferenced (a stream's dictionary counts). */
  dict(value: PdfValue | undefined): PdfDict | null {
    const resolved = this.resolve(value);
    if (resolved instanceof Map) return resolved;
    if (resolved instanceof PdfStream) return resolved.dict;
    return null;
  }

  /** The page dictionaries in document order, with inherited attributes applied. */
  pages(): PdfDict[] {
    const root = this.dict(this.trailer.get("Root"));
    const out: PdfDict[] = [];
    const visited = new Set<PdfDict>();
    const INHERITED = ["MediaBox", "CropBox", "Rotate", "Resources"];
    const walk = (node: PdfDict | null, inherited: Map<string, PdfValue>) => {
      if (!node || visited.has(node) || out.length > 100000) return;
      visited.add(node);
      const here = new Map(inherited);
      for (const key of INHERITED) if (node.has(key)) here.set(key, node.get(key)!);
      const kids = this.resolve(node.get("Kids"));
      if (nameOf(node.get("Type")) === "Pages" || Array.isArray(kids)) {
        if (Array.isArray(kids)) for (const kid of kids) walk(this.dict(kid), here);
        return;
      }
      const page: PdfDict = new Map(node);
      for (const [key, value] of here) if (!page.has(key)) page.set(key, value);
      out.push(page);
    };
    walk(this.dict(root?.get("Pages")), new Map());
    return out;
  }
}

/** The name a value holds, or null. */
export function nameOf(value: PdfValue | undefined): string | null {
  return value instanceof PdfName ? value.name : null;
}

/** A number array, dereferencing each element; null when any is not a number. */
export function numberArray(doc: PdfDocument, value: PdfValue | undefined): number[] | null {
  const array = doc.resolve(value);
  if (!Array.isArray(array)) return null;
  const out: number[] = [];
  for (const item of array) {
    const n = doc.resolve(item);
    if (typeof n !== "number" || !Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}
