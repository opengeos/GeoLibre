import type { Feature, FeatureCollection, Geometry, Position } from "geojson";

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

/** A count of features by change kind in a changed-only export. */
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

// Query discovery and viewport extraction live in @geolibre/map. This module
// owns only editor normalization and change tracking.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
