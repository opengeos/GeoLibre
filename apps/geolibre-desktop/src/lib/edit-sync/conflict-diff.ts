/**
 * Side-by-side comparison of my version and the server's version of a
 * conflicted feature, for the outbox review dialog (#3530).
 */

import type { Feature } from "geojson";
import { canonicalJson, isInternalProperty } from "./feature-fingerprint";

/** One attribute that differs between the two versions. */
export interface AttributeDifference {
  name: string;
  mine: unknown;
  theirs: unknown;
}

/** How two versions of a feature differ. */
export interface FeatureDifference {
  geometryDiffers: boolean;
  attributes: AttributeDifference[];
}

/**
 * Compare my version of a feature with the server's.
 *
 * Null and missing attributes are equal, matching the fingerprints.
 *
 * @param mine My version (absent for a delete).
 * @param theirs The server's version (null when the server deleted it).
 * @returns The geometry flag and the differing attributes, sorted by name.
 */
export function diffConflictVersions(
  mine: Feature | undefined,
  theirs: Feature | null,
): FeatureDifference {
  const mineProps = mine?.properties ?? {};
  const theirProps = theirs?.properties ?? {};
  const names = new Set([...Object.keys(mineProps), ...Object.keys(theirProps)]);
  const attributes: AttributeDifference[] = [];
  for (const name of [...names].sort()) {
    if (isInternalProperty(name)) continue;
    const a = mineProps[name] ?? null;
    const b = theirProps[name] ?? null;
    if (canonicalJson(a) !== canonicalJson(b)) attributes.push({ name, mine: a, theirs: b });
  }
  return {
    geometryDiffers:
      canonicalJson(mine?.geometry ?? null) !== canonicalJson(theirs?.geometry ?? null),
    attributes,
  };
}

/**
 * Format an attribute value for a compact table cell.
 *
 * @param value The value.
 * @returns Display text (empty for null).
 */
export function formatAttributeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  const text = canonicalJson(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
