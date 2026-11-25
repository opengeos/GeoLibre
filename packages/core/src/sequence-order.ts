// Ordering of route waypoints by an attribute value. Kept free of runtime-env
// and store imports so `@geolibre/core/worker-safe` can expose it to the
// processing worker (the local network tools sort their stops with it).

/**
 * Comparator for ordering route waypoints by a chosen attribute value. Numeric
 * strings and timestamps (anything `Date.parse` understands, e.g. ISO 8601)
 * sort chronologically/numerically; values that parse this way sort before
 * free-form text, which falls back to a locale string comparison. Empty/missing
 * values sort last so unlabeled points trail the ordered ones.
 *
 * Numeric parsing is tried before date parsing, so a single column is expected
 * to use one convention: a column mixing plain integers with ISO timestamps
 * would compare them on the same numeric axis (epoch millis dwarf small
 * integers), which is not a meaningful ordering. Real sequence/time columns use
 * one convention, so this is acceptable in practice.
 *
 * @param a - The first value.
 * @param b - The second value.
 * @returns A negative, zero, or positive number for ascending order.
 */
export function compareSequenceValues(a: unknown, b: unknown): number {
  const aMissing = isMissingValue(a);
  const bMissing = isMissingValue(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const an = toComparableNumber(a);
  const bn = toComparableNumber(b);
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return String(a).localeCompare(String(b));
}

function isMissingValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function toComparableNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Only treat plain decimal/scientific notation as numeric, so hex ("0x1A")
    // and other Number()-coercible forms sort as text rather than by their
    // surprising numeric value.
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
