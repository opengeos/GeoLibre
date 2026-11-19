import type { Feature, FeatureCollection } from "geojson";

export interface SketchAttributeUpdate {
  id: string | number;
  properties: Record<string, unknown>;
}

function identity(feature: Feature): string | number | undefined {
  const id = feature.id ?? feature.properties?.__gm_id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

function shapeProperties(feature: Feature): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(feature.properties ?? {}).filter(([key]) => key.startsWith("__gm_")),
  );
}

function customProperties(feature: Feature): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(feature.properties ?? {}).filter(([key]) => !key.startsWith("__gm_")),
  );
}

/** Compare JSON records without depending on object key order; array order and numbers remain exact. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]))
  );
}

/** Return property-only updates, or null if replacing geometry/identities requires a full import. */
export function planSketchAttributeUpdates(
  editor: FeatureCollection,
  stored: FeatureCollection,
): SketchAttributeUpdate[] | null {
  if (editor.features.length !== stored.features.length) return null;
  const current = new Map<string, Feature>();
  for (const feature of editor.features) {
    const id = identity(feature);
    if (id === undefined || current.has(String(id))) return null;
    current.set(String(id), feature);
  }
  const updates: SketchAttributeUpdate[] = [];
  for (const feature of stored.features) {
    const id = identity(feature);
    if (id === undefined) return null;
    const previous = current.get(String(id));
    if (
      !previous ||
      !jsonEqual(previous.geometry, feature.geometry) ||
      !jsonEqual(shapeProperties(previous), shapeProperties(feature))
    )
      return null;
    current.delete(String(id));
    const properties = customProperties(feature);
    if (!jsonEqual(customProperties(previous), properties)) {
      // Geoman preserves its own shape parameters. Keep other bookkeeping
      // (including the view-import tag) along with user attributes.
      const engineId = previous.properties?.__gm_id;
      updates.push({
        id: typeof engineId === "string" || typeof engineId === "number" ? engineId : id,
        properties,
      });
    }
  }
  return updates;
}

/** Preserve untouched blank/missing values and decode the form's nullable booleans. */
export function normalizeEditorFormProperties(
  fields: ReadonlyArray<{ name: string; type: string }>,
  previous: Record<string, unknown> | null,
  submitted: Record<string, unknown> | null,
): Record<string, unknown> {
  const normalized = { ...submitted };
  for (const field of fields) {
    const value = normalized[field.name];
    if (value === null) {
      if (!Object.hasOwn(previous ?? {}, field.name)) delete normalized[field.name];
      else if (previous?.[field.name] === "") normalized[field.name] = "";
    } else if (field.type === "select" && (value === "true" || value === "false")) {
      normalized[field.name] = value === "true";
    }
  }
  return normalized;
}
