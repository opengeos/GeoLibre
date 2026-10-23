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
