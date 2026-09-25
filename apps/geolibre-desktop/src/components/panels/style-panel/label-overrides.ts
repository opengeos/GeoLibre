import { validateMapExpression } from "@geolibre/core";

/**
 * Data-defined label overrides (GH #1320): one row per {@link LabelStyle}
 * expression field, with the Expression Builder context enforcing each
 * destination's result type (size/opacity/priority are numbers, color a
 * color, visibility a boolean filter).
 */
export const LABEL_OVERRIDE_PROPERTIES = [
  {
    key: "size",
    field: "sizeExpression",
    context: "number",
    expectedType: "number",
  },
  {
    key: "color",
    field: "colorExpression",
    context: "color",
    expectedType: "color",
  },
  {
    key: "opacity",
    field: "opacityExpression",
    context: "number",
    expectedType: "number",
  },
  {
    key: "visibility",
    field: "visibilityExpression",
    context: "filter",
    expectedType: "boolean",
  },
  {
    key: "priority",
    field: "priorityExpression",
    context: "number",
    expectedType: "number",
  },
] as const;
export type LabelOverrideProperty = (typeof LABEL_OVERRIDE_PROPERTIES)[number];

// Override validity is checked on every panel render, and compiling through
// the style spec is far more expensive than a lookup, so results are memoized
// by expected type + source (module scope: this section renders below the
// component's early returns, where a useMemo would violate the rules of
// hooks). Bounded so a pathological stream of distinct expressions cannot
// grow it without limit.
const labelOverrideValidityCache = new Map<string, boolean>();
const LABEL_OVERRIDE_VALIDITY_CACHE_MAX = 256;

export function labelOverrideInvalid(
  value: string,
  expectedType: "number" | "color" | "boolean",
): boolean {
  const key = `${expectedType}:${value}`;
  const cached = labelOverrideValidityCache.get(key);
  if (cached !== undefined) return cached;
  const invalid = !validateMapExpression(value, { expectedType }).ok;
  if (labelOverrideValidityCache.size >= LABEL_OVERRIDE_VALIDITY_CACHE_MAX) {
    labelOverrideValidityCache.clear();
  }
  labelOverrideValidityCache.set(key, invalid);
  return invalid;
}
