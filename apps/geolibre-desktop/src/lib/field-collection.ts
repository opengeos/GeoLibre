/**
 * Pure helpers for the Field Collection tool: defining a per-layer form schema,
 * validating captured attribute values, and building GeoJSON point features.
 *
 * Everything here is side-effect free so it can be unit tested without a DOM or
 * the app store. The React dialog (FieldCollectionDialog.tsx) owns the GPS,
 * map-click, and store wiring and delegates the data shaping to these functions.
 *
 * A "collection layer" is an ordinary `geojson` GeoLibreLayer tagged with
 * `metadata.fieldCollection === true` and carrying its schema under
 * `metadata.collectionSchema`. Both ride through `.geolibre.json` save/load via
 * the layer's free-form `metadata` bag, so collection layers reopen ready to use.
 */
import {
  coerceAttributeFormValue,
  getAttributeFormField,
  PHOTO_FULL_PROPERTY,
  PHOTO_PROPERTY,
  type AttributeFormConfig,
} from "@geolibre/core";
import type { Feature, FeatureCollection, LineString, Point, Polygon } from "geojson";

// Re-exported so existing importers (geotagged-photos, tests) keep a single
// import site; the canonical definitions live in @geolibre/core's schema.
export { PHOTO_FULL_PROPERTY, PHOTO_PROPERTY };

/** The attribute field kinds a collection form can declare. */
export type FieldType = "text" | "number" | "date" | "choice";

/** Geometry a collection layer captures. A layer holds one geometry type. */
export type GeometryType = "point" | "line" | "polygon";

/** A captured coordinate as [lng, lat]. */
export type Vertex = [number, number];

export interface CollectionField {
  /** Stable, slugified property key written to every captured feature. */
  key: string;
  /** Human-readable label shown in the capture form. */
  label: string;
  type: FieldType;
  required?: boolean;
  /** Allowed values for `choice` fields. */
  options?: string[];
}

export interface CollectionSchema {
  fields: CollectionField[];
}

/** `metadata` keys used to tag a collection layer and store its schema. */
export const FIELD_COLLECTION_FLAG = "fieldCollection";
export const COLLECTION_SCHEMA_KEY = "collectionSchema";
export const COLLECTION_GEOMETRY_KEY = "collectionGeometry";

/** Property keys the tool manages itself; user fields must not reuse them. */
export const RESERVED_PROPERTY_KEYS: readonly string[] = [PHOTO_PROPERTY, PHOTO_FULL_PROPERTY];

/**
 * Cap embedded photos so a capture session can't bloat the project JSON without
 * bound. Photos are stored inline as data URLs, so this is a hard per-photo cap.
 */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Minimal structural view of a layer — avoids coupling this module to the store. */
export interface CollectionLayerLike {
  type: string;
  metadata?: Record<string, unknown> | null;
  geojson?: FeatureCollection;
}

export function emptyFeatureCollection(): FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** True when a layer is a field-collection target (geojson + tagged metadata). */
export function isCollectionLayer(layer: CollectionLayerLike): boolean {
  return layer.type === "geojson" && layer.metadata?.[FIELD_COLLECTION_FLAG] === true;
}

/** Read a layer's stored collection schema, defaulting to an empty schema. */
export function getSchema(layer: CollectionLayerLike): CollectionSchema {
  const raw = layer.metadata?.[COLLECTION_SCHEMA_KEY];
  if (raw && typeof raw === "object" && Array.isArray((raw as Partial<CollectionSchema>).fields)) {
    return raw as CollectionSchema;
  }
  return { fields: [] };
}

/** Read a layer's captured geometry type, defaulting to `point`. */
export function getGeometryType(layer: CollectionLayerLike): GeometryType {
  const g = layer.metadata?.[COLLECTION_GEOMETRY_KEY];
  return g === "line" || g === "polygon" ? g : "point";
}

/** Minimum vertices a geometry needs before it can be finished/saved. */
export function minVertices(geometry: GeometryType): number {
  if (geometry === "polygon") return 3;
  if (geometry === "line") return 2;
  return 1;
}

/** Build the metadata patch that tags a layer as a collection layer. */
export function collectionMetadata(
  schema: CollectionSchema,
  geometry: GeometryType = "point",
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...existing,
    [FIELD_COLLECTION_FLAG]: true,
    [COLLECTION_SCHEMA_KEY]: schema,
    [COLLECTION_GEOMETRY_KEY]: geometry,
  };
}

/**
 * Slugify a human label into a safe property key, made unique against `taken`.
 * Empty/symbol-only labels fall back to `field`, then `field_2`, `field_3`, …
 */
export function slugifyKey(label: string, taken: Iterable<string> = []): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/**
 * Turn a list of draft fields (label + type, no keys yet) into a finalized
 * schema: blank labels are dropped and stable unique keys are assigned.
 */
export function buildSchema(
  drafts: Array<{
    label: string;
    type: FieldType;
    required?: boolean;
    options?: string[];
  }>,
): CollectionSchema {
  const fields: CollectionField[] = [];
  // Reserve system-managed property keys so a user field (e.g. a "Photo" label
  // slugged to "photo") can't collide with the attached photo and be silently
  // overwritten when buildProperties merges the extras.
  const taken = new Set<string>(RESERVED_PROPERTY_KEYS);
  for (const draft of drafts) {
    if (!draft.label.trim()) continue;
    const key = slugifyKey(draft.label, taken);
    taken.add(key);
    const field: CollectionField = {
      key,
      label: draft.label.trim(),
      type: draft.type,
    };
    if (draft.required) field.required = true;
    if (draft.type === "choice" && draft.options?.length) {
      field.options = draft.options;
    }
    fields.push(field);
  }
  return { fields };
}

/** Parse a comma-separated options string into a trimmed, de-duplicated list. */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(",")) {
    const v = part.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Normalize a raw form string into the typed value stored on the feature. */
export function coerceValue(type: FieldType, raw: string): string | number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (type === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  // text, date (kept as an ISO yyyy-mm-dd string), and choice are stored verbatim.
  return trimmed;
}

export interface ValidationResult {
  ok: boolean;
  /** Field key → error code (`required` | `number` | `choice`). */
  errors: Record<string, string>;
}

/** Validate raw form values against a schema before building a feature. */
export function validateForm(
  schema: CollectionSchema,
  values: Record<string, string>,
): ValidationResult {
  const errors: Record<string, string> = {};
  for (const field of schema.fields) {
    const raw = values[field.key] ?? "";
    const coerced = coerceValue(field.type, raw);
    if (field.required && coerced === null) {
      errors[field.key] = "required";
      continue;
    }
    if (field.type === "number" && raw.trim() !== "" && coerced === null) {
      errors[field.key] = "number";
    } else if (
      field.type === "choice" &&
      coerced !== null &&
      field.options &&
      field.options.length > 0 &&
      !field.options.includes(String(coerced))
    ) {
      errors[field.key] = "choice";
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** Build a typed properties object from raw form values plus any extras. */
export function buildProperties(
  schema: CollectionSchema,
  values: Record<string, string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const v = coerceValue(field.type, values[field.key] ?? "");
    if (v !== null) props[field.key] = v;
  }
  return { ...props, ...extra };
}

/**
 * Like {@link buildProperties}, but fields configured in the layer's Attribute
 * Form designer coerce by their edit widget instead of the schema's field type
 * (a `number`/`range` widget stores a number, a `checkbox` stores a boolean),
 * so constraint expressions and downstream styling see properly typed values.
 */
export function buildPropertiesWithForm(
  schema: CollectionSchema,
  values: Record<string, string>,
  form: AttributeFormConfig | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const field of schema.fields) {
    const config = getAttributeFormField(form, field.key);
    const raw = values[field.key] ?? "";
    const v = config ? coerceAttributeFormValue(config, raw) : coerceValue(field.type, raw);
    if (v !== null) props[field.key] = v;
  }
  return { ...props, ...extra };
}

/** Construct a GeoJSON point feature at the given coordinate. */
export function makePointFeature(
  lng: number,
  lat: number,
  properties: Record<string, unknown>,
): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lng, lat] },
    properties,
  };
}

/** Construct a GeoJSON LineString feature from captured vertices. */
export function makeLineFeature(
  coords: Vertex[],
  properties: Record<string, unknown>,
): Feature<LineString> {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords.map((c) => [...c]) },
    properties,
  };
}

/**
 * Construct a GeoJSON Polygon feature from captured vertices, closing the ring
 * (repeating the first vertex at the end) if the caller didn't already.
 */
export function makePolygonFeature(
  coords: Vertex[],
  properties: Record<string, unknown>,
): Feature<Polygon> {
  const ring: Vertex[] = coords.map((c) => [...c] as Vertex);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([...first] as Vertex);
  }
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties,
  };
}

/** Build the appropriate feature for a geometry type from captured vertices. */
export function buildGeometryFeature(
  geometry: GeometryType,
  coords: Vertex[],
  properties: Record<string, unknown>,
): Feature {
  if (geometry === "line") return makeLineFeature(coords, properties);
  if (geometry === "polygon") return makePolygonFeature(coords, properties);
  const pt = coords[0];
  if (!pt) throw new Error("buildGeometryFeature: a point needs one vertex");
  return makePointFeature(pt[0], pt[1], properties);
}

/**
 * A GeoJSON preview of in-progress drawing: a vertex point per coordinate, the
 * connecting line, and — for a polygon with enough vertices — the closed,
 * fillable ring so the user sees the finished shape before saving.
 */
export function drawPreview(geometry: GeometryType, coords: Vertex[]): FeatureCollection {
  const features: Feature[] = coords.map((c, i) => makePointFeature(c[0], c[1], { index: i }));
  if (geometry === "polygon" && coords.length >= 3) {
    features.push(makePolygonFeature(coords, {}));
    // Close the dashed stroke so it matches the filled ring (back to the start).
    features.push(makeLineFeature([...coords, coords[0]], {}));
  } else if ((geometry === "line" || geometry === "polygon") && coords.length >= 2) {
    features.push(makeLineFeature(coords, {}));
  }
  return { type: "FeatureCollection", features };
}

/** Return a new FeatureCollection with `feature` appended (immutably). */
export function appendFeature(fc: FeatureCollection, feature: Feature): FeatureCollection {
  return { type: "FeatureCollection", features: [...fc.features, feature] };
}
