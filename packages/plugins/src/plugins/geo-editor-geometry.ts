import { isDuckDBQueryLayer, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/**
 * Pure helpers for in-place geometry editing of vector layers. Kept free of the
 * Geoman/MapLibre runtime imports in `maplibre-geo-editor.ts` so they can be
 * unit-tested under Node without a browser environment.
 */

/** Metadata `sourceKind` marking the GeoEditor's own "Sketches" layer. */
export const SKETCHES_SOURCE_KIND = "geoeditor-sketches";

/**
 * Transient feature-key tag written into a feature's `properties` while it is
 * loaded in the editor. Geoman reassigns `feature.id` on load, so the original
 * id is preserved here and restored on write-back, then stripped so it never
 * reaches a saved project or the attribute table.
 *
 * The name is deliberately `__`-prefixed and namespaced to avoid colliding with
 * real user attributes. A feature that already carries a property with this
 * exact name would have it overwritten for the session and stripped on save, so
 * this name must stay unusual enough that real data never uses it.
 */
export const GEOMETRY_EDIT_FID_PROPERTY = "__geolibre_fid";

/**
 * Whether a layer's geometry can be edited in place. Mirrors the exclusions the
 * attribute table already applies so the two rules cannot drift: only in-memory
 * geojson vector layers qualify. DuckDB query layers and Add-Vector-Layer
 * control layers keep their features outside `layer.geojson`, so they are
 * excluded (DuckDB layers are materialized to an editable copy first).
 *
 * @param layer The candidate layer, or undefined.
 * @returns True when the layer's geometry can be edited in place.
 */
export function canEditLayerGeometry(
  layer: GeoLibreLayer | undefined,
): boolean {
  if (!layer) return false;
  if (layer.type !== "geojson") return false;
  if (isDuckDBQueryLayer(layer)) return false;
  if (layer.metadata.sourceKind === SKETCHES_SOURCE_KIND) return false;
  if (layer.metadata.sourceKind === "maplibre-gl-vector") return false;
  if (layer.metadata.externalNativeLayer === true) return false;
  return Array.isArray(layer.geojson?.features);
}

/**
 * Tag each feature with its stable original id in `properties` before loading
 * into the editor. Geoman preserves `properties` through geometry operations but
 * reassigns `feature.id`, so this tag is how identity survives the round-trip.
 *
 * @param collection The layer's feature collection.
 * @returns A new collection with each feature carrying a feature-key tag.
 */
export function tagFeatureKeys(
  collection: FeatureCollection,
): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature, index) => ({
      ...feature,
      properties: {
        ...(feature.properties ?? {}),
        [GEOMETRY_EDIT_FID_PROPERTY]: String(feature.id ?? index),
      },
    })),
  };
}

/**
 * Restore stable feature ids from the load-time tag and strip it, so the store
 * layer stays tag-free. Features without a tag are new (drawn during the
 * session) and receive a fresh id that does not collide with a tagged one.
 *
 * @param collection The editor's current feature collection (tagged).
 * @returns A new collection with stable ids and the tag removed.
 */
export function reconcileEditedFeatures(
  collection: FeatureCollection,
): FeatureCollection {
  const usedIds = new Set<string>();
  for (const feature of collection.features) {
    const tag = (feature.properties as Record<string, unknown> | null)?.[
      GEOMETRY_EDIT_FID_PROPERTY
    ];
    if (tag != null) usedIds.add(String(tag));
  }

  let nextId = 0;
  const allocateId = (): string => {
    while (usedIds.has(String(nextId))) nextId += 1;
    const id = String(nextId);
    usedIds.add(id);
    return id;
  };

  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => {
      const properties = {
        ...(feature.properties ?? {}),
      } as Record<string, unknown>;
      const tag = properties[GEOMETRY_EDIT_FID_PROPERTY];
      delete properties[GEOMETRY_EDIT_FID_PROPERTY];
      const id = tag != null ? String(tag) : allocateId();
      return { ...feature, id, properties };
    }),
  };
}
