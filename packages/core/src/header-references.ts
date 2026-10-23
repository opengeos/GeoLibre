/**
 * `${NAME}` references in request header values.
 *
 * A header such as `Authorization: Bearer ${TILES_TOKEN}` is saved as typed
 * and resolved from the project's Environment Variables when a request is
 * made, so the secret itself never sits on the layer. This module is pure (no
 * store import): `credentials.ts` depends on it, and the store depends on
 * `credentials.ts`.
 */

/** `${NAME}` where NAME follows the environment-variable name rule. */
const HEADER_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HAS_HEADER_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
/**
 * Optional auth scheme word, whitespace, one reference, nothing else. Kept in
 * lockstep with `_HEADER_REFERENCE_ONLY` in `python/src/geolibre/project.py`.
 */
const REFERENCE_ONLY = /^(?:[A-Za-z][A-Za-z0-9._-]*\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

const warnedMissing = new Set<string>();

export function hasHeaderReferences(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.values(headers).some(
    (value) => typeof value === "string" && HAS_HEADER_REFERENCE.test(value),
  );
}

/**
 * Whether `value` carries no secret of its own: at most a scheme word such as
 * `Bearer` followed by a single `${NAME}`. Redaction keeps such values.
 */
export function isHeaderReferenceOnly(value: string): boolean {
  return REFERENCE_ONLY.test(value.trim());
}

/**
 * Whether credential-bearing request headers may be sent to `url`: HTTPS, or
 * plain HTTP to loopback so a local dev server still works. The scheme is read
 * off a parsed URL, so an unusually cased `HTTPS://` is not misread as
 * plaintext; a relative or unparseable URL is refused.
 */
export function allowsCredentialHeaders(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return true;
    return (
      protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/**
 * `headers` with every `${NAME}` replaced by `values[NAME]`. A header that
 * references an unset (or empty) variable is omitted rather than sent with a
 * hole in it. Returns the input unchanged when nothing references a variable,
 * and `undefined` when no header remains.
 */
export function resolveHeaderReferences(
  headers: Record<string, string> | undefined,
  values: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  if (!Object.values(headers).some((value) => typeof value === "string" && value.includes("${"))) {
    return headers;
  }
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    let missing: string | null = null;
    const next = value.replace(HEADER_REFERENCE, (_match, variable: string) => {
      const replacement = Object.hasOwn(values, variable) ? values[variable] : "";
      if (!replacement) missing ??= variable;
      return replacement;
    });
    if (missing !== null) {
      const warnKey = `${name}:${missing}`;
      if (!warnedMissing.has(warnKey)) {
        warnedMissing.add(warnKey);
        console.warn(
          `[GeoLibre] Request header "${name}" references unset environment variable ${missing}; the header is not sent.`,
        );
      }
      continue;
    }
    resolved[name] = next;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
