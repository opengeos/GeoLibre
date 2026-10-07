import {
  editorTrackingFieldNames,
  isDuckDBQueryLayer,
  SQL_QUERY_SOURCE_KIND,
  stampFeaturePropertiesEditorTracking,
  type EditorTrackingConfig,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry, MultiLineString, Position } from "geojson";

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
  if (layer.capabilities?.update === false) return false;
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
  // Explicit ids are claimed first, so an id-less feature's index fallback can
  // never take an id a later feature really carries (#2932).
  const explicitIds = collection.features.map((feature) =>
    feature.id != null && feature.id !== "" ? ids.take(feature.id) : null,
  );
  let warnedCollision = false;
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature, index) => {
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
      // A feature without an id falls back to its array index, the same id the
      // attribute table and Identify give it, so an Identify result can find
      // its feature in the editor (#2932). The allocator still keeps it unique.
      // Known limitation: when that index is another feature's explicit id,
      // the app-wide `feature.id ?? index` scheme already gives both features
      // the same id, so this one gets a fresh tag and an id-based lookup
      // (findGeometryEditFeature) resolves to the explicit-id feature.
      const id = explicitIds[index] ?? ids.take(index);
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
 * Find a feature in the editor's collection by the id the attribute table and
 * Identify gave it, through the session's feature-key tag (#2932).
 *
 * @param collection The editor's current (tagged) features.
 * @param featureId The feature's id in the attribute table's scheme.
 * @returns The matching feature, or undefined when none carries that tag.
 */
export function findGeometryEditFeature(
  collection: FeatureCollection,
  featureId: string,
): Feature | undefined {
  return collection.features.find(
    (feature) => feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY] === featureId,
  );
}

/** Prefix Geoman namespaces its own feature properties with. */
const GEOMAN_PROPERTY_PREFIX = "__gm_";

/**
 * The property names Geoman claims as its own "shape properties".
 *
 * On import it reads each of these from a feature's plain, unprefixed
 * attributes, and on export it deletes **both** the plain and the prefixed form
 * from the feature's own properties and re-emits its value as `__gm_<name>`
 * (`parseGmShapeProperties` / `parseExtraProperties` in
 * `@geoman-io/maplibre-geoman-free`). A data layer with a column called
 * `height` or `id` therefore comes back from an edit session with that column
 * renamed to `__gm_height` / `__gm_id` — silent attribute corruption, and these
 * are ordinary GIS column names (building heights, source ids).
 *
 * Mirrored from the library's `Th` validator map, which is internal and not
 * exported. If Geoman adds a shape property, a column of that name starts
 * getting renamed again; `tests/geo-editor-geometry.test.ts` pins the round-trip
 * behavior this list exists to defend.
 */
export const GEOMAN_SHAPE_PROPERTIES: ReadonlySet<string> = new Set([
  "id",
  "shape",
  "center",
  "width",
  "height",
  "xSemiAxis",
  "ySemiAxis",
  "angle",
  "text",
  "disableEdit",
  "group",
]);

/** Each edited feature's attributes as they were loaded, keyed by feature tag. */
export type EditedFeatureProperties = ReadonlyMap<string, Record<string, unknown> | null>;

/**
 * Snapshot the attributes of a tagged collection on its way into the editor.
 *
 * A geometry-edit session changes geometry only — attributes are edited in the
 * attribute table, not here — so the values captured here are what the features
 * must still have on the way out, whatever Geoman did to them in between.
 *
 * `source` is the collection as it was **before** tagging, read positionally:
 * {@link tagFeatureKeys} maps one input feature to one output feature in order.
 * Without it a feature whose `properties` were `null` would be snapshotted as
 * `{}` (tagging has to put the tag somewhere), and a geometry-only save would
 * quietly rewrite valid GeoJSON `null` into an empty object.
 *
 * @param collection The collection from {@link tagFeatureKeys}.
 * @param source The same collection before tagging, for exact attributes.
 * @returns Attributes (tag removed) keyed by feature tag.
 */
export function captureEditedProperties(
  collection: FeatureCollection,
  source?: FeatureCollection,
): Map<string, Record<string, unknown> | null> {
  const snapshot = new Map<string, Record<string, unknown> | null>();
  collection.features.forEach((feature, index) => {
    const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
    if (tag == null) return;
    const original = source?.features[index];
    if (original) {
      const props = original.properties;
      snapshot.set(String(tag), props == null ? null : { ...props });
      return;
    }
    const rawProps = feature.properties;
    if (rawProps == null) {
      snapshot.set(String(tag), null);
      return;
    }
    const properties = { ...rawProps };
    delete properties[GEOMETRY_EDIT_FID_PROPERTY];
    snapshot.set(String(tag), properties);
  });
  return snapshot;
}

/** Each loaded feature's original `feature.id` value (type intact), keyed by feature tag. */
export type EditedFeatureIds = ReadonlyMap<string, string | number>;

/**
 * Remember the original `feature.id` of each feature loaded into the editor.
 *
 * {@link tagFeatureKeys} hands Geoman string ids, so without this a session
 * would turn a numeric id such as an ArcGIS object ID (`1`) into `"1"` on save,
 * and anything that matches features by id against a pre-session copy (the
 * ArcGIS edit baseline) would see every feature as changed.
 *
 * @param collection The collection from {@link tagFeatureKeys}.
 * @param source The same collection before tagging, read positionally.
 * @returns Original ids keyed by feature tag; features without an id are omitted.
 */
export function captureEditedFeatureIds(
  collection: FeatureCollection,
  source: FeatureCollection,
): Map<string, string | number> {
  const ids = new Map<string, string | number>();
  collection.features.forEach((feature, index) => {
    const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
    const id = source.features[index]?.id;
    if (tag != null && id != null && id !== "") ids.set(String(tag), id);
  });
  return ids;
}

/**
 * Decimal places coordinates are compared at when deciding whether a feature's
 * geometry actually changed during an edit session (~0.1 mm at the equator).
 *
 * Geoman re-serializes every feature it loaded, whether or not it was touched,
 * so an exact comparison would call a last-bit float difference an edit and
 * stamp `edited_by`/`edited_at` on the whole layer each time someone opened a
 * session and saved. The rounding trades an unobservable geometry change for
 * never reporting an edit that did not happen.
 */
const GEOMETRY_COMPARE_PRECISION = 9;

/** Round every number in a (possibly deeply nested) coordinate array. */
function roundCoordinates(value: unknown): unknown {
  if (typeof value === "number") return Number(value.toFixed(GEOMETRY_COMPARE_PRECISION));
  if (Array.isArray(value)) return value.map(roundCoordinates);
  return value;
}

/**
 * A comparable string for a geometry, stable across the editor's round-trip.
 *
 * @param geometry The feature's geometry, or null/undefined for a null-geometry feature.
 * @returns A canonical key; equal keys mean equal geometry at
 *   {@link GEOMETRY_COMPARE_PRECISION}.
 */
export function canonicalGeometryKey(geometry: Geometry | null | undefined): string {
  if (!geometry) return "null";
  if (geometry.type === "GeometryCollection") {
    return JSON.stringify({
      type: geometry.type,
      geometries: geometry.geometries.map((part) => canonicalGeometryKey(part)),
    });
  }
  return JSON.stringify({
    type: geometry.type,
    coordinates: roundCoordinates(geometry.coordinates),
  });
}

/**
 * Snapshot each loaded feature's geometry, keyed by the same feature tag
 * {@link captureEditedProperties} uses.
 *
 * Editor tracking needs to stamp the features a session actually changed, not
 * every feature it loaded, and the editor reports no per-feature dirty flag —
 * so the baseline is captured on the way in and compared on the way out.
 *
 * @param collection The collection from {@link tagFeatureKeys}.
 * @returns Canonical geometry keys by feature tag.
 */
export function captureEditedGeometries(collection: FeatureCollection): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const feature of collection.features) {
    const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
    if (tag == null) continue;
    snapshot.set(String(tag), canonicalGeometryKey(feature.geometry));
  }
  return snapshot;
}

/**
 * What {@link reconcileEditedFeatures} needs to stamp editor tracking on the
 * features a geometry-edit session created or moved.
 */
export interface GeometryEditTrackingOptions {
  /** The target layer's editor tracking configuration. */
  config: EditorTrackingConfig;
  /** Identity to record as the author/editor. */
  userIdentity?: string;
  /** ISO timestamp; defaults to now. Shared by every feature in one save. */
  timestamp?: string;
  /** Geometry baseline from {@link captureEditedGeometries}. */
  originalGeometries: ReadonlyMap<string, string>;
}

/**
 * How a feature that was not loaded into the session came to exist: drawn from
 * scratch, or copied from a loaded feature (Geoman's copy and split clone the
 * source's attributes, edit tag included).
 */
export type NewEditedFeatureKind = "drawn" | "copied";

/** Optional inputs to {@link reconcileEditedFeatures}. */
export interface ReconcileEditedFeaturesOptions {
  /** Original ids from {@link captureEditedFeatureIds}, restored on loaded features. */
  originalIds?: EditedFeatureIds;
  /**
   * Geometry baseline from {@link captureEditedGeometries}. When a tag appears
   * more than once (a copy or split), the occurrence whose geometry still
   * matches keeps the loaded feature's identity; without a match, the first does.
   */
  originalGeometries?: ReadonlyMap<string, string>;
  /**
   * Adjust the attributes of a feature the session created. Called after the
   * editor keys are stripped and before editor tracking is stamped, so a data
   * source can drop values that must not be duplicated (an ArcGIS object ID)
   * or fill creation defaults.
   */
  prepareNewFeature?: (
    properties: Record<string, unknown> | null,
    kind: NewEditedFeatureKind,
  ) => Record<string, unknown> | null;
}

/**
 * For each tag carried by more than one feature, the index of the feature that
 * keeps the loaded identity: the one whose geometry is unchanged (the original
 * a copy was made from), otherwise the first.
 */
function identityHolders(
  features: readonly Feature[],
  originalGeometries?: ReadonlyMap<string, string>,
): Map<string, number> {
  const byTag = new Map<string, number[]>();
  features.forEach((feature, index) => {
    const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
    if (tag == null) return;
    const list = byTag.get(String(tag));
    if (list) list.push(index);
    else byTag.set(String(tag), [index]);
  });
  const holders = new Map<string, number>();
  for (const [tag, indices] of byTag) {
    const baseline = originalGeometries?.get(tag);
    const unchanged =
      indices.length > 1 && baseline !== undefined
        ? indices.find((index) => canonicalGeometryKey(features[index].geometry) === baseline)
        : undefined;
    holders.set(tag, unchanged ?? indices[0]);
  }
  return holders;
}

/** A copy of `properties` without Geoman's namespaced keys or the edit tag. */
function withoutEditorProperties(rawProps: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawProps)) {
    if (key === GEOMETRY_EDIT_FID_PROPERTY) continue;
    if (key.startsWith(GEOMAN_PROPERTY_PREFIX)) continue;
    properties[key] = value;
  }
  return properties;
}

/**
 * Restore stable feature ids from the load-time tag and strip it, so the store
 * layer stays tag-free. Ids are guaranteed unique: a duplicated tag (e.g. from a
 * Geoman copy/split that cloned `properties`) and untagged new features each get
 * a fresh id that does not collide.
 *
 * Attributes are restored from `originalProperties` when the feature was one of
 * the loaded ones, because Geoman rewrites any column whose name it reserves
 * (see {@link GEOMAN_SHAPE_PROPERTIES}) and the session was never allowed to
 * change attributes anyway. A feature drawn during the session has no snapshot,
 * so it keeps what it has minus the editor's own `__gm_*` bookkeeping, which
 * would otherwise show up as columns in the layer's attribute table.
 *
 * A tag carried by several features means Geoman copied or split a loaded
 * feature. Only one occurrence keeps the loaded identity (see
 * `options.originalGeometries`); the others are new features that start from
 * the source's attributes.
 *
 * When `tracking` is supplied, the features the session actually changed are
 * stamped with editor tracking metadata: a feature with no snapshot, or a copy,
 * was created during the session ("create"), and one whose geometry differs
 * from the baseline was moved ("update"). Features that were merely loaded and
 * saved again are left exactly as they were, so opening a session and closing
 * it without touching anything does not rewrite the layer's edit history.
 *
 * @param collection The editor's current feature collection (tagged).
 * @param originalProperties Snapshot from {@link captureEditedProperties}.
 * @param tracking Editor tracking config and geometry baseline, when enabled.
 * @param options Original ids, geometry baseline and a hook for new features.
 * @returns A new collection with unique stable ids and editor keys removed.
 */
export function reconcileEditedFeatures(
  collection: FeatureCollection,
  originalProperties?: EditedFeatureProperties,
  tracking?: GeometryEditTrackingOptions,
  options: ReconcileEditedFeaturesOptions = {},
): FeatureCollection {
  const ids = makeIdAllocator();
  // One timestamp for the whole save, so features changed in a single session
  // share an `edited_at` instead of differing by however long the map took.
  const timestamp = tracking?.timestamp ?? new Date().toISOString();
  const holders = identityHolders(
    collection.features,
    options.originalGeometries ?? tracking?.originalGeometries,
  );
  const isHolder = (feature: Feature, index: number) => {
    const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
    return tag != null && holders.get(String(tag)) === index;
  };
  // Identity holders claim their ids first, so a copy or a drawn feature that
  // comes earlier in the editor's order can never take an id a loaded feature
  // keeps.
  const assigned: Array<string | number> = new Array(collection.features.length);
  for (const pass of [true, false]) {
    collection.features.forEach((feature, index) => {
      if (isHolder(feature, index) !== pass) return;
      const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
      const taken = ids.take(pass ? tag : undefined);
      // The holder gets its original id back with its type intact; copies and
      // drawn features get fresh string ids.
      const original = pass ? options.originalIds?.get(String(tag)) : undefined;
      assigned[index] = original !== undefined && String(original) === taken ? original : taken;
    });
  }
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature, index) => {
      const rawProps = feature.properties;
      const tag = rawProps?.[GEOMETRY_EDIT_FID_PROPERTY];
      // Preserve null properties as null (GeoJSON allows it, and a feature drawn
      // during the session may have null).
      let properties: Record<string, unknown> | null;
      const restored = tag == null ? undefined : originalProperties?.get(String(tag));
      const copied = restored !== undefined && holders.get(String(tag)) !== index;
      if (restored !== undefined) {
        properties = restored === null ? null : { ...restored };
      } else if (rawProps == null) {
        properties = null;
      } else {
        properties = withoutEditorProperties(rawProps);
      }
      if (options.prepareNewFeature && (restored === undefined || copied)) {
        properties = options.prepareNewFeature(properties, copied ? "copied" : "drawn");
      }
      if (tracking) {
        const action = editTrackingAction(
          tag == null ? undefined : String(tag),
          restored !== undefined && !copied,
          feature.geometry,
          tracking.originalGeometries,
        );
        // A feature copied from a tracked one arrives carrying the original's
        // creation stamp — the session loads the layer's features with their
        // tracking columns. `"create"` is authoritative for exactly this reason,
        // so the copy is recorded as created here rather than inheriting it.
        if (action) {
          properties = stampFeaturePropertiesEditorTracking(properties, action, {
            config: tracking.config,
            userIdentity: tracking.userIdentity,
            timestamp,
          });
        }
      }
      return { ...feature, id: assigned[index], properties };
    }),
  };
}

/**
 * Classify one reconciled feature for editor tracking, or `null` when the
 * session left it untouched and it must not be stamped.
 */
function editTrackingAction(
  tag: string | undefined,
  wasLoaded: boolean,
  geometry: Geometry | null,
  originalGeometries: ReadonlyMap<string, string>,
): "create" | "update" | null {
  if (!wasLoaded) return "create";
  // A loaded feature always has a tag (that is what `wasLoaded` was decided
  // from), so a missing baseline means the geometry snapshot and the property
  // snapshot disagree. Treat that as changed rather than silently skipping: a
  // spurious `edited_at` is recoverable, a missed one is not.
  const baseline = tag === undefined ? undefined : originalGeometries.get(tag);
  if (baseline === undefined) return "update";
  return canonicalGeometryKey(geometry) === baseline ? null : "update";
}

/**
 * Apply editor tracking to a collection the editor is pushing over a store
 * layer wholesale, using the store's previous collection as the baseline.
 *
 * The Sketches sync differs from a geometry-edit save in two ways that this has
 * to handle. It runs after every draw/drag rather than once at the end, so
 * unchanged features must keep the timestamps they already have; and it is
 * one-way — the editor holds its own copy of the features and never sees the
 * tracking columns written to the store — so those values have to be carried
 * forward explicitly or each sync would wipe them and re-stamp from scratch.
 *
 * @param next The editor's current collection, about to replace the store's.
 * @param previous The store layer's collection before this sync.
 * @param keyOf Feature identity across the two collections.
 * @param tracking The layer's tracking config plus the identity to stamp.
 * @returns `next` with tracking columns carried forward and changed features stamped.
 */
export function applySyncedEditorTracking(
  next: FeatureCollection,
  previous: FeatureCollection | null | undefined,
  keyOf: (feature: Feature, index: number) => string,
  tracking: { config: EditorTrackingConfig; userIdentity?: string; timestamp?: string },
): FeatureCollection {
  const fields = editorTrackingFieldNames(tracking.config);
  if (!fields) return next;

  // `keyOf` must not read the tracking columns: they only ever exist on the
  // store side, so a key derived from them would give one feature two different
  // identities once it had been stamped, and every later sync would read it as
  // brand new and reset its creation stamp to "now". `sketchFeatureKey` satisfies
  // this — its no-id fallback hashes the geometry rather than the whole feature.
  const previousByKey = new Map<string, Feature>();
  previous?.features.forEach((feature, index) => {
    previousByKey.set(keyOf(feature, index), feature);
  });

  const timestamp = tracking.timestamp ?? new Date().toISOString();
  const stampOptions = {
    config: tracking.config,
    userIdentity: tracking.userIdentity,
    timestamp,
  };

  return {
    ...next,
    features: next.features.map((feature, index) => {
      const prior = previousByKey.get(keyOf(feature, index));
      if (!prior) {
        return {
          ...feature,
          properties: stampFeaturePropertiesEditorTracking(
            feature.properties,
            "create",
            stampOptions,
          ),
        };
      }

      const carried = carryForwardTrackingFields(feature.properties, prior.properties, fields);
      if (canonicalGeometryKey(feature.geometry) === canonicalGeometryKey(prior.geometry)) {
        // Untouched: keep whatever it was already stamped with.
        return carried === feature.properties ? feature : { ...feature, properties: carried };
      }
      return {
        ...feature,
        properties: stampFeaturePropertiesEditorTracking(carried, "update", stampOptions),
      };
    }),
  };
}

/**
 * Copy the tracking columns the store already recorded onto the editor's copy
 * of a feature. Returns the input untouched when there is nothing to carry, so
 * a collection with no stamps yet is not needlessly rewritten.
 */
function carryForwardTrackingFields(
  properties: Record<string, unknown> | null,
  prior: Record<string, unknown> | null,
  fields: readonly string[],
): Record<string, unknown> | null {
  if (!prior) return properties;
  const present = fields.filter((field) => prior[field] !== undefined);
  if (present.length === 0) return properties;
  const result: Record<string, unknown> = { ...(properties ?? {}) };
  for (const field of present) result[field] = prior[field];
  return result;
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

/**
 * Mark committed geometry edits by comparing the editor's load-time feature
 * tags before reconciliation strips them or allocates ids for new features.
 */
export function geometryEditMetadata(
  layer: GeoLibreLayer,
  tagged: FeatureCollection,
  originalGeometries: ReadonlyMap<string, string>,
): GeoLibreLayer["metadata"] {
  const seen = new Set<string>();
  const changed =
    originalGeometries.size !== tagged.features.length ||
    tagged.features.some((feature) => {
      const tag = feature.properties?.[GEOMETRY_EDIT_FID_PROPERTY];
      if (tag == null || seen.has(String(tag))) return true;
      seen.add(String(tag));
      return canonicalGeometryKey(feature.geometry) !== originalGeometries.get(String(tag));
    });
  return changed ? { ...layer.metadata, geometryEdited: true } : layer.metadata;
}

/**
 * Removes one vertex from a MultiLineString, which Geoman's own right-click
 * vertex removal doesn't support (it handles LineString, Polygon and
 * MultiPolygon only). A part left with fewer than two vertices is dropped.
 *
 * @param geometry - The MultiLineString to edit. It isn't mutated.
 * @param vertex - The vertex to remove, matched on longitude and latitude.
 * @param path - Geoman's marker path (`[..., partIndex, vertexIndex]`). Used
 *   when it points at `vertex`, so a repeated coordinate removes the right one.
 * @returns The new geometry, `null` when no part is left (the caller deletes
 *   the feature), or `undefined` when `vertex` isn't in `geometry`.
 */
export function removeMultiLineStringVertex(
  geometry: MultiLineString,
  vertex: Position,
  path?: readonly (string | number)[],
): MultiLineString | null | undefined {
  const same = (a: Position | undefined) => !!a && a[0] === vertex[0] && a[1] === vertex[1];
  let partIndex = -1;
  let vertexIndex = -1;
  const pathPart = path?.[path.length - 2];
  const pathVertex = path?.[path.length - 1];
  if (
    typeof pathPart === "number" &&
    typeof pathVertex === "number" &&
    same(geometry.coordinates[pathPart]?.[pathVertex])
  ) {
    partIndex = pathPart;
    vertexIndex = pathVertex;
  } else {
    partIndex = geometry.coordinates.findIndex((part) => part.some(same));
    if (partIndex === -1) return undefined;
    vertexIndex = geometry.coordinates[partIndex].findIndex(same);
  }

  const coordinates = geometry.coordinates
    .map((part, index) => (index === partIndex ? part.filter((_, i) => i !== vertexIndex) : part))
    .filter((part) => part.length >= 2);
  return coordinates.length > 0 ? { ...geometry, coordinates } : null;
}
