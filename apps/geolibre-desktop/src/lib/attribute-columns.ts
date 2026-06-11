import {
  styleValue,
  type GeoLibreLayer,
  type LayerStyle,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/**
 * Per-layer attribute-table column settings, persisted under
 * `layer.metadata.columnSettings` so they survive save/reload. Only view-level
 * concerns live here (visibility and order); rename and delete are destructive
 * and rewrite the underlying GeoJSON properties instead.
 */
export interface ColumnSettings {
  /** Property keys hidden from the table (view-only, non-destructive). */
  hidden?: string[];
  /** Explicit display order of property keys; unknown keys append after. */
  order?: string[];
}

export type ColumnMoveDirection = "left" | "right";

const COLUMN_SETTINGS_KEY = "columnSettings";

// Style fields that hold a literal property name a destructive rename/delete
// must keep in sync. Free-form expression fields (vectorStyleExpression,
// extrusion*Expression) are intentionally left untouched — rewriting arbitrary
// MapLibre expressions is out of scope.
const STYLE_FIELD_KEYS = [
  "vectorStyleProperty",
  "extrusionHeightProperty",
] as const satisfies ReadonlyArray<keyof LayerStyle>;

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

/** Read the layer's column settings, tolerating missing/malformed metadata. */
export function getColumnSettings(
  layer?: GeoLibreLayer | null,
): ColumnSettings {
  const raw = layer?.metadata?.[COLUMN_SETTINGS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const settings = raw as ColumnSettings;
  return {
    hidden: stringArray(settings.hidden),
    order: stringArray(settings.order),
  };
}

/** Drop empty fields so a no-op settings object isn't persisted. */
function normalizeSettings(settings: ColumnSettings): ColumnSettings | null {
  const hidden = settings.hidden?.length ? settings.hidden : undefined;
  const order = settings.order?.length ? settings.order : undefined;
  if (!hidden && !order) return null;
  return {
    ...(hidden ? { hidden } : {}),
    ...(order ? { order } : {}),
  };
}

/**
 * Build a full metadata object carrying the next column settings, ready to pass
 * to `updateLayer` (which replaces metadata wholesale). Removes the key when the
 * settings are empty.
 */
function metadataWithSettings(
  layer: GeoLibreLayer,
  next: ColumnSettings,
): Record<string, unknown> {
  const metadata = { ...(layer.metadata ?? {}) };
  const normalized = normalizeSettings(next);
  if (normalized) metadata[COLUMN_SETTINGS_KEY] = normalized;
  else delete metadata[COLUMN_SETTINGS_KEY];
  return metadata;
}

/**
 * Full display order of all discovered columns: settings.order first (filtered
 * to columns that still exist), then any newly-discovered columns in their
 * discovery order. Includes hidden columns.
 */
export function orderColumns(
  discovered: string[],
  settings: ColumnSettings,
): string[] {
  const known = new Set(discovered);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of settings.order ?? []) {
    if (known.has(key) && !seen.has(key)) {
      result.push(key);
      seen.add(key);
    }
  }
  for (const key of discovered) {
    if (!seen.has(key)) {
      result.push(key);
      seen.add(key);
    }
  }
  return result;
}

/** Ordered columns with hidden ones removed — what the table renders. */
export function visibleColumns(
  discovered: string[],
  settings: ColumnSettings,
): string[] {
  const hidden = new Set(settings.hidden ?? []);
  return orderColumns(discovered, settings).filter((key) => !hidden.has(key));
}

/** Ordered columns that are currently hidden. */
export function hiddenColumns(
  discovered: string[],
  settings: ColumnSettings,
): string[] {
  const hidden = new Set(settings.hidden ?? []);
  return orderColumns(discovered, settings).filter((key) => hidden.has(key));
}

// NOTE: renameFieldInGeojson/deleteFieldInGeojson rewrite every feature's
// property object synchronously on the main thread. This is fine for typical
// in-browser GeoJSON sizes but will visibly jank on very large layers (tens of
// thousands of features); chunking or a worker would be needed if that becomes
// a real workflow. Kept synchronous deliberately — these run on a user-initiated
// one-off action, not in a hot path.
function renameFieldInGeojson(
  geojson: FeatureCollection,
  oldKey: string,
  newKey: string,
): FeatureCollection {
  return {
    ...geojson,
    features: geojson.features.map((feature) => {
      const properties = feature.properties;
      if (!properties || !(oldKey in properties)) return feature;
      // Rebuild to keep the renamed key in its original position.
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        next[key === oldKey ? newKey : key] = value;
      }
      return { ...feature, properties: next };
    }),
  };
}

function deleteFieldInGeojson(
  geojson: FeatureCollection,
  key: string,
): FeatureCollection {
  return {
    ...geojson,
    features: geojson.features.map((feature) => {
      const properties = feature.properties;
      if (!properties || !(key in properties)) return feature;
      const { [key]: _removed, ...rest } = properties;
      return { ...feature, properties: rest };
    }),
  };
}

function renameFieldInStyle(
  style: LayerStyle,
  oldKey: string,
  newKey: string,
): LayerStyle {
  let next = style;
  for (const key of STYLE_FIELD_KEYS) {
    if (styleValue(style, key) === oldKey) next = { ...next, [key]: newKey };
  }
  return next;
}

function clearFieldInStyle(style: LayerStyle, key: string): LayerStyle {
  let next = style;
  for (const styleKey of STYLE_FIELD_KEYS) {
    // Reset to "" rather than the shared default so a deleted field does not
    // silently re-point styling at some other (possibly absent) property.
    if (styleValue(style, styleKey) === key) next = { ...next, [styleKey]: "" };
  }
  return next;
}

function renameKeyInSettings(
  settings: ColumnSettings,
  oldKey: string,
  newKey: string,
): ColumnSettings {
  return {
    hidden: settings.hidden?.map((key) => (key === oldKey ? newKey : key)),
    order: settings.order?.map((key) => (key === oldKey ? newKey : key)),
  };
}

function removeKeyFromSettings(
  settings: ColumnSettings,
  key: string,
): ColumnSettings {
  return {
    hidden: settings.hidden?.filter((entry) => entry !== key),
    order: settings.order?.filter((entry) => entry !== key),
  };
}

/**
 * Destructive rename of a property key across every feature, keeping styling and
 * column settings in sync. Returns null (no-op) when the new name is empty,
 * unchanged, or collides with an existing column, or when the layer has no
 * in-store GeoJSON.
 */
export function renameColumn(
  layer: GeoLibreLayer,
  discovered: string[],
  oldKey: string,
  rawNewKey: string,
): Partial<GeoLibreLayer> | null {
  const newKey = rawNewKey.trim();
  if (!layer.geojson || !newKey || newKey === oldKey) return null;
  if (!discovered.includes(oldKey)) return null; // nothing to rename
  if (discovered.includes(newKey)) return null; // would clobber another column
  const settings = getColumnSettings(layer);
  return {
    geojson: renameFieldInGeojson(layer.geojson, oldKey, newKey),
    style: renameFieldInStyle(layer.style, oldKey, newKey),
    metadata: metadataWithSettings(
      layer,
      renameKeyInSettings(settings, oldKey, newKey),
    ),
  };
}

/** Destructive removal of a property key from every feature. */
export function deleteColumn(
  layer: GeoLibreLayer,
  key: string,
): Partial<GeoLibreLayer> | null {
  if (!layer.geojson) return null;
  // Mirror renameColumn's guard: a key absent from every feature is a no-op, so
  // don't return a patch that would touch style/settings without changing data.
  const keyExists = layer.geojson.features.some(
    (feature) => feature.properties != null && key in feature.properties,
  );
  if (!keyExists) return null;
  const settings = getColumnSettings(layer);
  return {
    geojson: deleteFieldInGeojson(layer.geojson, key),
    style: clearFieldInStyle(layer.style, key),
    metadata: metadataWithSettings(layer, removeKeyFromSettings(settings, key)),
  };
}

/** Toggle a column's visibility (view-only metadata change). */
export function toggleColumnHidden(
  layer: GeoLibreLayer,
  key: string,
): Partial<GeoLibreLayer> {
  const settings = getColumnSettings(layer);
  const hidden = new Set(settings.hidden ?? []);
  if (hidden.has(key)) hidden.delete(key);
  else hidden.add(key);
  return {
    metadata: metadataWithSettings(layer, { ...settings, hidden: [...hidden] }),
  };
}

/** Reveal every hidden column. */
export function showAllColumns(layer: GeoLibreLayer): Partial<GeoLibreLayer> {
  const settings = getColumnSettings(layer);
  return {
    metadata: metadataWithSettings(layer, { ...settings, hidden: [] }),
  };
}

/**
 * Move a column one slot left or right among the visible columns, persisting
 * the new order. No-op at the respective edge.
 */
export function moveColumn(
  layer: GeoLibreLayer,
  discovered: string[],
  key: string,
  direction: ColumnMoveDirection,
): Partial<GeoLibreLayer> | null {
  const settings = getColumnSettings(layer);
  const full = orderColumns(discovered, settings);
  const hidden = new Set(settings.hidden ?? []);
  const visible = full.filter((entry) => !hidden.has(entry));
  const visibleIndex = visible.indexOf(key);
  if (visibleIndex < 0) return null;
  const neighbor =
    direction === "left"
      ? visible[visibleIndex - 1]
      : visible[visibleIndex + 1];
  if (neighbor === undefined) return null;

  const next = [...full];
  const from = next.indexOf(key);
  const to = next.indexOf(neighbor);
  [next[from], next[to]] = [next[to], next[from]];
  return {
    metadata: metadataWithSettings(layer, { ...settings, order: next }),
  };
}
