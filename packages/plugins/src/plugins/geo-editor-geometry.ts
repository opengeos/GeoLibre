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
  // Only geojson-mode vector layers; "vector-tiles" (DuckDB tiles) are excluded.
  if (layer.type !== "geojson") return false;
  if (isDuckDBQueryLayer(layer)) return false;
  if (layer.metadata.sourceKind === SKETCHES_SOURCE_KIND) return false;

  if (layer.metadata.externalNativeLayer === true) {
    // Externally-rendered layers are only editable when they are Add-Vector-Layer
    // geojson-mode layers, whose features live in a MapLibre GeoJSON source that
    // can be read and written back. Other external layers are not editable.
    return (
      layer.metadata.sourceKind === "maplibre-gl-vector" &&
      Array.isArray(layer.metadata.sourceIds)
    );
  }

  // Plain in-memory geojson layers carry their features in `layer.geojson`.
  return Array.isArray(layer.geojson?.features);
}

/** Allocator that hands out unique string ids, skipping ones already taken. */
function makeIdAllocator(): { take: (preferred?: unknown) => string } {
  const used = new Set<string>();
  let next = 0;
  return {
    take(preferred?: unknown): string {
      // Reuse the preferred id only if it is a non-empty, not-yet-taken value;
      // otherwise allocate a fresh integer id that does not collide.
      if (preferred != null && preferred !== "" && !used.has(String(preferred))) {
        const id = String(preferred);
        used.add(id);
        return id;
      }
      while (used.has(String(next))) next += 1;
      const id = String(next);
      used.add(id);
      return id;
    },
  };
}

/**
 * Tag each feature with a stable, UNIQUE id in both `feature.id` and a
 * `properties` key before loading into the editor. Geoman keys its feature store
 * by `feature.id`, so duplicate ids would make features overwrite each other on
 * import (some would silently disappear or become non-editable). The id is also
 * mirrored into `properties` because Geoman reassigns `feature.id` during edits
 * but preserves `properties`, so the tag is how identity survives the round-trip.
 *
 * @param collection The layer's feature collection.
 * @returns A new collection with unique ids and a feature-key tag per feature.
 */
export function tagFeatureKeys(
  collection: FeatureCollection,
): FeatureCollection {
  const ids = makeIdAllocator();
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => {
      const id = ids.take(feature.id);
      return {
        ...feature,
        id,
        properties: {
          ...(feature.properties ?? {}),
          [GEOMETRY_EDIT_FID_PROPERTY]: id,
        },
      };
    }),
  };
}

/**
 * Restore stable feature ids from the load-time tag and strip it, so the store
 * layer stays tag-free. Ids are guaranteed unique: a duplicated tag (e.g. from a
 * Geoman copy/split that cloned `properties`) and untagged new features each get
 * a fresh id that does not collide.
 *
 * @param collection The editor's current feature collection (tagged).
 * @returns A new collection with unique stable ids and the tag removed.
 */
export function reconcileEditedFeatures(
  collection: FeatureCollection,
): FeatureCollection {
  const ids = makeIdAllocator();
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => {
      const properties = {
        ...(feature.properties ?? {}),
      } as Record<string, unknown>;
      const tag = properties[GEOMETRY_EDIT_FID_PROPERTY];
      delete properties[GEOMETRY_EDIT_FID_PROPERTY];
      const id = ids.take(tag);
      return { ...feature, id, properties };
    }),
  };
}
