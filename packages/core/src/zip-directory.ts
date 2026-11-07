/**
 * List a zip archive's entry paths from its central directory, reading only
 * the end of the archive (a byte-range reader), never the whole file. Shared by
 * the plugin file-drop hints and the IMDF detection (issue #3341), so a large
 * shapefile zip is ruled out without being read.
 */

export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const CENTRAL_ENTRY_SIZE = 46;
/** General purpose flag bit 11: the entry name is UTF-8 rather than CP437. */
const UTF8_NAME_FLAG = 0x0800;
/** The upper half (0x80-0xff) of code page 437, the zip default for names. */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
/** Longest possible zip comment plus the record that precedes it. */
const MAX_EOCD_SEARCH = 0xffff + EOCD_SIZE;
/** End-record candidates tried before giving up, so a hostile comment stays cheap. */
const MAX_EOCD_CANDIDATES = 16;
const UTF8_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** A central directory beyond this is not a file a handler should inspect. */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeCp437(bytes: Uint8Array): string {
  let name = "";
  for (const byte of bytes)
    name += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  return name;
}

/**
 * Decode an entry name. Flag bit 11 says UTF-8. Without it the zip default is
 * CP437, but some writers (macOS "Compress") store UTF-8 without the flag, so
 * a name that is valid UTF-8 is read as such before falling back to CP437.
 */
function decodeEntryName(name: Uint8Array, flags: number): string {
  if (flags & UTF8_NAME_FLAG) return UTF8_DECODER.decode(name);
  if (name.some((byte) => byte >= 0x80)) {
    try {
      return STRICT_UTF8_DECODER.decode(name);
    } catch {
      return decodeCp437(name);
    }
  }
  return decodeCp437(name);
}

/**
 * List the paths inside a zip from its central directory, reading only the tail
 * of the archive rather than the whole file.
 *
 * Deliberately not listed (the result is undefined, so a handler can still claim
 * by file name): archives with bytes in front of them (self-extracting zips),
 * and spanned or multi-disk archives. The entries are a hint for `claim`, not a full zip
 * parser; a handler that needs these cases unpacks the file itself in `open`.
 *
 * @param size - The archive's size in bytes.
 * @param readRange - Reads a byte range of the archive.
 * @returns The entry paths in archive order, or undefined when the file has no
 *   readable central directory (not a zip, or truncated).
 */
export async function listZipEntryPaths(
  size: number,
  readRange: ReadRange,
): Promise<string[] | undefined> {
  if (size < EOCD_SIZE) return undefined;
  const tailLength = Math.min(size, MAX_EOCD_SEARCH);
  const tailOffset = size - tailLength;
  const tail = await readRange(tailOffset, tailLength);
  const tailView = viewOf(tail);

  /** Whether a central directory entry starts at `offset`, with `length` bytes in range. */
  const startsDirectory = async (offset: number, length: number): Promise<boolean> => {
    if (length < CENTRAL_ENTRY_SIZE) return false;
    if (offset + length > size) return false;
    // A signature inside the tail already read needs no extra read.
    if (offset >= tailOffset && offset + 4 <= tailOffset + tail.byteLength) {
      return tailView.getUint32(offset - tailOffset, true) === CENTRAL_ENTRY_SIGNATURE;
    }
    const head = await readRange(offset, 4);
    return head.byteLength === 4 && viewOf(head).getUint32(0, true) === CENTRAL_ENTRY_SIGNATURE;
  };
  /** The directory the end record at `eocd` declares, if one really starts there. */
  const checkRecord = async (
    eocd: number,
  ): Promise<[offset: number, length: number] | undefined> => {
    // A spanned archive cannot be unpacked by a handler.
    const disk = tailView.getUint16(eocd + 4, true);
    const directoryDisk = tailView.getUint16(eocd + 6, true);
    if (disk !== 0 || directoryDisk !== 0) return undefined;
    let total = tailView.getUint16(eocd + 10, true);
    // An empty archive's directory "starts" where its own end record (ZIP64 or
    // classic) does; a lookalike elsewhere is not one.
    let recordOffset = tailOffset + eocd;
    let length = tailView.getUint32(eocd + 12, true);
    let offset = tailView.getUint32(eocd + 16, true);
    if (length === 0xffffffff || offset === 0xffffffff) {
      const locator = eocd - ZIP64_LOCATOR_SIZE;
      if (locator < 0 || tailView.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
        return undefined;
      }
      // The locator names the disk of the ZIP64 record and the disk count.
      if (tailView.getUint32(locator + 4, true) !== 0) return undefined;
      if (tailView.getUint32(locator + 16, true) > 1) return undefined;
      const zip64Offset = Number(tailView.getBigUint64(locator + 8, true));
      if (zip64Offset + ZIP64_EOCD_SIZE > size) return undefined;
      const zip64Bytes = await readRange(zip64Offset, ZIP64_EOCD_SIZE);
      if (zip64Bytes.byteLength !== ZIP64_EOCD_SIZE) return undefined;
      const zip64 = viewOf(zip64Bytes);
      if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) return undefined;
      if (zip64.getUint32(16, true) !== 0 || zip64.getUint32(20, true) !== 0) return undefined;
      recordOffset = zip64Offset;
      total = Number(zip64.getBigUint64(32, true));
      length = Number(zip64.getBigUint64(40, true));
      offset = Number(zip64.getBigUint64(48, true));
    }
    // An empty archive has no entry to find a signature at.
    if (length === 0) return total === 0 && offset === recordOffset ? [offset, 0] : undefined;
    return (await startsDirectory(offset, length)) ? [offset, length] : undefined;
  };

  // Scan back for an end record that points at a real directory: a signature
  // inside the archive comment is only a candidate. The record whose declared
  // comment ends exactly at the end of the file is the real one in a well-formed
  // zip, so it goes first and needs no extra read to be picked.
  const exact: number[] = [];
  const others: number[] = [];
  for (let eocd = tail.byteLength - EOCD_SIZE; eocd >= 0; eocd -= 1) {
    if (tailView.getUint32(eocd, true) !== EOCD_SIGNATURE) continue;
    const ends = eocd + EOCD_SIZE + tailView.getUint16(eocd + 20, true) === tail.byteLength;
    if (ends) exact.push(eocd);
    else others.push(eocd);
  }
  // The scan runs from the end backwards, so reverse the exact records to keep
  // them in ascending offset order, as prepending them used to.
  const candidates = [...exact.reverse(), ...others];
  let located: [offset: number, length: number] | undefined;
  for (const eocd of candidates.slice(0, MAX_EOCD_CANDIDATES)) {
    located = await checkRecord(eocd);
    if (located) break;
  }
  if (!located) return undefined;
  const [directoryOffset, directorySize] = located;
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize > size) {
    return undefined;
  }

  const directory = await readRange(directoryOffset, directorySize);
  const view = viewOf(directory);
  const paths: string[] = [];
  let cursor = 0;
  while (cursor + CENTRAL_ENTRY_SIZE <= directory.byteLength) {
    if (view.getUint32(cursor, true) !== CENTRAL_ENTRY_SIGNATURE) return undefined;
    const flags = view.getUint16(cursor + 8, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + CENTRAL_ENTRY_SIZE;
    if (nameStart + nameLength > directory.byteLength) return undefined;
    const name = directory.subarray(nameStart, nameStart + nameLength);
    paths.push(decodeEntryName(name, flags));
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return paths;
}
