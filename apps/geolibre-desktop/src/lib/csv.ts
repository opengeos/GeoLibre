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

/**
 * Neutralizes spreadsheet formula injection in untrusted text destined for a
 * CSV cell: a leading `=`, `+`, `-`, `@`, tab, or CR would otherwise execute
 * as a formula when the file is opened in spreadsheet software (quoting alone
 * does not prevent this). Apply to free-text fields sourced from untrusted
 * input, not to numeric or format-validated cells.
 *
 * @param text - The untrusted cell text.
 * @returns The text, prefixed with `'` when it starts with a formula trigger.
 */
export function spreadsheetSafeText(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
