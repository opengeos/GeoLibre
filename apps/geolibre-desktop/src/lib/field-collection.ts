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
import type { Feature, FeatureCollection, Point } from "geojson";

/** The attribute field kinds a collection form can declare. */
export type FieldType = "text" | "number" | "date" | "choice";

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

/** Property key under which a captured photo (data URL) is stored. */
export const PHOTO_PROPERTY = "photo";

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
  return (
    layer.type === "geojson" &&
    layer.metadata?.[FIELD_COLLECTION_FLAG] === true
  );
}

/** Read a layer's stored collection schema, defaulting to an empty schema. */
export function getSchema(layer: CollectionLayerLike): CollectionSchema {
  const raw = layer.metadata?.[COLLECTION_SCHEMA_KEY];
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as Partial<CollectionSchema>).fields)
  ) {
    return raw as CollectionSchema;
  }
  return { fields: [] };
}

/** Build the metadata patch that tags a layer as a collection layer. */
export function collectionMetadata(
  schema: CollectionSchema,
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...existing,
    [FIELD_COLLECTION_FLAG]: true,
    [COLLECTION_SCHEMA_KEY]: schema,
  };
}

/**
 * Slugify a human label into a safe property key, made unique against `taken`.
 * Empty/symbol-only labels fall back to `field`, then `field_2`, `field_3`, …
 */
export function slugifyKey(
  label: string,
  taken: Iterable<string> = [],
): string {
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
  for (const draft of drafts) {
    if (!draft.label.trim()) continue;
    const key = slugifyKey(
      draft.label,
      fields.map((f) => f.key),
    );
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
export function coerceValue(
  type: FieldType,
  raw: string,
): string | number | null {
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

/** Return a new FeatureCollection with `feature` appended (immutably). */
export function appendFeature(
  fc: FeatureCollection,
  feature: Feature,
): FeatureCollection {
  return { type: "FeatureCollection", features: [...fc.features, feature] };
}

/** Rough byte size of a data URL's payload (for the photo size guard). */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const payload = dataUrl.slice(comma + 1);
  // base64 expands by 4/3; the last group may carry one or two `=` pads.
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}
