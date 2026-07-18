/**
 * RFC 4180 CSV cell quoting, shared by the CSV exporters (vector export, the
 * Raster Attribute Table). Kept dependency-free so pure modules (and their
 * `node --test` runs) can import it without dragging in browser-only bundles.
 *
 * @param value - The cell value; stringified with `String()`.
 * @returns The cell text, quoted when it contains a quote, comma, or newline.
 */
export function csvCell(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
