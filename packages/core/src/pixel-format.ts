/**
 * Trim a float sample to something readable. A 32-bit raster value decoded to a
 * JS double prints all 17 digits of its binary representation
 * (`48.11851119995117`), which is noise past the sensor's precision — six
 * significant digits is more than any COG carries. Integers are left alone so a
 * classification code is never shown in exponential form.
 *
 * @param value A decoded raster sample.
 * @returns The sample rendered for display.
 */
export function formatPixelValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

/**
 * Whether a band description is a placeholder meaning "no name" rather than an
 * actual name. Esri tools write a literal `*` into `DESCRIPTION` (alongside
 * `BandDefinitionKeyword=*`) for a band they know nothing about; shown as is,
 * the band reads as `*` in Identify and the band picker. Callers fall back to
 * their "Band N" label instead.
 *
 * @param name A band description read from the file, if any.
 * @returns True when the name is missing, blank, or a known placeholder.
 */
export function isPlaceholderBandName(name: string | null | undefined): boolean {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || trimmed === "*";
}
