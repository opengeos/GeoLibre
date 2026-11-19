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
      JSON.stringify(previous.geometry) !== JSON.stringify(feature.geometry) ||
      JSON.stringify(shapeProperties(previous)) !== JSON.stringify(shapeProperties(feature))
    )
      return null;
    current.delete(String(id));
    const properties = customProperties(feature);
    if (JSON.stringify(customProperties(previous)) !== JSON.stringify(properties)) {
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
