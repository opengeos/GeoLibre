import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";
import union from "@turf/union";

/**
 * Pure helpers for loading the vector features currently rendered in the map
 * view into the GeoEditor, and for exporting the editor's features (all of them,
 * or only the ones the user added, edited, or deleted).
 *
 * These are kept free of the Geoman/MapLibre runtime imports in
 * `maplibre-geo-editor.ts` so they can be unit-tested under Node without a
 * browser. The functions that touch the live map take a minimal structural
 * interface ({@link ViewImportMap}) rather than a MapLibre `Map`, so the query
 * path is testable with a lightweight stub.
 */

/**
 * Property key that carries a stable per-feature id while features loaded from a
 * map view live in the editor. Geoman reassigns `feature.id` on import but
 * preserves `properties`, so this tag is how a loaded feature's identity (and
 * therefore its baseline) survives editing, and how deletions are detected on
 * save. It is `__`-prefixed and namespaced to avoid colliding with real data,
 * and is stripped from every exported feature.
 */
export const VIEW_IMPORT_ID_PROPERTY = "__geolibre_view_fid";

/**
 * Property written onto each feature in a "changed only" export, marking whether
 * the feature was added, modified, or deleted relative to what was loaded.
 */
export const VIEW_IMPORT_CHANGE_PROPERTY = "__change";

/**
 * Provenance keys stamped onto changed/added/deleted features on export. They
 * are namespaced (rather than plain `editor`/`modified`) so a source dataset
 * that already carries an `editor` or `modified` attribute is not silently
 * overwritten in the exported GeoJSON.
 */
export const VIEW_IMPORT_EDITOR_PROPERTY = "__geolibre_editor";
export const VIEW_IMPORT_MODIFIED_PROPERTY = "__geolibre_modified";

/** The kind of change a feature represents in a "changed only" export. */
export type ViewImportChangeKind = "added" | "modified" | "deleted";

/** The MapLibre style-layer types whose geometry the editor can load and edit. */
export const EDITABLE_VIEW_LAYER_TYPES = new Set([
  "fill",
  "line",
  "circle",
  "symbol",
  "fill-extrusion",
]);

/** A vector map layer in the current view that can be loaded into the editor. */
export interface ViewVectorLayer {
  /** The MapLibre style layer id (shown in the dropdown). */
  id: string;
  /** The layer's render type, e.g. "fill" or "line" (shown as a hint). */
  type: string;
  /** The id of the source the layer draws from. */
  sourceId: string;
  /** The vector-tile source layer, when the source is a vector-tile source. */
  sourceLayer?: string;
}

/** A count of features by change kind in a "changed only" export. */
export interface ViewImportChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

/** The result of building an export collection from the editor's features. */
export interface ViewImportExport {
  collection: FeatureCollection;
  counts: ViewImportChangeCounts;
}

/** A baseline feature captured right after import, keyed by view-import id. */
interface BaselineEntry {
  geometry: Geometry;
  properties: Record<string, unknown>;
}

/** Immutable snapshot of the features loaded from a view, for change tracking. */
export type ViewImportBaseline = Map<string, BaselineEntry>;

/** Geographic bounds as used for the viewport-intersection test. */
export interface ViewBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** The minimal MapLibre `Map` surface the query path depends on. */
export interface ViewImportMap {
  getStyle: () => { layers?: unknown[]; sources?: Record<string, unknown> } | undefined;
  querySourceFeatures: (
    sourceId: string,
    options?: { sourceLayer?: string },
  ) => Array<{
    id?: unknown;
    geometry: Geometry;
    properties?: Record<string, unknown> | null;
  }>;
  getBounds: () => {
    getWest: () => number;
    getEast: () => number;
    getSouth: () => number;
    getNorth: () => number;
  };
}

// ---------------------------------------------------------------------------
// Layer discovery
// ---------------------------------------------------------------------------

/**
 * True for a style layer id that belongs to the editor's own overlay (Geoman's
 * `gm_*`/`gm-*` layers or the GeoEditor selection `geo-editor*` layers). These
 * must never appear as loadable layers, or the editor would try to load its own
 * scratch geometry.
 */
export function isInternalEditorLayerId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.startsWith("gm_") ||
    lower.startsWith("gm-") ||
    lower.startsWith("geo-editor") ||
    lower.startsWith("geoman") ||
    // GeoLibre's own overlay layers (selection highlight, measure, etc.) that
    // are not user data. User layers use the `layer-<id>-*` id convention.
    lower.startsWith("geolibre-")
  );
}

/**
 * List the vector layers currently in the map style that can be loaded into the
 * editor: layers of an editable render type ({@link EDITABLE_VIEW_LAYER_TYPES})
 * drawing from a `vector` or `geojson` source. Basemap vector-tile layers are
 * included so users can grab rendered basemap features (e.g. buildings); only
 * the editor's own overlay layers are excluded.
 *
 * @param style The map's current style object (`map.getStyle()`).
 * @returns The loadable layers, in style (bottom-to-top) order.
 */
export function listViewVectorLayers(
  style: { layers?: unknown[]; sources?: Record<string, unknown> } | undefined,
): ViewVectorLayer[] {
  const layers = style?.layers;
  if (!Array.isArray(layers)) return [];
  const sources = style?.sources ?? {};
  const result: ViewVectorLayer[] = [];

  for (const raw of layers) {
    if (!raw || typeof raw !== "object") continue;
    const layer = raw as Record<string, unknown>;
    const id = layer.id;
    const type = layer.type;
    const sourceId = layer.source;
    if (typeof id !== "string" || typeof type !== "string") continue;
    if (typeof sourceId !== "string" || sourceId.length === 0) continue;
    if (!EDITABLE_VIEW_LAYER_TYPES.has(type)) continue;
    if (isInternalEditorLayerId(id)) continue;

    const source = sources[sourceId] as { type?: string } | undefined;
    const sourceType = source?.type;
    if (sourceType !== "vector" && sourceType !== "geojson") continue;

    const sourceLayer = layer["source-layer"];
    result.push({
      id,
      type,
      sourceId,
      ...(typeof sourceLayer === "string" ? { sourceLayer } : {}),
    });
  }

  return result;
}

/** The subset of a GeoLibre store layer this module needs to resolve a source. */
export interface StoreLayerLike {
  id: string;
  metadata?: {
    sourceIds?: unknown;
    /** Singular source id used by some layer kinds (e.g. PMTiles/MBTiles). */
    sourceId?: unknown;
    nativeLayerIds?: unknown;
    sourceKind?: unknown;
  };
}

/** The conventional map-layer ids GeoLibre gives a store layer's geometry. */
function conventionalMapLayerIds(layerId: string): string[] {
  return [
    `layer-${layerId}-fill`,
    `layer-${layerId}-extrusion`,
    `layer-${layerId}-line`,
    `layer-${layerId}-circle`,
    `layer-${layerId}-symbol`,
    `layer-${layerId}-text`,
  ];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Resolve a GeoLibre store (Layers-panel) vector layer to the map source and
 * source-layer needed to query its features in the current view. Returns null
 * when the layer has no editable vector/geojson map layer in the style (e.g. a
 * raster or tile-image layer, or a layer not currently on the map), so callers
 * naturally exclude non-vector layers and, since only store layers are passed,
 * the basemap.
 *
 * @param layer The store layer (its id and source metadata).
 * @param style The map's current style object.
 * @returns The queryable source descriptor, or null when not resolvable.
 */
export function resolveStoreLayerViewSource(
  layer: StoreLayerLike,
  style: { layers?: unknown[]; sources?: Record<string, unknown> } | undefined,
): ViewVectorLayer | null {
  const layers = style?.layers;
  if (!Array.isArray(layers)) return null;
  const sources = style?.sources ?? {};

  const candidateIds = new Set([
    ...stringArray(layer.metadata?.nativeLayerIds),
    ...conventionalMapLayerIds(layer.id),
  ]);
  const candidateSources = new Set(stringArray(layer.metadata?.sourceIds));
  if (typeof layer.metadata?.sourceId === "string") {
    candidateSources.add(layer.metadata.sourceId);
  }

  for (const raw of layers) {
    if (!raw || typeof raw !== "object") continue;
    const mapLayer = raw as Record<string, unknown>;
    const type = mapLayer.type;
    const sourceId = mapLayer.source;
    if (typeof type !== "string" || !EDITABLE_VIEW_LAYER_TYPES.has(type)) {
      continue;
    }
    if (typeof sourceId !== "string" || sourceId.length === 0) continue;
    if (isInternalEditorLayerId(String(mapLayer.id ?? ""))) continue;

    const belongs = candidateIds.has(String(mapLayer.id ?? "")) || candidateSources.has(sourceId);
    if (!belongs) continue;

    const sourceType = (sources[sourceId] as { type?: string } | undefined)?.type;
    if (sourceType !== "vector" && sourceType !== "geojson") continue;

    const sourceLayer = mapLayer["source-layer"];
    return {
      id: layer.id,
      type,
      sourceId,
      ...(typeof sourceLayer === "string" ? { sourceLayer } : {}),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Viewport query helpers (pure)
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The [minX, minY, maxX, maxY] bounding box of a geometry, or null when empty. */
function geometryBbox(geometry: Geometry): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
      const [lng, lat] = value as [number, number];
      if (lng < minX) minX = lng;
      if (lng > maxX) maxX = lng;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
      return;
    }
    for (const item of value) walk(item);
  };
  walk((geometry as { coordinates?: unknown }).coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/**
 * Whether a geometry's bounding box overlaps the given viewport bounds. Uses a
 * bbox-overlap test (not a vertex-in-bounds test) so features that intersect the
 * view without any vertex on screen still count: a line crossing the viewport,
 * or a large polygon that fully contains it. This over-includes features whose
 * bbox overlaps but whose geometry does not, which is acceptable here — the
 * source only yields features from loaded tiles, and including a nearby feature
 * is far better than dropping one the user can clearly see.
 */
export function geometryIntersectsBounds(
  geometry: Geometry | null | undefined,
  bounds: ViewBounds,
): boolean {
  if (!geometry) return false;
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.some((g) => geometryIntersectsBounds(g, bounds));
  }
  const bbox = geometryBbox(geometry);
  if (!bbox) return false;
  const [minX, minY, maxX, maxY] = bbox;
  return minX <= bounds.east && maxX >= bounds.west && minY <= bounds.north && maxY >= bounds.south;
}

/** A rough size for a geometry, used to keep the largest of duplicate tiles. */
export function geometryCoordinateCount(geometry: Geometry | null | undefined): number {
  if (!geometry) return 0;
  try {
    return JSON.stringify(geometry).length;
  } catch {
    return 0;
  }
}

function isPolygonal(feature: Feature): feature is Feature<Polygon | MultiPolygon> {
  const type = feature.geometry?.type;
  return type === "Polygon" || type === "MultiPolygon";
}

function isLinear(feature: Feature): feature is Feature<LineString | MultiLineString> {
  const type = feature.geometry?.type;
  return type === "LineString" || type === "MultiLineString";
}

/**
 * Reassemble the tile-clipped pieces of one feature into a single geometry.
 * `querySourceFeatures` returns a feature once per tile it spans, each clipped
 * to that tile, so a feature straddling a tile boundary comes back as several
 * partial shapes. Polygonal pieces are dissolved with a union (their shared,
 * buffered tile-boundary edges cancel out, reconstructing the whole footprint);
 * line pieces are collected into a MultiLineString so every fragment is kept
 * (they are not topologically stitched, but nothing is dropped). If reassembly
 * is not possible (mixed/other types, or the union throws) the largest piece is
 * kept as a safe fallback rather than a wrong merge.
 *
 * @param pieces The clipped pieces of one feature (>= 1).
 * @returns A single feature with the reassembled geometry.
 */
function mergeClippedPieces(pieces: Feature[]): Feature {
  // The largest piece carries the id/properties and is the fallback geometry.
  let largest = pieces[0];
  let largestSize = geometryCoordinateCount(largest.geometry);
  for (const piece of pieces) {
    const size = geometryCoordinateCount(piece.geometry);
    if (size > largestSize) {
      largest = piece;
      largestSize = size;
    }
  }
  if (pieces.length === 1) return largest;

  const withMergedGeometry = (geometry: Geometry): Feature => ({
    type: "Feature",
    ...(largest.id != null ? { id: largest.id } : {}),
    geometry,
    properties: { ...(largest.properties ?? {}) },
  });

  if (pieces.every(isPolygonal)) {
    try {
      const merged = union({
        type: "FeatureCollection",
        features: pieces as Feature<Polygon | MultiPolygon>[],
      });
      if (merged?.geometry) return withMergedGeometry(merged.geometry);
    } catch {
      // Degenerate geometry can make the union throw; fall back to the largest.
    }
  } else if (pieces.every(isLinear)) {
    // Collect every clipped segment so a road/line crossing a tile boundary is
    // preserved whole rather than reduced to its largest fragment.
    const lines: Position[][] = [];
    for (const piece of pieces) {
      const geometry = piece.geometry;
      if (geometry.type === "LineString") lines.push(geometry.coordinates);
      else lines.push(...geometry.coordinates);
    }
    if (lines.length > 0) {
      return withMergedGeometry({ type: "MultiLineString", coordinates: lines });
    }
  }

  return largest;
}

/**
 * Deduplicate source features (a vector-tile feature can appear once per tile it
 * spans) by feature id and drop anything outside the viewport. Tile-clipped
 * pieces of the same feature are reassembled (see {@link mergeClippedPieces}) so
 * features straddling a tile boundary are not cut off. Features without a stable
 * id are kept as-is (each piece stands alone).
 *
 * @param sourceFeatures Raw features from `map.querySourceFeatures`.
 * @param bounds The current viewport bounds.
 * @returns The unique, in-view features as plain GeoJSON.
 */
export function dedupeViewportFeatures(
  sourceFeatures: Array<{
    id?: unknown;
    geometry: Geometry;
    properties?: Record<string, unknown> | null;
  }>,
  bounds: ViewBounds,
): Feature[] {
  const groups = new Map<string, Feature[]>();
  let autoIndex = 0;

  for (const raw of sourceFeatures) {
    if (!geometryIntersectsBounds(raw.geometry, bounds)) continue;

    const props = raw.properties ?? {};
    const key = String(raw.id ?? props.id ?? props.osm_id ?? "") || `__auto_${autoIndex++}`;
    const feature: Feature = {
      type: "Feature",
      geometry: raw.geometry,
      properties: { ...props },
    };
    if (raw.id != null) feature.id = raw.id as string | number;
    const group = groups.get(key);
    if (group) group.push(feature);
    else groups.set(key, [feature]);
  }

  return [...groups.values()].map((pieces) => mergeClippedPieces(pieces));
}

/**
 * Query the features of a map layer that are rendered in the current viewport
 * and return them as plain, deduplicated GeoJSON. Uses `querySourceFeatures`
 * (full, unclipped geometries from all loaded tiles) rather than
 * `queryRenderedFeatures` (which can omit features depending on zoom/tile state)
 * and then filters to the viewport.
 *
 * @param map The live map (or a compatible stub).
 * @param layer The layer to query, from {@link listViewVectorLayers}.
 * @returns The in-view features, or an empty array when none are loaded.
 */
export function queryViewLayerFeatures(map: ViewImportMap, layer: ViewVectorLayer): Feature[] {
  const sourceFeatures = map.querySourceFeatures(
    layer.sourceId,
    layer.sourceLayer ? { sourceLayer: layer.sourceLayer } : undefined,
  );
  if (!sourceFeatures || sourceFeatures.length === 0) return [];

  const b = map.getBounds();
  const bounds: ViewBounds = {
    west: b.getWest(),
    east: b.getEast(),
    south: b.getSouth(),
    north: b.getNorth(),
  };
  return dedupeViewportFeatures(sourceFeatures, bounds);
}

// ---------------------------------------------------------------------------
// Normalization (make tile geometry safe for the editor)
// ---------------------------------------------------------------------------

function clonePosition(value: unknown): Position | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (!value.every(isFiniteNumber)) return null;
  return [...(value as number[])] as Position;
}

function positionsEqual(a: Position, b: Position): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function normalizeRing(value: unknown): Position[] | null {
  if (!Array.isArray(value)) return null;
  const points: Position[] = [];
  for (const entry of value) {
    const point = clonePosition(entry);
    if (!point) return null;
    if (points.length === 0 || !positionsEqual(points[points.length - 1], point)) {
      points.push(point);
    }
  }
  if (points.length < 3) return null;
  const closed = positionsEqual(points[0], points[points.length - 1])
    ? points
    : [...points, [...points[0]] as Position];
  return closed.length >= 4 ? closed : null;
}

function normalizePointArray(value: unknown): Position[] | null {
  if (!Array.isArray(value)) return null;
  const points = value
    .map((entry) => clonePosition(entry))
    .filter((entry): entry is Position => entry != null);
  return points.length > 0 ? points : null;
}

function normalizeLine(value: unknown): Position[] | null {
  const points = normalizePointArray(value);
  return points && points.length >= 2 ? points : null;
}

function normalizeGeometry(geometry: Geometry | null): Geometry | null {
  if (!geometry) return null;
  switch (geometry.type) {
    case "Point": {
      const coordinates = clonePosition(geometry.coordinates);
      return coordinates ? { type: "Point", coordinates } : null;
    }
    case "MultiPoint": {
      const coordinates = normalizePointArray(geometry.coordinates);
      return coordinates ? { type: "MultiPoint", coordinates } : null;
    }
    case "LineString": {
      const coordinates = normalizeLine(geometry.coordinates);
      return coordinates ? { type: "LineString", coordinates } : null;
    }
    case "MultiLineString": {
      const coordinates = (geometry.coordinates as unknown[])
        .map((line) => normalizeLine(line))
        .filter((line): line is Position[] => line != null);
      return coordinates.length > 0 ? { type: "MultiLineString", coordinates } : null;
    }
    case "Polygon": {
      const coordinates = (geometry.coordinates as unknown[])
        .map((ring) => normalizeRing(ring))
        .filter((ring): ring is Position[] => ring != null);
      return coordinates.length > 0 ? { type: "Polygon", coordinates } : null;
    }
    case "MultiPolygon": {
      const coordinates = (geometry.coordinates as unknown[])
        .map((polygon) =>
          (polygon as unknown[])
            .map((ring) => normalizeRing(ring))
            .filter((ring): ring is Position[] => ring != null),
        )
        .filter((polygon): polygon is Position[][] => polygon.length > 0);
      return coordinates.length > 0 ? { type: "MultiPolygon", coordinates } : null;
    }
    case "GeometryCollection": {
      const geometries = geometry.geometries
        .map((entry) => normalizeGeometry(entry))
        .filter((entry): entry is Geometry => entry != null);
      return geometries.length > 0 ? { type: "GeometryCollection", geometries } : null;
    }
    default:
      return null;
  }
}

/**
 * Tag a set of view-queried features for loading into the editor: drop any with
 * geometry the editor cannot represent, normalize the rest (closed polygon
 * rings, finite coordinates), and stamp each with a unique
 * {@link VIEW_IMPORT_ID_PROPERTY} in both `feature.id` and `properties` so its
 * identity survives Geoman's round-trip. Point features are pre-tagged as circle
 * markers (`__gm_shape`) so Geoman renders them editable rather than invisible.
 *
 * @param features Plain features from {@link queryViewLayerFeatures}.
 * @param idPrefix Prefix for the generated ids; use a distinct prefix per load
 *   so appending a second layer cannot collide ids with the first.
 * @returns The prepared collection plus how many features were dropped.
 */
export function tagViewFeaturesForImport(
  features: Feature[],
  idPrefix = "view",
): {
  collection: FeatureCollection;
  requested: number;
  prepared: number;
  dropped: number;
} {
  const prepared: Feature[] = [];
  features.forEach((feature, index) => {
    const geometry = normalizeGeometry(feature.geometry);
    if (!geometry) return;
    const id = `${idPrefix}-${index}`;
    const properties: Record<string, unknown> = {
      ...(feature.properties ?? {}),
      [VIEW_IMPORT_ID_PROPERTY]: id,
    };
    if (geometry.type === "Point") {
      properties.__gm_shape = "circle_marker";
    }
    prepared.push({ type: "Feature", id, geometry, properties });
  });

  return {
    collection: { type: "FeatureCollection", features: prepared },
    requested: features.length,
    prepared: prepared.length,
    dropped: features.length - prepared.length,
  };
}

// ---------------------------------------------------------------------------
// Change tracking (baseline + diff)
// ---------------------------------------------------------------------------

/** Whether a property key is an editor-internal tag that must not be exported. */
function isInternalProperty(key: string): boolean {
  return key.startsWith("__gm_") || key === VIEW_IMPORT_ID_PROPERTY;
}

/** Strip editor-internal properties, returning a plain attribute map. */
export function stripEditorProperties(
  properties: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!isInternalProperty(key)) out[key] = value;
  }
  return out;
}

/** The view-import id stamped on a feature, or null for a newly drawn one. */
function viewImportId(feature: Feature): string | null {
  const value = feature.properties?.[VIEW_IMPORT_ID_PROPERTY];
  return typeof value === "string" ? value : null;
}

/**
 * Capture a baseline from the editor's features immediately after a view import.
 * Geoman normalizes coordinates on import, so the baseline is taken from the
 * post-import geometry (keyed by {@link VIEW_IMPORT_ID_PROPERTY}); comparing
 * against it on save means only genuine user edits register as "modified".
 * Features without a view-import id (drawn before the import) are ignored.
 *
 * @param collection The editor's feature collection right after import.
 * @param onlyIds When given, capture only features whose view-import id is in
 *   this set (used when appending, to add just the new features' baseline).
 * @returns A baseline keyed by view-import id.
 */
export function captureViewImportBaseline(
  collection: FeatureCollection,
  onlyIds?: Set<string>,
): ViewImportBaseline {
  const baseline: ViewImportBaseline = new Map();
  for (const feature of collection.features) {
    const id = viewImportId(feature);
    if (!id) continue;
    if (!feature.geometry) continue;
    if (onlyIds && !onlyIds.has(id)) continue;
    // Deep-clone so a later in-place mutation of the editor's geometry cannot
    // drift the baseline (which would make the changed-only diff miss edits).
    baseline.set(id, {
      geometry: structuredClone(feature.geometry),
      properties: stripEditorProperties(feature.properties),
    });
  }
  return baseline;
}

function canonicalGeometry(geometry: Geometry | null | undefined): string {
  if (!geometry) return "null";
  try {
    return JSON.stringify(
      "coordinates" in geometry ? (geometry as { coordinates: unknown }).coordinates : geometry,
    );
  } catch {
    return "null";
  }
}

function canonicalProperties(properties: Record<string, unknown>): string {
  const keys = Object.keys(properties).sort();
  return JSON.stringify(keys.map((key) => [key, properties[key]]));
}

/** Drop a Geoman-assigned numeric id that is not a safe integer (JSON-unsafe). */
function withSafeId(feature: Feature): Feature {
  if (typeof feature.id === "number" && !Number.isSafeInteger(feature.id)) {
    const { id: _drop, ...rest } = feature;
    void _drop;
    return rest;
  }
  return feature;
}

function withEditorMetadata(
  properties: Record<string, unknown>,
  editorName: string,
  now: string,
): Record<string, unknown> {
  return {
    ...properties,
    ...(editorName ? { [VIEW_IMPORT_EDITOR_PROPERTY]: editorName } : {}),
    [VIEW_IMPORT_MODIFIED_PROPERTY]: now,
  };
}

/**
 * Build the full export: every feature currently in the editor, with
 * editor-internal properties stripped and JSON-unsafe ids removed. Used by the
 * "Save all features" action.
 *
 * @param collection The editor's current feature collection.
 * @returns The export collection and a total feature count under `added`.
 */
export function buildFullExport(collection: FeatureCollection): ViewImportExport {
  const features = collection.features.map((feature) =>
    withSafeId({
      ...feature,
      properties: stripEditorProperties(feature.properties),
    }),
  );
  return {
    collection: { type: "FeatureCollection", features },
    counts: { added: features.length, modified: 0, deleted: 0 },
  };
}

/**
 * Build a "changed only" export by diffing the editor's current features against
 * the baseline captured at import: features whose geometry or attributes changed
 * are tagged `modified`, features with no baseline id are `added`, and baseline
 * features no longer present are emitted as `deleted` (carrying their original
 * geometry and attributes). Each feature gets a {@link VIEW_IMPORT_CHANGE_PROPERTY}
 * tag plus namespaced editor/timestamp provenance keys.
 *
 * @param collection The editor's current feature collection.
 * @param baseline The baseline from {@link captureViewImportBaseline}.
 * @param options Editor name and the ISO timestamp to stamp on changes.
 * @returns The changed-only collection and per-kind counts.
 */
export function buildChangedExport(
  collection: FeatureCollection,
  baseline: ViewImportBaseline,
  options: { editorName?: string; now: string },
): ViewImportExport {
  const editorName = options.editorName?.trim() ?? "";
  const now = options.now;
  const features: Feature[] = [];
  const counts: ViewImportChangeCounts = { added: 0, modified: 0, deleted: 0 };
  const seen = new Set<string>();

  for (const feature of collection.features) {
    const id = viewImportId(feature);
    const props = stripEditorProperties(feature.properties);

    if (id && baseline.has(id)) {
      seen.add(id);
      const original = baseline.get(id) as BaselineEntry;
      const geometryChanged =
        canonicalGeometry(feature.geometry) !== canonicalGeometry(original.geometry);
      const propsChanged = canonicalProperties(props) !== canonicalProperties(original.properties);
      if (!geometryChanged && !propsChanged) continue;
      features.push(
        withSafeId({
          ...feature,
          properties: {
            ...withEditorMetadata(props, editorName, now),
            [VIEW_IMPORT_CHANGE_PROPERTY]: "modified",
          },
        }),
      );
      counts.modified += 1;
    } else {
      features.push(
        withSafeId({
          ...feature,
          properties: {
            ...withEditorMetadata(props, editorName, now),
            [VIEW_IMPORT_CHANGE_PROPERTY]: "added",
          },
        }),
      );
      counts.added += 1;
    }
  }

  for (const [id, original] of baseline) {
    if (seen.has(id)) continue;
    features.push({
      type: "Feature",
      geometry: original.geometry,
      properties: {
        ...original.properties,
        ...(editorName ? { [VIEW_IMPORT_EDITOR_PROPERTY]: editorName } : {}),
        [VIEW_IMPORT_MODIFIED_PROPERTY]: now,
        [VIEW_IMPORT_CHANGE_PROPERTY]: "deleted",
      },
    });
    counts.deleted += 1;
  }

  return { collection: { type: "FeatureCollection", features }, counts };
}
