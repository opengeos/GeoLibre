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
 * before the tail. A server that answers the first request with the whole
 * file (status 200) is handled from those bytes.
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
  if (first.status !== 206) {
    const bytes = new Uint8Array(await first.arrayBuffer());
    return { imdf: await isImdfZipRange(bytes.byteLength, bytesRangeReader(bytes)), bytes };
  }
  const total = Number(/\/(\d+)\s*$/.exec(first.headers.get("content-range") ?? "")?.[1]);
  if (!Number.isFinite(total) || total <= 0) return { imdf: false };
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
