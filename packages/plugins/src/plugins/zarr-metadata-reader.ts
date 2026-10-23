/**
 * Reading a Zarr store's metadata documents, whatever the store is made of.
 *
 * Where the bytes come from differs — an HTTP request, a folder on disk, an Icechunk manifest — but
 * what happens to them does not: decode, parse, and treat anything else as a key the store does not
 * carry. Shared rather than written per store, so the same store cannot report different verdicts
 * depending on how it was opened.
 */

/**
 * Reads one of a store's metadata documents.
 *
 * @param key - Store-relative key, e.g. `.zmetadata` or `time/.zattrs`.
 * @returns The parsed JSON document, or undefined when the key is absent.
 */
export type ZarrMetadataReader = (key: string) => Promise<unknown | undefined>;

/**
 * Build a {@link ZarrMetadataReader} over any source of bytes.
 *
 * @param readBytes - Resolves a store-relative key to its bytes. Key rooting belongs here: a folder
 *   strips the leading slash zarrita adds, an Icechunk manifest requires it.
 */
export function createZarrMetadataReader(
  readBytes: (key: string) => Promise<Uint8Array | undefined>,
): ZarrMetadataReader {
  return async (key: string) => {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readBytes(key);
    } catch {
      // Most keys a walk asks for are absent from any given store, so a refusal moves to the next.
      return undefined;
    }
    if (!bytes) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      // A key that exists but is not JSON is not a metadata document.
      return undefined;
    }
  };
}
