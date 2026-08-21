/**
 * An id for a layer a plugin creates. `crypto.randomUUID` needs a secure context, which a
 * self-hosted GeoLibre served over plain http is not, so fall back to something unique enough for
 * one session rather than throwing.
 */
export function createLayerId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
