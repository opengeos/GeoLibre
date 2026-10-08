import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import {
  arcGISDomainError,
  arcGISSubtypeField,
  resolveArcGISFieldDomain,
  type ArcGISDomain,
  type ArcGISFeatureTemplate,
  type ArcGISFeatureType,
  type ArcGISSubtype,
} from "./arcgis-domains";

/** The subset of layer metadata needed to validate an edit before sending it. */
export interface ArcGISEditInfo {
  objectIdField?: string;
  capabilities?: string;
  allowGeometryUpdates?: boolean;
  geometryType?: string;
  hasZ?: boolean;
  enableZDefaults?: boolean;
  zDefault?: number;
  hasM?: boolean;
  isDataVersioned?: boolean;
  datesInUnknownTimezone?: boolean;
  /**
   * The features were loaded generalized for a zoomed-out view, so their
   * geometry is a simplified copy that must not replace the service's.
   */
  geometryGeneralized?: boolean;
  fields?: Array<{
    name: string;
    type: string;
    alias?: string;
    editable?: boolean;
    nullable?: boolean;
    length?: number;
    domain?: ArcGISDomain | null;
    /** Value the service stores when an insert omits the field. */
    defaultValue?: unknown;
  }>;
  /** Field holding the service-assigned global ID, when the layer has one. */
  globalIdField?: string;
  /** Layer-level feature templates (layers without types). */
  templates?: ArcGISFeatureTemplate[];
  /** Subtype a new feature gets when none is chosen. */
  defaultSubtypeCode?: unknown;
  /** Field whose value selects an entry of {@link types}. */
  typeIdField?: string;
  /** Feature types, each optionally overriding field domains. */
  types?: ArcGISFeatureType[];
  /** Field whose value selects an entry of {@link subtypes}. */
  subtypeField?: string;
  /** Subtypes, each optionally overriding field domains. */
  subtypes?: ArcGISSubtype[];
}

/**
 * The edit operations GeoLibre can save to a layer, given what the service
 * allows and what GeoLibre can represent faithfully.
 *
 * An M-aware layer (`hasM`) stays editable for attributes and deletes, but not
 * for inserts: features load as GeoJSON, which has no measure values, so a new
 * shape would be stored without the measures the layer is built around.
 * Geometry updates on such a layer are refused by {@link planArcGISEdits}.
 *
 * @param info - The layer's `?f=json` metadata.
 * @returns Which of create, update and delete may be saved.
 */
export function arcGISEditCapabilities(info: ArcGISEditInfo) {
  const caps = new Set(
    info.capabilities
      ?.toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  );
  const supported = Boolean(
    info.objectIdField &&
    info.fields?.length &&
    !info.isDataVersioned &&
    !info.datesInUnknownTimezone,
  );
  return {
    create: supported && !info.hasM && caps.has("create"),
    update: supported && caps.has("update"),
    delete: supported && caps.has("delete"),
  };
}

export function arcGISObjectId(feature: Feature, field: string): number | undefined {
  const value = feature.properties?.[field];
  if (value == null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ArcGIS object ID in ${field}.`);
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only compare the geometry and attributes; editor-generated feature ids are local. */
export function sameArcGISFeature(a: Feature, b: Feature): boolean {
  return same(a.geometry, b.geometry) && same(a.properties, b.properties);
}

/** Accept server calculations while preserving only changes made after submission. */
export function reconcileArcGISRefresh(
  current: Feature,
  submitted: Feature,
  fresh: Feature,
): Feature {
  const properties = { ...fresh.properties };
  for (const key of new Set([
    ...Object.keys(current.properties ?? {}),
    ...Object.keys(submitted.properties ?? {}),
  ])) {
    if (same(current.properties?.[key], submitted.properties?.[key])) continue;
    if (Object.hasOwn(current.properties ?? {}, key)) properties[key] = current.properties![key];
    else delete properties[key];
  }
  return {
    ...current,
    properties,
    geometry: same(current.geometry, submitted.geometry) ? fresh.geometry : current.geometry,
  };
}

/**
 * The object ID of a record freshly read from the service, recovered when the
 * response does not carry it under the exact `objectIdField` name: from a
 * property whose name differs only in case, or from the GeoJSON feature `id`,
 * which ArcGIS fills from the object ID.
 */
function recoveredArcGISObjectId(
  feature: Feature,
  field: string,
): { id: number; key?: string } | undefined {
  const properties = feature.properties ?? {};
  const lower = field.toLowerCase();
  const key = Object.keys(properties).find(
    (name) => name !== field && name.toLowerCase() === lower && properties[name] != null,
  );
  const value = key === undefined ? feature.id : properties[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { id: value, key }
    : undefined;
}

/**
 * Prepare features freshly read from the service for editing: each keeps its
 * object ID under the layer's `objectIdField` and gets it as a stable local
 * identity, and a record the service returned twice is kept once.
 *
 * @param data - The downloaded features.
 * @param field - The layer's object ID field, if it names one.
 * @returns The features, ready to serve as an edit baseline.
 */
export function identifyArcGISFeatures(data: FeatureCollection, field?: string): FeatureCollection {
  if (!field) return data;
  const seen = new Set<number>();
  const features: Feature[] = [];
  for (let feature of data.features) {
    if (feature.properties?.[field] == null) {
      const recovered = recoveredArcGISObjectId(feature, field);
      if (recovered !== undefined) {
        // Move a case-variant ID rather than copy it, so the table shows one ID column.
        const properties = { ...feature.properties, [field]: recovered.id };
        if (recovered.key !== undefined) delete properties[recovered.key];
        feature = { ...feature, properties };
      }
    }
    // Loading never fails on an odd ID; saving validates it with a clear error.
    const value = feature.properties?.[field];
    const id =
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    if (id !== undefined) {
      // Overlapping pages can repeat a record; the first copy is kept.
      if (seen.has(id)) continue;
      seen.add(id);
    }
    features.push(feature.id !== undefined || id === undefined ? feature : { ...feature, id });
  }
  return { ...data, features };
}

/** Match downloaded records by object ID so sorting never pins a viewport. */
export function sameArcGISFeatures(
  a: FeatureCollection,
  b: FeatureCollection,
  field?: string,
): boolean {
  if (a.features.length !== b.features.length) return false;
  if (!field) return a.features.every((f, i) => sameArcGISFeature(f, b.features[i]));
  try {
    const byId = new Map(a.features.map((f) => [arcGISObjectId(f, field), f]));
    if (byId.has(undefined) || byId.size !== a.features.length) return false;
    for (const feature of b.features) {
      const id = arcGISObjectId(feature, field);
      const previous = byId.get(id);
      if (!previous || previous.id !== feature.id || !sameArcGISFeature(previous, feature))
        return false;
      byId.delete(id);
    }
    return byId.size === 0;
  } catch {
    return false; // Invalid or edited IDs must keep replacement downloads paused.
  }
}

function orient(ring: Position[], clockwise: boolean): Position[] {
  if (ring.length < 4 || !same(ring[0], ring[ring.length - 1]))
    throw new Error("ArcGIS polygon rings must be closed and contain at least four positions.");
  const area = ring.reduce((sum, p, i) => {
    const q = ring[(i + 1) % ring.length];
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0);
  return area < 0 === clockwise ? ring : [...ring].reverse();
}

/** GeoJSON is WGS84; ArcGIS projects the explicitly tagged geometry on receipt. */
export function arcGISGeometry(geometry: Geometry | null, info: ArcGISEditInfo): unknown {
  if (!geometry) return null;
  const types: Record<string, string> = {
    Point: "esriGeometryPoint",
    MultiPoint: "esriGeometryMultipoint",
    LineString: "esriGeometryPolyline",
    MultiLineString: "esriGeometryPolyline",
    Polygon: "esriGeometryPolygon",
    MultiPolygon: "esriGeometryPolygon",
  };
  if (!types[geometry.type] || types[geometry.type] !== info.geometryType)
    throw new Error("Geometry does not match the ArcGIS layer type.");
  // Geoman draws in 2D. Supply a Z only when the service explicitly enables a finite default.
  geometry = structuredClone(geometry);
  const check = (value: unknown): void => {
    if (!Array.isArray(value) || !value.length) throw new Error("Empty ArcGIS geometry.");
    if (typeof value[0] === "number") {
      if (info.hasZ && value.length === 2) {
        if (
          info.enableZDefaults !== true ||
          typeof info.zDefault !== "number" ||
          !Number.isFinite(info.zDefault)
        ) {
          throw new Error(
            "This Z-enabled ArcGIS layer requires a finite Z for every vertex or an enabled default Z value.",
          );
        }
        value.push(info.zDefault);
      }
      if (
        value.length !== (info.hasZ ? 3 : 2) ||
        !value.every((n) => typeof n === "number" && Number.isFinite(n))
      )
        throw new Error("Geometry dimensions do not match the ArcGIS layer.");
    } else value.forEach(check);
  };
  if (geometry.type === "GeometryCollection")
    throw new Error("Geometry collections are not supported.");
  check(geometry.coordinates);
  const spatialReference = { wkid: 4326 };
  switch (geometry.type) {
    case "Point":
      return {
        x: geometry.coordinates[0],
        y: geometry.coordinates[1],
        ...(info.hasZ ? { z: geometry.coordinates[2] } : {}),
        spatialReference,
      };
    case "MultiPoint":
      return { points: geometry.coordinates, hasZ: Boolean(info.hasZ), spatialReference };
    case "LineString":
      return { paths: [geometry.coordinates], hasZ: Boolean(info.hasZ), spatialReference };
    case "MultiLineString":
      return { paths: geometry.coordinates, hasZ: Boolean(info.hasZ), spatialReference };
    case "Polygon":
      return {
        rings: geometry.coordinates.map((r, i) => orient(r, i === 0)),
        hasZ: Boolean(info.hasZ),
        spatialReference,
      };
    case "MultiPolygon":
      return {
        rings: geometry.coordinates.flatMap((p) => p.map((r, i) => orient(r, i === 0))),
        hasZ: Boolean(info.hasZ),
        spatialReference,
      };
  }
}

function attributes(
  feature: Feature,
  previous: Feature | undefined,
  info: ArcGISEditInfo,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const fields = new Map(info.fields?.map((f) => [f.name, f]));
  // Domains follow the record's own (possibly just edited) type or subtype.
  const candidate = feature.properties ?? {};
  for (const name of new Set([
    ...Object.keys(feature.properties ?? {}),
    ...Object.keys(previous?.properties ?? {}),
  ])) {
    if (name === info.objectIdField) continue;
    const value = feature.properties?.[name];
    if (previous && same(value, previous.properties?.[name])) continue;
    const field = fields.get(name);
    if (
      !field ||
      field.editable === false ||
      ["esriFieldTypeOID", "esriFieldTypeGlobalID", "esriFieldTypeGeometry"].includes(field.type)
    ) {
      if (!previous && field) continue; // Server-managed values on new features are assigned by ArcGIS.
      throw new Error(`Field ${name} is not writable in this ArcGIS layer.`);
    }
    let normalized = value ?? null;
    if (normalized === null && field.nullable === false)
      throw new Error(`Field ${name} cannot be null.`);
    if (normalized !== null) {
      if (
        [
          "esriFieldTypeInteger",
          "esriFieldTypeSmallInteger",
          "esriFieldTypeBigInteger",
          "esriFieldTypeSingle",
          "esriFieldTypeDouble",
          "esriFieldTypeDate",
        ].includes(field.type)
      ) {
        if (field.type === "esriFieldTypeDate" && typeof normalized === "string")
          normalized = Date.parse(normalized);
        // A value typed into a column that held no numbers can arrive as text.
        // Only plain decimals convert; "0x1A" or "1e3" stay text and are rejected.
        else if (typeof normalized === "string" && DECIMAL_TEXT.test(normalized))
          normalized = Number(normalized);
        if (typeof normalized !== "number" || !Number.isFinite(normalized))
          throw new Error(`Field ${name} requires a number or valid date.`);
        if (
          ["esriFieldTypeInteger", "esriFieldTypeSmallInteger", "esriFieldTypeBigInteger"].includes(
            field.type,
          ) &&
          !Number.isSafeInteger(normalized)
        )
          throw new Error(`Field ${name} requires an integer.`);
      } else if (typeof normalized !== "string") throw new Error(`Field ${name} requires text.`);
      if (typeof normalized === "string" && field.length && normalized.length > field.length)
        throw new Error(`Field ${name} exceeds its maximum length.`);
      const error = arcGISDomainError(
        name,
        normalized,
        resolveArcGISFieldDomain(info, name, candidate),
      );
      if (error) throw new Error(error);
    }
    result[name] = normalized;
  }
  // A changed type or subtype revalidates every field whose domain it governs,
  // including values the edit did not touch: they are never cleared or
  // replaced, but must be corrected before the change can be saved.
  const selector = arcGISSubtypeField(info);
  if (previous && selector && !same(candidate[selector], previous.properties?.[selector])) {
    for (const field of info.fields ?? []) {
      if (field.name === selector || Object.hasOwn(result, field.name)) continue;
      // A value the user cannot write cannot be corrected, so it cannot block the save.
      if (field.editable === false || field.name === info.objectIdField) continue;
      if (!Object.hasOwn(candidate, field.name)) continue;
      const error = arcGISDomainError(
        field.name,
        candidate[field.name],
        resolveArcGISFieldDomain(info, field.name, candidate),
      );
      if (error) throw new Error(`${error} It does not fit the new ${selector} value.`);
    }
  }
  return result;
}

const DECIMAL_TEXT = /^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/;

const M_AWARE_GEOMETRY_ERROR =
  "This ArcGIS layer stores measure (M) values, which GeoLibre cannot edit. Attribute edits and deletions can be saved; add or reshape features in ArcGIS.";

export interface ArcGISEditPlan {
  adds: Array<{ feature: Feature; index: number; payload: unknown }>;
  updates: Array<{ feature: Feature; objectId: number; payload: unknown }>;
  deletes: number[];
}

/** Diff only the last downloaded snapshot. Missing viewport records are never part of this baseline. */
export function planArcGISEdits(
  baseline: FeatureCollection,
  current: FeatureCollection,
  info: ArcGISEditInfo,
): ArcGISEditPlan {
  const field = info.objectIdField;
  if (!field) throw new Error("ArcGIS layer has no object ID field.");
  const previous = new Map<number, Feature>();
  const byFeatureId = new Map(
    baseline.features.filter((f) => f.id !== undefined).map((f) => [f.id!, f]),
  );
  for (const feature of baseline.features) {
    const id = arcGISObjectId(feature, field);
    if (id === undefined)
      throw new Error(
        `A downloaded ArcGIS record has no ${field} value. Check that the service returns its object ID field, then reload the layer.`,
      );
    if (previous.has(id))
      throw new Error(`ArcGIS returned ${field} ${id} more than once. Reload the layer.`);
    previous.set(id, feature);
  }
  const plan: ArcGISEditPlan = { adds: [], updates: [], deletes: [] };
  const seen = new Set<number>();
  current.features.forEach((feature, index) => {
    const id = arcGISObjectId(feature, field);
    if (id === undefined) {
      // An existing feature's object ID must not be cleared to turn an update into an insert.
      if (feature.id !== undefined && byFeatureId.has(feature.id))
        throw new Error("ArcGIS object IDs cannot be changed or removed.");
      plan.adds.push({
        feature,
        index,
        payload: {
          attributes: attributes(feature, undefined, info),
          geometry: arcGISGeometry(feature.geometry, info),
        },
      });
      return;
    }
    const original = feature.id === undefined ? undefined : byFeatureId.get(feature.id);
    if (!original || arcGISObjectId(original, field) !== id)
      throw new Error("ArcGIS object IDs cannot be changed.");
    if (seen.has(id) || !previous.has(id))
      throw new Error("ArcGIS object IDs cannot be changed or duplicated.");
    seen.add(id);
    const prior = previous.get(id)!;
    if (sameArcGISFeature(feature, prior)) return;
    const geometryChanged = !same(feature.geometry, prior.geometry);
    if (geometryChanged && info.allowGeometryUpdates === false)
      throw new Error("This ArcGIS layer does not allow geometry updates.");
    if (geometryChanged && info.hasM) throw new Error(M_AWARE_GEOMETRY_ERROR);
    if (geometryChanged && info.geometryGeneralized)
      throw new Error(
        "This layer's shapes are simplified at the current zoom. Zoom in to edit their geometry.",
      );
    plan.updates.push({
      feature,
      objectId: id,
      payload: {
        attributes: { ...attributes(feature, prior, info), [field]: id },
        ...(geometryChanged ? { geometry: arcGISGeometry(feature.geometry, info) } : {}),
      },
    });
  });
  plan.deletes = [...previous.keys()].filter((id) => !seen.has(id));
  if (plan.adds.length && info.hasM) throw new Error(M_AWARE_GEOMETRY_ERROR);
  const caps = arcGISEditCapabilities(info);
  if (
    (plan.adds.length && !caps.create) ||
    (plan.updates.length && !caps.update) ||
    (plan.deletes.length && !caps.delete)
  )
    throw new Error("The ArcGIS service does not allow one or more requested edit operations.");
  return plan;
}
