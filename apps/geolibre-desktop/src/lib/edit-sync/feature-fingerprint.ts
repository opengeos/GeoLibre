/**
 * Content fingerprints for offline edit sync (#3530).
 *
 * The edit outbox decides whether a feature changed locally, changed on the
 * server, or both, by comparing short content hashes rather than whole
 * features. A fingerprint covers a feature's geometry and attributes and
 * ignores its id, so the same row read twice through the same loader always
 * hashes the same, and a three-way comparison (base, mine, theirs) needs only
 * the base fingerprint to be kept from load time.
 *
 * DOM-free and dependency-free so it runs under `node --test`.
 */

import type { Feature } from "geojson";

/** The GeoEditor's transient feature-key tag; never a real attribute. */
const GEOMETRY_EDIT_FID_PROPERTY = "__geolibre_fid";

/** Editor-internal keys that can survive an edit session but are not data. */
function isInternalProperty(key: string): boolean {
  return key.startsWith("__gm_") || key === GEOMETRY_EDIT_FID_PROPERTY;
}

/**
 * Serialize a JSON value with object keys sorted at every depth, so two
 * structurally equal values always produce the same string.
 *
 * @param value Any JSON-compatible value.
 * @returns The canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    return text === undefined ? "null" : text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * 53-bit string hash (cyrb53). Not cryptographic: the outbox only needs to
 * tell edited content from unedited content, never to resist forgery.
 *
 * @param text The text to hash.
 * @returns A 14-character hex digest.
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, "0");
}

/** Options for {@link featureFingerprint}. */
export interface FingerprintOptions {
  /**
   * Attribute names left out of the hash, e.g. a primary-key column, so an
   * inserted row can be matched to its local feature before it had a key.
   */
  omitProperties?: readonly string[];
}

/**
 * Fingerprint a feature's geometry and attributes.
 *
 * Null-valued attributes count as absent: a database row exposes every column
 * as `null` while an editor round trip drops null keys, and both mean the same
 * thing to the source. Editor-internal keys and the feature id are ignored.
 *
 * @param feature The feature to hash.
 * @param options Attributes to leave out.
 * @returns A short, stable content hash.
 */
export function featureFingerprint(
  feature: Pick<Feature, "geometry" | "properties">,
  options: FingerprintOptions = {},
): string {
  const omit = new Set(options.omitProperties ?? []);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(feature.properties ?? {})) {
    if (value === null || value === undefined) continue;
    if (omit.has(key) || isInternalProperty(key)) continue;
    properties[key] = value;
  }
  return hashText(canonicalJson({ g: feature.geometry ?? null, p: properties }));
}

/** The string key a feature carries in its GeoJSON `id`, or null. */
export function featureIdKey(feature: Pick<Feature, "id">): string | null {
  const id = feature.id;
  if (typeof id === "number") return Number.isFinite(id) ? String(id) : null;
  if (typeof id === "string" && id.trim() !== "") return id;
  return null;
}

/**
 * Fingerprint every keyed feature of a freshly loaded collection: the base
 * snapshot the outbox later diffs local edits and server changes against.
 *
 * @param features The features as loaded from the source.
 * @param keyOf How to read a feature's source key (defaults to its `id`).
 * @param options Fingerprint options.
 * @returns A map of key to fingerprint, as a plain JSON-safe object.
 */
export function captureFingerprintBaseline(
  features: readonly Feature[],
  keyOf: (feature: Feature) => string | null = featureIdKey,
  options: FingerprintOptions = {},
): Record<string, string> {
  const baseline = new Map<string, string>();
  for (const feature of features) {
    const key = keyOf(feature);
    if (key === null || baseline.has(key)) continue;
    baseline.set(key, featureFingerprint(feature, options));
  }
  // fromEntries defines own properties, so a key like "__proto__" stays data.
  return Object.fromEntries(baseline);
}

/**
 * Look up a key in a fingerprint baseline without reaching inherited object
 * members (a row keyed "constructor" must not read `Object.prototype`).
 *
 * @param baseline The baseline, possibly malformed project metadata.
 * @param key The source key.
 * @returns The base fingerprint, or undefined when the key was not loaded.
 */
export function baselineFingerprint(baseline: unknown, key: string): string | undefined {
  if (!baseline || typeof baseline !== "object") return undefined;
  if (!Object.hasOwn(baseline, key)) return undefined;
  const value = (baseline as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a fingerprint baseline from untrusted metadata, keeping only string
 * entries, or return undefined when there is none.
 *
 * @param value The stored value.
 * @returns The baseline keys in insertion order with their fingerprints.
 */
export function readFingerprintBaseline(value: unknown): Map<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = new Map<string, string>();
  for (const [key, fingerprint] of Object.entries(value as Record<string, unknown>)) {
    if (typeof fingerprint === "string") out.set(key, fingerprint);
  }
  return out;
}
