import { isDuckDBQueryLayer, SQL_QUERY_SOURCE_KIND, type GeoLibreLayer } from "@geolibre/core";
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
 * Whether a layer's geometry can be edited in place. Only geojson-mode vector
 * layers qualify ("vector-tiles" / DuckDB-tiles layers do not). DuckDB query
 * layers are excluded and must be materialized to an editable GeoJSON copy
 * first. Add-Vector-Layer geojson-mode layers ARE included: their features live
 * in a MapLibre GeoJSON source and are read back (via the caller's
 * `ensureLayerGeojsonFromSource`) before editing begins.
 *
 * @param layer The candidate layer, or undefined.
 * @returns True when the layer's geometry can be edited in place.
 */
export function canEditLayerGeometry(layer: GeoLibreLayer | undefined): boolean {
  if (!layer) return false;
  // Only geojson-mode vector layers; "vector-tiles" (DuckDB tiles) are excluded.
  if (layer.type !== "geojson") return false;
  if (isDuckDBQueryLayer(layer)) return false;
  if (layer.metadata.sourceKind === SKETCHES_SOURCE_KIND) return false;
  // A query result is derived, not writable: refresh re-runs the stored SQL
  // and would overwrite any in-place edits. Load a copy into the editor (or
  // export) to edit the features.
  if (layer.metadata.sourceKind === SQL_QUERY_SOURCE_KIND) return false;

  if (layer.metadata.externalNativeLayer === true) {
    // Externally-rendered layers are only editable when they are Add-Vector-Layer
    // geojson-mode layers, whose features live in a MapLibre GeoJSON source that
    // can be read and written back. Require a usable source id (a non-empty
    // string), otherwise there is nothing to hydrate from or write back to.
    const sourceIds = layer.metadata.sourceIds;
    return (
      layer.metadata.sourceKind === "maplibre-gl-vector" &&
      Array.isArray(sourceIds) &&
      typeof sourceIds[0] === "string" &&
      sourceIds[0].length > 0
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
export function tagFeatureKeys(collection: FeatureCollection): FeatureCollection {
  const ids = makeIdAllocator();
  let warnedCollision = false;
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => {
      // Warn once if real data already uses the reserved tag key: that value is
      // overwritten for the session and stripped on save, so the user would
      // otherwise silently lose it.
      if (
        !warnedCollision &&
        feature.properties != null &&
        GEOMETRY_EDIT_FID_PROPERTY in feature.properties
      ) {
        warnedCollision = true;
        console.warn(
          `Geometry edit: features already contain a "${GEOMETRY_EDIT_FID_PROPERTY}" ` +
            "property; it will be overwritten for the edit session and removed on save.",
        );
      }
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
export function reconcileEditedFeatures(collection: FeatureCollection): FeatureCollection {
  const ids = makeIdAllocator();
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => {
      const rawProps = feature.properties;
      const tag = rawProps?.[GEOMETRY_EDIT_FID_PROPERTY];
      // Preserve null properties as null (GeoJSON allows it, and a feature drawn
      // during the session may have null); only strip the tag from real objects.
      let properties: Record<string, unknown> | null;
      if (rawProps == null) {
        properties = null;
      } else {
        properties = { ...rawProps };
        delete properties[GEOMETRY_EDIT_FID_PROPERTY];
      }
      const id = ids.take(tag);
      return { ...feature, id, properties };
    }),
  };
}

/** A map style layer described by what role it plays for overlay ordering. */
export interface OverlayOrderLayer {
  /** The MapLibre style layer id. */
  id: string;
  /** True for the GeoEditor overlay (Geoman `gm_*` and `geo-editor-*`) layers. */
  isOverlay: boolean;
  /** True for the edited layer's own (anchor) map layers. */
  isAnchor: boolean;
}

/** The move the caller should apply to keep the overlay above the edited layer. */
export interface OverlayOrderPlan {
  /** The ids of the overlay layers, in their current bottom-to-top order. */
  overlayIds: string[];
  /**
   * The MapLibre `beforeId` to pass to `moveLayer` for each overlay layer: the
   * first non-overlay layer above the edited layer, or `undefined` to move the
   * overlay to the very top (nothing but overlay sits above the edited layer).
   */
  beforeId: string | undefined;
}

/**
 * Decide how to reposition the GeoEditor overlay so it renders at the edited
 * layer's slot in the stack. `MapController.syncLayers` reorders the map's
 * layers on every layers change and has no knowledge of the overlay, so without
 * this the overlay drifts below any layer stacked above the edited one and the
 * edit features disappear behind it (issue #1015).
 *
 * Returns `null` when nothing should move: the edited layer is not on the map
 * (no anchor), there are no overlay layers, or the overlay already sits in one
 * contiguous run directly above the anchor (so re-applying would needlessly
 * churn the style and re-fire `styledata`).
 *
 * @param layers The map's style layers, bottom-to-top, tagged with their roles.
 * @returns The reposition plan, or `null` when no move is needed.
 */
export function planGeoEditorOverlayOrder(layers: OverlayOrderLayer[]): OverlayOrderPlan | null {
  let lastAnchorIndex = -1;
  for (let i = 0; i < layers.length; i += 1) {
    if (layers[i].isAnchor) lastAnchorIndex = i;
  }
  // Without the edited layer on the map there is no anchor; leave the overlay
  // where Geoman placed it (on top) rather than guessing a position.
  if (lastAnchorIndex < 0) return null;

  const overlayIds = layers.filter((layer) => layer.isOverlay).map((layer) => layer.id);
  if (overlayIds.length === 0) return null;

  if (overlayLayersAlreadyPositioned(layers, overlayIds.length, lastAnchorIndex)) {
    return null;
  }

  // Anchor the overlay just below the first non-overlay layer above the edited
  // layer (or on top of the map when nothing sits above it).
  let beforeId: string | undefined;
  for (let i = lastAnchorIndex + 1; i < layers.length; i += 1) {
    if (!layers[i].isOverlay) {
      beforeId = layers[i].id;
      break;
    }
  }

  return { overlayIds, beforeId };
}

/**
 * Whether the overlay layers already sit in one contiguous run directly above
 * the edited layer's anchor layers, so no reposition is needed.
 */
function overlayLayersAlreadyPositioned(
  layers: OverlayOrderLayer[],
  overlayCount: number,
  lastAnchorIndex: number,
): boolean {
  const start = lastAnchorIndex + 1;
  if (start + overlayCount > layers.length) return false;
  for (let i = 0; i < overlayCount; i += 1) {
    if (!layers[start + i].isOverlay) return false;
  }
  const after = layers[start + overlayCount];
  return !(after && after.isOverlay);
}
