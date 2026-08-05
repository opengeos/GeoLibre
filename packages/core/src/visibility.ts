import type { FeatureCollection } from "geojson";
import type { GeoLibreProject, FieldVisibility } from "./types";

/**
 * Returns a new FeatureCollection with properties marked as "excluded" removed.
 */
export function excludeHiddenFieldsFromGeojson(
  geojson: FeatureCollection,
  fieldVisibility?: Record<string, FieldVisibility>,
): FeatureCollection {
  const excludedKeys = new Set(
    Object.entries(fieldVisibility || {})
      .filter(([_, visibility]) => visibility === "excluded")
      .map(([key]) => key),
  );

  if (excludedKeys.size === 0) {
    return geojson;
  }

  // Deep clone to avoid mutating the live store state
  const stripped: FeatureCollection = {
    ...geojson,
    features: geojson.features.map((feature) => {
      const properties = { ...feature.properties };
      for (const key of excludedKeys) {
        delete properties[key];
      }
      return { ...feature, properties };
    }),
  };

  return stripped;
}

/**
 * Returns a new GeoLibreProject where all layers have their excluded fields
 * physically removed from their inline GeoJSON.
 */
export function excludeHiddenFieldsFromProject(project: GeoLibreProject): GeoLibreProject {
  let changed = false;
  const layers = project.layers.map((layer) => {
    if (!layer.fieldVisibility) return layer;

    let updatedLayer = layer;

    if (layer.geojson) {
      const strippedGeojson = excludeHiddenFieldsFromGeojson(layer.geojson, layer.fieldVisibility);
      if (strippedGeojson !== layer.geojson) {
        changed = true;
        updatedLayer = { ...updatedLayer, geojson: strippedGeojson };
      }
    }

    if (layer.metadata?.embeddedGeoJSON) {
      const strippedEmbedded = excludeHiddenFieldsFromGeojson(
        layer.metadata.embeddedGeoJSON as FeatureCollection,
        layer.fieldVisibility,
      );
      if (strippedEmbedded !== layer.metadata.embeddedGeoJSON) {
        changed = true;
        updatedLayer = {
          ...updatedLayer,
          metadata: {
            ...updatedLayer.metadata,
            embeddedGeoJSON: strippedEmbedded,
          },
        };
      }
    }

    return updatedLayer;
  });

  return changed ? { ...project, layers } : project;
}
