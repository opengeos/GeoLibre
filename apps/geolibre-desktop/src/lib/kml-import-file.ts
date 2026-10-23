/**
 * Turns a picked or downloaded KML/KMZ document into the `File` the host KML
 * importer expects, so the Add Data dialog can hand a URL or a native file
 * pick through the same path drag-and-drop and the Browser panel use on the
 * 2D renderers (folder-aware placemark layers, ground overlays, models, and
 * Super-Overlays), rather than the Cesium-only `KmlDataSource`.
 */

import type { KmlFileImport } from "@geolibre/plugins";

const KMZ_MIME = "application/vnd.google-earth.kmz";
const KML_MIME = "application/vnd.google-earth.kml+xml";

/** Whether the bytes are a zip archive (the KMZ container), by its `PK` magic. */
export function isKmzBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * Derives the file name a downloaded document should carry. The importer routes
 * on the extension, so a URL without one (a KML service endpoint, a download
 * handler) gets `.kmz` or `.kml` from the payload itself.
 *
 * @param url - The URL the document was fetched from.
 * @param bytes - The downloaded payload.
 * @returns A file name ending in `.kml` or `.kmz`.
 */
export function kmlFileNameFromUrl(url: string, bytes: Uint8Array): string {
  let segment = "";
  try {
    const path = new URL(url).pathname;
    segment = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
  } catch {
    segment = url.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  }
  const kmz = isKmzBytes(bytes);
  const extension = kmz ? "kmz" : "kml";
  const base = segment.replace(/\.(?:kml|kmz)$/i, "") || "document";
  if (/\.(?:kml|kmz)$/i.test(segment)) {
    // Trust the payload over the URL: a `.kml` link that serves a zip is a KMZ.
    const claims = segment.toLowerCase().endsWith(".kmz");
    return claims === kmz ? segment : `${base}.${extension}`;
  }
  return `${base}.${extension}`;
}

/**
 * Builds the `File` handed to the KML importer.
 *
 * @param name - The file name (its extension decides KML vs KMZ handling).
 * @param content - The document as text, an `ArrayBuffer`, or bytes.
 * @returns A `File` named after the document with the matching MIME type.
 */
export function kmlImportFile(name: string, content: string | ArrayBuffer | Uint8Array): File {
  const kmz = /\.kmz$/i.test(name);
  // A typed-array view is read by its byteOffset/byteLength, so no copy is
  // needed; the cast only widens `Uint8Array<ArrayBufferLike>` to BlobPart.
  return new File([content as BlobPart], name, { type: kmz ? KMZ_MIME : KML_MIME });
}

/** A KML/KMZ document picked through the local file dialog. */
export interface PickedKmlDocument {
  /** The filesystem path on desktop; just the file name in the browser. */
  path: string;
  /** The KMZ archive bytes (binary picks). */
  data?: ArrayBuffer;
  /** The KML document text (text picks). */
  text?: string;
}

/**
 * Builds the imports the Add Data dialog hands to the host KML importer on the
 * 2D renderers: the picked document when there is one, otherwise the document
 * downloaded from `url`.
 *
 * @param picked - The picked document, or `null` to use the URL.
 * @param url - The KML/KMZ URL (used only without a pick).
 * @param options.nativePath - Whether `picked.path` is a real filesystem path
 *   the importer may re-read (a desktop pick); a browser File's `path` is just
 *   its name and must not be forwarded.
 * @param options.fileName - Derives the file name from a picked path.
 * @param options.fetchFile - Downloads a URL into a `File`.
 * @returns The imports, always exactly one.
 */
export async function kmlMapImports(
  picked: PickedKmlDocument | null,
  url: string,
  options: {
    nativePath: boolean;
    fileName: (path: string) => string;
    fetchFile: (url: string) => Promise<File>;
  },
): Promise<KmlFileImport[]> {
  if (picked) {
    return [
      {
        file: kmlImportFile(options.fileName(picked.path), picked.data ?? picked.text ?? ""),
        sourcePath: options.nativePath ? picked.path : undefined,
      },
    ];
  }
  return [{ file: await options.fetchFile(url) }];
}
