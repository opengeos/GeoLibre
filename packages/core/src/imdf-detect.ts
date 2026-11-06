import { listZipEntryPaths, type ReadRange } from "./zip-directory";

/**
 * Recognizing an IMDF (Indoor Mapping Data Format) archive without unpacking it
 * (issue #3341). One implementation for every entry point: the app's file and
 * drop loaders and the Add Vector panel's picker and URL loads.
 *
 * Only the zip's central directory is read (its tail, through a byte-range
 * reader), so ruling out a large shapefile zip costs a few kilobytes.
 */

/** Bytes read from the end of an archive: the longest zip comment plus its end record. */
const TAIL_BYTES = 0xffff + 22;
/**
 * Largest archive downloaded whole just to look inside it, when a server will
 * not serve a byte range. IMDF venues are small; a larger zip is left to the
 * vector control, which downloads it once anyway.
 */
const MAX_PROBE_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** Whether an archive entry is macOS resource-fork noise (`__MACOSX/`, `._name`). */
export function isMacOsZipMetadata(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return path.startsWith("__MACOSX/") || path.includes("/__MACOSX/") || base.startsWith("._");
}

/**
 * Whether a list of zip entry paths is an IMDF archive: a `manifest.json` beside
 * a `venue`, `level` or `unit` GeoJSON file, in any folder, ignoring case and
 * macOS metadata entries.
 *
 * @param paths - The archive's entry paths.
 * @returns True for an IMDF archive.
 */
export function isImdfArchiveEntries(paths: readonly string[]): boolean {
  let manifest = false;
  let core = false;
  for (const path of paths) {
    if (isMacOsZipMetadata(path)) continue;
    const name = path.split("/").pop()?.toLowerCase() ?? "";
    if (name === "manifest.json") manifest = true;
    if (name === "venue.geojson" || name === "level.geojson" || name === "unit.geojson")
      core = true;
  }
  return manifest && core;
}

/** A byte-range reader over a `Blob` (or `File`), reading only the slices asked for. */
export function blobRangeReader(blob: Blob): ReadRange {
  return async (offset, length) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
}

/** A byte-range reader over bytes already in memory. */
export function bytesRangeReader(bytes: Uint8Array): ReadRange {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}

/**
 * Whether an archive of `size` bytes is IMDF, reading only its central
 * directory through `readRange`.
 *
 * @param size - The archive's size in bytes.
 * @param readRange - Reads a byte range of the archive.
 * @returns True for an IMDF archive; false for any other zip or a non-zip.
 */
export async function isImdfZipRange(size: number, readRange: ReadRange): Promise<boolean> {
  try {
    const paths = await listZipEntryPaths(size, readRange);
    return paths !== undefined && isImdfArchiveEntries(paths);
  } catch {
    return false;
  }
}

/**
 * Whether a `Blob` (a picked or dropped file) is an IMDF zip, reading only its
 * central directory.
 *
 * @param blob - The file.
 * @returns True for an IMDF archive.
 */
export function isImdfZipBlob(blob: Blob): Promise<boolean> {
  return isImdfZipRange(blob.size, blobRangeReader(blob));
}

/** What probing a zip URL found. */
export interface ImdfUrlProbe {
  /** Whether the archive is IMDF. */
  imdf: boolean;
  /**
   * The whole archive when the probe had to download it (a server that ignores
   * `Range` requests), so the caller does not download it again.
   */
  bytes?: Uint8Array;
}

/**
 * Probe a zip URL for IMDF with HTTP range requests: the tail first (which
 * also gives the archive's size), then the central directory if it starts
 * before the tail.
 *
 * Two hosts need more. One that ignores `Range` answers with the whole file
 * (status 200); one that serves ranges cross-origin without exposing
 * `Content-Range` leaves the archive's size unknown. Either way the archive is
 * read whole instead, up to {@link MAX_PROBE_DOWNLOAD_BYTES}: a larger one is
 * reported as not IMDF without reading its body, so the control downloads it
 * once rather than twice.
 *
 * @param url - The archive's URL.
 * @param fetchImpl - `fetch`, injectable for tests.
 * @returns Whether the archive is IMDF, and its bytes if they were downloaded.
 * @throws Error when the URL cannot be fetched at all.
 */
export async function probeImdfZipUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImdfUrlProbe> {
  const first = await fetchImpl(url, { headers: { Range: `bytes=-${TAIL_BYTES}` } });
  if (!first.ok) throw new Error(`HTTP ${first.status}`);
  if (first.status !== 206) return probeWholeResponse(first);
  const total = Number(/\/(\d+)\s*$/.exec(first.headers.get("content-range") ?? "")?.[1]);
  if (!Number.isFinite(total) || total <= 0) {
    // Ranges work but the size is hidden (no Access-Control-Expose-Headers):
    // not a reason to call an IMDF zip a shapefile.
    await first.body?.cancel().catch(() => {});
    const whole = await fetchImpl(url);
    if (!whole.ok) throw new Error(`HTTP ${whole.status}`);
    return probeWholeResponse(whole);
  }
  const tail = new Uint8Array(await first.arrayBuffer());
  const tailOffset = total - tail.byteLength;
  const readRange: ReadRange = async (offset, length) => {
    if (offset >= tailOffset && offset + length <= total) {
      return tail.subarray(offset - tailOffset, offset - tailOffset + length);
    }
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (response.status !== 206) throw new Error("range request not honoured");
    return new Uint8Array(await response.arrayBuffer());
  };
  return { imdf: await isImdfZipRange(total, readRange) };
}

/**
 * Classify an archive from a response carrying all of it, reading the body
 * only when it is small enough to be an IMDF venue.
 *
 * @param response - A full (status 200) response.
 * @returns The probe, with the bytes when they were read.
 */
async function probeWholeResponse(response: Response): Promise<ImdfUrlProbe> {
  const bytes = await readBodyUpTo(response, MAX_PROBE_DOWNLOAD_BYTES);
  if (!bytes) return { imdf: false };
  return { imdf: await isImdfZipRange(bytes.byteLength, bytesRangeReader(bytes)), bytes };
}

/**
 * Read a response body, giving up (and cancelling the rest) once it passes
 * `limit` bytes. The size header cannot be trusted for this: it may be absent
 * (a chunked response) or hidden from script on a cross-origin one.
 *
 * @param response - The response.
 * @param limit - The most bytes to read.
 * @returns The body, or `null` when it is larger than `limit`.
 */
async function readBodyUpTo(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limit ? null : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
