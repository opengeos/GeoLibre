/**
 * Whether binary output is a (Big)TIFF, by magic bytes.
 *
 * Several Whitebox raster tools declare their output as a generic `file_out`
 * — `slope`'s is described only as "Optional output path" — even though what
 * they write is a GeoTIFF. ProcessingDialog can afford to treat those as files
 * because it hands the user a download; this API has no such affordance, so a
 * raster the caller asked for would simply vanish with a note. Sniffing the
 * content is what the dialog already does to name that download, applied here
 * to decide whether the bytes are a map layer.
 *
 * @param bytes The tool's binary output.
 * @returns True for little- or big-endian TIFF and BigTIFF.
 */
export function isTiff(bytes: Uint8Array): boolean {
  const matches = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  // "II" little-endian / "MM" big-endian, then version 42 (TIFF) or 43 (BigTIFF).
  return (
    matches([0x49, 0x49, 0x2a, 0x00]) ||
    matches([0x4d, 0x4d, 0x00, 0x2a]) ||
    matches([0x49, 0x49, 0x2b, 0x00]) ||
    matches([0x4d, 0x4d, 0x00, 0x2b])
  );
}
