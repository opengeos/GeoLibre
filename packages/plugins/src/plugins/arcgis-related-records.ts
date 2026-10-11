/**
 * Related records of an ArcGIS feature layer: the rows a published
 * relationship class links to a record, such as a hydrant's inspections.
 *
 * Relationships come from the metadata the layer already holds; nothing is
 * inferred from names. Records are read with `queryRelatedRecords` and written
 * with the related table's own `applyEdits`, validated against that table's
 * own fields, domains and defaults. Each write goes straight to the service
 * and is read back afterwards; none of them joins the pending feature edits.
 * The requests reuse the layer's live connection, so nothing here is written
 * to a project.
 */
import type { Feature } from "geojson";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  ARCGIS_FEATURE_SOURCE_KIND,
  arcGISNewFeatureProperties,
  arcGISServerManagedFields,
} from "./arcgis-defaults";
import { resolveArcGISFieldDomain, type ArcGISCodedValue } from "./arcgis-domains";
import {
  arcGISEditAttributes,
  arcGISEditCapabilities,
  arcGISObjectId,
  type ArcGISEditInfo,
} from "./arcgis-edits";
import { arcGISFeatureLayerConnection, type ArcGISFeatureLayerConnection } from "./arcgis-layer";
import {
  arcGISServiceError,
  postArcGISWrite,
  readArcGISJson,
  withQuery,
  type ArcGISOperationMessages,
  type ArcGISServiceError,
} from "./arcgis-service-request";
import { LocalizedError } from "../localized-error";

const ERROR_KEY = "arcgisService.errors";

const MESSAGES: ArcGISOperationMessages = {
  signInRequired: () =>
    new LocalizedError(
      `${ERROR_KEY}.relatedSignInRequired`,
      "The ArcGIS service requires a valid sign-in for related records. Sign in again and retry.",
    ),
  notPermitted: () =>
    new LocalizedError(
      `${ERROR_KEY}.relatedNotPermitted`,
      "You do not have permission for this related record operation on the ArcGIS service.",
    ),
  invalidResponse: () =>
    new LocalizedError(
      `${ERROR_KEY}.relatedInvalidResponse`,
      "The ArcGIS service returned an unexpected related records response.",
    ),
  unconfirmed: (cause) =>
    new LocalizedError(
      `${ERROR_KEY}.relatedUnconfirmed`,
      "The related record change could not be confirmed. Refresh the related records before trying again.",
      undefined,
      cause ? { cause } : undefined,
    ),
};

/** Pages read before a related history is reported incomplete. */
const MAX_RELATED_PAGES = 50;
/** Rows per page when the service does not state its own limit. */
const DEFAULT_RELATED_PAGE_SIZE = 1000;

/** One relationship a layer publishes, from the layer's side. */
export interface ArcGISRelationship {
  /** The relationship ID, as `queryRelatedRecords` takes it. */
  id: number;
  name: string;
  /** The layer or table at the other end, in the same service. */
  relatedTableId: number;
  cardinality: "oneToOne" | "oneToMany" | "manyToMany" | "unknown";
  /** Whether this layer is the origin (parent) or the destination (child). */
  role: "origin" | "destination" | "unknown";
  /** This layer's key field in the relationship. */
  keyField?: string;
  composite: boolean;
  /** Set for attributed and many-to-many relationships, which use an intermediate table. */
  relationshipTableId?: number;
}

/** The metadata of the layer or table at the other end of a relationship. */
export interface ArcGISRelatedTableInfo extends ArcGISEditInfo {
  name?: string;
  /** `"Table"` for a nonspatial table, `"Feature Layer"` for a layer. */
  type?: string;
  relationships?: unknown;
  maxRecordCount?: number;
}

/** A related row: its service object ID and attributes as the service stores them. */
export interface ArcGISRelatedRecord {
  objectId: number;
  attributes: Record<string, unknown>;
}

/** The related rows of one record, and whether the service returned all of them. */
export interface ArcGISRelatedRecords {
  records: ArcGISRelatedRecord[];
  /** False when the service capped the result and cannot page through the rest. */
  complete: boolean;
}

/** Which related-record writes a relationship allows, before the server checks the user. */
export interface ArcGISRelatedEditSupport {
  add: boolean;
  update: boolean;
  delete: boolean;
  /** The related table's field holding the parent key, which this workflow manages. */
  foreignKeyField?: string;
}

interface ArcGISRelationshipLayerInfo extends ArcGISEditInfo {
  relationships?: unknown;
  advancedQueryCapabilities?: { supportsQueryRelatedPagination?: boolean };
}

const CARDINALITIES: Record<string, ArcGISRelationship["cardinality"]> = {
  esrirelcardinalityonetoone: "oneToOne",
  esrirelcardinalityonetomany: "oneToMany",
  esrirelcardinalitymanytomany: "manyToMany",
};
const ROLES: Record<string, ArcGISRelationship["role"]> = {
  esrirelroleorigin: "origin",
  esrireldestination: "destination",
  esrirelroledestination: "destination",
};

/** Parse a metadata `relationships[]` array, keeping only entries with usable IDs. */
function parseRelationships(value: unknown): ArcGISRelationship[] {
  if (!Array.isArray(value)) return [];
  const result: ArcGISRelationship[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const rel = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(rel.id) || !Number.isSafeInteger(rel.relatedTableId)) continue;
    const id = rel.id as number;
    result.push({
      id,
      name: typeof rel.name === "string" && rel.name.trim() ? rel.name : String(id),
      relatedTableId: rel.relatedTableId as number,
      cardinality: CARDINALITIES[String(rel.cardinality).toLowerCase()] ?? "unknown",
      role: ROLES[String(rel.role).toLowerCase()] ?? "unknown",
      ...(typeof rel.keyField === "string" && rel.keyField ? { keyField: rel.keyField } : {}),
      composite: rel.composite === true,
      ...(Number.isSafeInteger(rel.relationshipTableId)
        ? { relationshipTableId: rel.relationshipTableId as number }
        : {}),
    });
  }
  return result;
}

function layerInfo(layer: GeoLibreLayer): ArcGISRelationshipLayerInfo | undefined {
  return layer.metadata.arcgisEditInfo as ArcGISRelationshipLayerInfo | undefined;
}

function isFeatureServer(layer: GeoLibreLayer): boolean {
  const url = layer.source.arcgisQueryUrl;
  return typeof url === "string" && /\/FeatureServer\/\d+\/query\/?$/i.test(url);
}

/**
 * The relationships an ArcGIS feature layer publishes, read from the metadata
 * it already holds.
 *
 * @param layer - Any layer.
 * @returns The relationships, empty for layers that publish none or cannot be queried.
 */
export function arcGISRelationships(layer: GeoLibreLayer | null | undefined): ArcGISRelationship[] {
  if (layer?.metadata.sourceKind !== ARCGIS_FEATURE_SOURCE_KIND) return [];
  const url = layer.source.arcgisQueryUrl;
  if (typeof url !== "string" || !/\/(FeatureServer|MapServer)\/\d+\/query\/?$/i.test(url))
    return [];
  if (layer.capabilities?.query === false) return [];
  const info = layerInfo(layer);
  if (!info?.objectIdField) return [];
  return parseRelationships(info.relationships);
}

/**
 * The service object ID of a feature, which related records are queried by.
 *
 * @param layer - The ArcGIS feature layer holding the feature.
 * @param feature - A feature of that layer.
 * @returns The object ID, or `undefined` for a feature not yet saved to the service.
 */
export function arcGISRelatedParentObjectId(
  layer: GeoLibreLayer,
  feature: Feature | null | undefined,
): number | undefined {
  const field = layerInfo(layer)?.objectIdField;
  if (!field || !feature) return undefined;
  try {
    return arcGISObjectId(feature, field);
  } catch {
    return undefined;
  }
}

/** A field name as `fields[]` spells it; ArcGIS field names are case-insensitive. */
function fieldName(info: ArcGISEditInfo, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  return info.fields?.find((field) => field.name.toLowerCase() === lower)?.name;
}

/** A record's value for a field, matching the name case-insensitively. */
function valueOf(properties: Record<string, unknown> | null | undefined, name: string): unknown {
  if (!properties) return undefined;
  if (Object.hasOwn(properties, name)) return properties[name];
  const lower = name.toLowerCase();
  const key = Object.keys(properties).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : properties[key];
}

/**
 * The related-record writes a relationship allows from this layer's side.
 *
 * Writes need this layer to be the origin of a one-to-one or one-to-many
 * relationship without an intermediate table, both ends on a FeatureServer,
 * and the related resource to advertise the edit and to name the foreign key
 * in its own `relationships[]` entry. Adding is limited to nonspatial tables,
 * since a related feature would need a geometry this workflow does not draw.
 * The layer's GeoLibre permissions can withhold writes, and the server still
 * decides for the signed-in user.
 *
 * @param layer - The parent ArcGIS feature layer.
 * @param relationship - One of {@link arcGISRelationships}.
 * @param related - The related resource's metadata.
 * @returns The allowed writes and the managed foreign key field.
 */
export function arcGISRelatedEditSupport(
  layer: GeoLibreLayer,
  relationship: ArcGISRelationship,
  related: ArcGISRelatedTableInfo,
): ArcGISRelatedEditSupport {
  const none = { add: false, update: false, delete: false };
  if (
    !isFeatureServer(layer) ||
    relationship.role !== "origin" ||
    (relationship.cardinality !== "oneToOne" && relationship.cardinality !== "oneToMany") ||
    relationship.relationshipTableId !== undefined
  )
    return none;
  const info = layerInfo(layer);
  const parentKey = info && fieldName(info, relationship.keyField);
  const reverse = parseRelationships(related.relationships).find(
    (entry) => entry.id === relationship.id && entry.role === "destination",
  );
  const foreignKeyField = fieldName(related, reverse?.keyField);
  if (!parentKey || !foreignKeyField) return none;
  const caps = arcGISEditCapabilities(related);
  const foreignKey = related.fields?.find((field) => field.name === foreignKeyField);
  const table = !related.geometryType;
  return {
    add:
      caps.create &&
      table &&
      foreignKey?.editable !== false &&
      layer.capabilities?.create !== false,
    update: caps.update && layer.capabilities?.update !== false,
    delete: caps.delete && layer.capabilities?.delete !== false,
    foreignKeyField,
  };
}

/**
 * The parent's value for the relationship key, which a new related record's
 * foreign key takes. It comes from the published key field, which may be a
 * global ID or any other field, never from the object ID by assumption.
 *
 * @param layer - The parent ArcGIS feature layer.
 * @param relationship - The relationship, from this layer's side.
 * @param parent - The selected parent feature.
 * @returns The key value, or `undefined` when the parent does not carry it.
 */
export function arcGISRelatedParentKey(
  layer: GeoLibreLayer,
  relationship: ArcGISRelationship,
  parent: Feature | null | undefined,
): string | number | undefined {
  const info = layerInfo(layer);
  const name = info && fieldName(info, relationship.keyField);
  if (!name || !parent) return undefined;
  const value = valueOf(parent.properties, name);
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/** How a related field is shown and entered. */
export interface ArcGISRelatedField {
  name: string;
  /** The field's alias, or its name. */
  label: string;
  kind: "text" | "integer" | "number" | "date" | "other";
  /** Whether the user may enter a value: not server-managed and not the foreign key. */
  editable: boolean;
  /** Set on the foreign key, whose value the relationship manages. */
  managedKey?: boolean;
  required: boolean;
  maxLength?: number;
  /** A coded-value domain, resolved for the row's own type or subtype. */
  codedValues?: ArcGISCodedValue[];
  min?: number;
  max?: number;
}

const INTEGER_FIELD_TYPES = new Set([
  "esriFieldTypeInteger",
  "esriFieldTypeSmallInteger",
  "esriFieldTypeBigInteger",
]);

/**
 * The related table's fields as a row editor shows them, following the
 * related table's own metadata: its aliases, nullability, lengths, and the
 * coded-value and range domains that apply to the row's type or subtype.
 * Server-managed fields and the managed foreign key are read-only. Geometry
 * and blob fields are left out.
 *
 * @param related - The related table's metadata.
 * @param support - The relationship's {@link arcGISRelatedEditSupport}.
 * @param values - The row being shown or edited, including unsaved values.
 * @returns The fields, in the table's order.
 */
export function arcGISRelatedFields(
  related: ArcGISRelatedTableInfo,
  support: Pick<ArcGISRelatedEditSupport, "foreignKeyField">,
  values: Record<string, unknown> | null | undefined,
): ArcGISRelatedField[] {
  const managed = arcGISServerManagedFields(related);
  const result: ArcGISRelatedField[] = [];
  for (const field of related.fields ?? []) {
    if (["esriFieldTypeGeometry", "esriFieldTypeBlob", "esriFieldTypeRaster"].includes(field.type))
      continue;
    const managedKey = field.name === support.foreignKeyField;
    const kind: ArcGISRelatedField["kind"] = INTEGER_FIELD_TYPES.has(field.type)
      ? "integer"
      : field.type === "esriFieldTypeSingle" || field.type === "esriFieldTypeDouble"
        ? "number"
        : field.type === "esriFieldTypeDate"
          ? "date"
          : field.type === "esriFieldTypeString" || field.type === "esriFieldTypeGUID"
            ? "text"
            : "other";
    const domain = resolveArcGISFieldDomain(related, field.name, values);
    result.push({
      name: field.name,
      label: field.alias?.trim() || field.name,
      kind,
      editable: !managed.has(field.name.toLowerCase()) && !managedKey && kind !== "other",
      ...(managedKey ? { managedKey: true } : {}),
      required: field.nullable === false,
      ...(field.type === "esriFieldTypeString" && field.length ? { maxLength: field.length } : {}),
      ...(domain.kind === "codedValue" ? { codedValues: domain.codedValues } : {}),
      ...(domain.kind === "range" ? { min: domain.min, max: domain.max } : {}),
    });
  }
  return result;
}

/**
 * The values a new related row starts with: the related table's creation
 * defaults (template, subtype and field defaults), without server-managed
 * fields or the managed foreign key. {@link addArcGISRelatedRecord} applies the
 * same defaults, so a form can show them before anything is saved.
 *
 * @param related - The related table's metadata.
 * @param support - The relationship's {@link arcGISRelatedEditSupport}.
 * @returns The starting attributes.
 */
export function arcGISRelatedNewRecordDefaults(
  related: ArcGISRelatedTableInfo,
  support: Pick<ArcGISRelatedEditSupport, "foreignKeyField">,
): Record<string, unknown> {
  const values = arcGISNewFeatureProperties(related, {});
  const key = support.foreignKeyField?.toLowerCase();
  for (const name of Object.keys(values)) if (name.toLowerCase() === key) delete values[name];
  return values;
}

async function connect(layerId: string): Promise<ArcGISFeatureLayerConnection> {
  const connection = await arcGISFeatureLayerConnection(layerId);
  if (!connection) {
    throw new LocalizedError(`${ERROR_KEY}.missingServiceUrl`, "Missing ArcGIS service URL.");
  }
  return connection;
}

/** The related resource's URL: the same service, the relationship's table ID. */
function relatedUrl(connection: ArcGISFeatureLayerConnection, relatedTableId: number): string {
  if (!Number.isSafeInteger(relatedTableId) || relatedTableId < 0) {
    throw new Error(`Invalid ArcGIS table ID: ${relatedTableId}.`);
  }
  return `${connection.layerUrl.replace(/\/\d+$/, "")}/${relatedTableId}`;
}

function serviceError(error: ArcGISServiceError | undefined, fallback: string): Error {
  return arcGISServiceError(error, fallback, MESSAGES);
}

/**
 * Read the metadata of the layer or table a relationship points to.
 *
 * @param layerId - The parent ArcGIS feature layer.
 * @param relationship - The relationship to follow.
 * @param signal - Aborts the request.
 * @returns The related resource's metadata.
 */
export async function fetchArcGISRelatedTableInfo(
  layerId: string,
  relationship: Pick<ArcGISRelationship, "relatedTableId">,
  signal?: AbortSignal,
): Promise<ArcGISRelatedTableInfo> {
  const connection = await connect(layerId);
  const url = withQuery(relatedUrl(connection, relationship.relatedTableId), {
    f: "json",
    token: connection.token,
  });
  const json = await readArcGISJson<ArcGISRelatedTableInfo>(
    await connection.fetch(url, { signal }),
    MESSAGES,
  );
  if (json.error) {
    const error = serviceError(json.error, "");
    if (error instanceof LocalizedError) throw error;
    throw new LocalizedError(
      `${ERROR_KEY}.relatedUnavailable`,
      "The related table {{id}} is not available from this service. Check that it is published in the same service and shared with you.",
      { id: relationship.relatedTableId },
    );
  }
  if (!json.objectIdField || !Array.isArray(json.fields)) throw MESSAGES.invalidResponse();
  return json;
}

interface RelatedRecordsResponse {
  relatedRecordGroups?: unknown;
  exceededTransferLimit?: boolean;
}

/**
 * Read the related rows of one record.
 *
 * Every row must belong to the requested record and carry its own object ID;
 * anything else is rejected rather than shown under the wrong parent. When the
 * layer supports related-record pagination the rows are paged through in
 * object ID order, otherwise a capped result is reported as incomplete.
 *
 * @param layerId - The parent ArcGIS feature layer.
 * @param objectId - The parent record's service object ID.
 * @param relationship - The relationship to follow.
 * @param related - The related resource's metadata.
 * @param signal - Aborts the request, for example when the selection changes.
 * @returns The related rows and whether they are complete.
 */
export async function queryArcGISRelatedRecords(
  layerId: string,
  objectId: number,
  relationship: Pick<ArcGISRelationship, "id">,
  related: ArcGISRelatedTableInfo,
  signal?: AbortSignal,
): Promise<ArcGISRelatedRecords> {
  if (!Number.isSafeInteger(objectId) || objectId < 0) {
    throw new Error(`Invalid ArcGIS object ID: ${objectId}.`);
  }
  const relatedOid = related.objectIdField;
  if (!relatedOid) throw MESSAGES.invalidResponse();
  const connection = await connect(layerId);
  const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
  const paged =
    (layer && layerInfo(layer)?.advancedQueryCapabilities?.supportsQueryRelatedPagination) === true;
  const pageSize =
    Number.isSafeInteger(related.maxRecordCount) && (related.maxRecordCount as number) > 0
      ? (related.maxRecordCount as number)
      : DEFAULT_RELATED_PAGE_SIZE;
  const records: ArcGISRelatedRecord[] = [];
  const seen = new Set<number>();
  // The server may cap a page below the size asked for, so the next page
  // starts after the rows actually received, never at a fixed stride.
  let offset = 0;
  for (let page = 0; page < (paged ? MAX_RELATED_PAGES : 1); page++) {
    const url = withQuery(`${connection.layerUrl}/queryRelatedRecords`, {
      f: "json",
      objectIds: String(objectId),
      relationshipId: String(relationship.id),
      outFields: "*",
      returnGeometry: "false",
      ...(paged
        ? {
            orderByFields: `${relatedOid} ASC`,
            resultOffset: String(offset),
            resultRecordCount: String(pageSize),
          }
        : {}),
      token: connection.token,
    });
    const json = await readArcGISJson<RelatedRecordsResponse>(
      await connection.fetch(url, { signal }),
      MESSAGES,
    );
    if (json.error) throw serviceError(json.error, "ArcGIS could not read the related records.");
    if (!Array.isArray(json.relatedRecordGroups)) throw MESSAGES.invalidResponse();
    let received = 0;
    for (const group of json.relatedRecordGroups as Array<Record<string, unknown>>) {
      if (group?.objectId !== objectId || !Array.isArray(group.relatedRecords))
        throw MESSAGES.invalidResponse();
      for (const row of group.relatedRecords as Array<Record<string, unknown>>) {
        const attributes = row?.attributes;
        if (!attributes || typeof attributes !== "object") throw MESSAGES.invalidResponse();
        const id = valueOf(attributes as Record<string, unknown>, relatedOid);
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0)
          throw MESSAGES.invalidResponse();
        received++;
        // Overlapping pages can repeat a row; the first copy is kept.
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({ objectId: id, attributes: { ...(attributes as Record<string, unknown>) } });
      }
    }
    if (!json.exceededTransferLimit) return { records, complete: true };
    // A capped page without rows cannot advance; report what was read.
    if (!received) break;
    offset += received;
  }
  return { records, complete: false };
}

interface ArcGISEditResult {
  objectId?: unknown;
  success?: boolean;
  error?: ArcGISServiceError;
}

interface ApplyEditsResponse {
  addResults?: unknown;
  updateResults?: unknown;
  deleteResults?: unknown;
}

/** Send one edit to the related resource's `applyEdits` and return its single result. */
async function applyRelatedEdit(
  layerId: string,
  relationship: Pick<ArcGISRelationship, "relatedTableId">,
  kind: "adds" | "updates" | "deletes",
  value: unknown,
  signal?: AbortSignal,
): Promise<ArcGISEditResult> {
  const connection = await connect(layerId);
  const body = new URLSearchParams({
    f: "json",
    [kind]: typeof value === "string" ? value : JSON.stringify(value),
    rollbackOnFailure: "true",
  });
  if (connection.token) body.set("token", connection.token);
  const json = await postArcGISWrite<ApplyEditsResponse>(
    connection,
    `${relatedUrl(connection, relationship.relatedTableId)}/applyEdits`,
    body,
    MESSAGES,
    signal,
  );
  if (json.error) throw serviceError(json.error, "ArcGIS rejected the related record edit.");
  const results =
    kind === "adds"
      ? json.addResults
      : kind === "updates"
        ? json.updateResults
        : json.deleteResults;
  const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
  // A reply without the one result asked for leaves the outcome open.
  if (!result || typeof result !== "object" || typeof result.success !== "boolean")
    throw MESSAGES.unconfirmed();
  if (!result.success) throw serviceError(result.error, "ArcGIS rejected the related record edit.");
  return result as ArcGISEditResult;
}

function asFeature(properties: Record<string, unknown>): Pick<Feature, "properties"> {
  return { properties };
}

/**
 * Add a related row to a parent already saved to the service.
 *
 * The row starts from the related table's own creation defaults, then takes
 * the values given; its foreign key is set from the parent's published key
 * and cannot be overridden. Values are validated against the related table's
 * fields and domains before anything is sent.
 *
 * @param layerId - The parent ArcGIS feature layer.
 * @param relationship - The relationship, from the parent's side.
 * @param related - The related table's metadata.
 * @param support - The relationship's {@link arcGISRelatedEditSupport}.
 * @param parentKey - The parent's {@link arcGISRelatedParentKey}.
 * @param values - The new row's attributes.
 * @param signal - Aborts the request; aborting in flight is unconfirmed.
 * @returns The new row's service object ID.
 */
export async function addArcGISRelatedRecord(
  layerId: string,
  relationship: Pick<ArcGISRelationship, "relatedTableId">,
  related: ArcGISRelatedTableInfo,
  support: ArcGISRelatedEditSupport,
  parentKey: string | number,
  values: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<number> {
  const foreignKey = support.foreignKeyField;
  if (!support.add || !foreignKey) {
    throw new LocalizedError(
      `${ERROR_KEY}.relatedEditNotSupported`,
      "This relationship does not allow that related record edit.",
    );
  }
  const properties = arcGISNewFeatureProperties(related, values);
  for (const key of Object.keys(properties))
    if (key.toLowerCase() === foreignKey.toLowerCase()) delete properties[key];
  properties[foreignKey] = parentKey;
  const attributes = arcGISEditAttributes(asFeature(properties), undefined, related);
  const result = await applyRelatedEdit(layerId, relationship, "adds", [{ attributes }], signal);
  // Success without the new row's ID is not a confirmed insert.
  if (typeof result.objectId !== "number" || !Number.isSafeInteger(result.objectId))
    throw MESSAGES.unconfirmed();
  return result.objectId;
}

/**
 * Update a related row, sending only the attributes that changed.
 *
 * The foreign key is managed by this workflow, so an edit that would move the
 * row to another parent is refused. A value the user did not change is not
 * checked, so rows holding historical values can still be edited.
 *
 * @param layerId - The parent ArcGIS feature layer.
 * @param relationship - The relationship, from the parent's side.
 * @param related - The related table's metadata.
 * @param support - The relationship's {@link arcGISRelatedEditSupport}.
 * @param record - The row as last read from the service.
 * @param values - The edited attributes.
 * @param signal - Aborts the request; aborting in flight is unconfirmed.
 * @returns Whether anything was sent: `false` when no attribute changed.
 */
export async function updateArcGISRelatedRecord(
  layerId: string,
  relationship: Pick<ArcGISRelationship, "relatedTableId">,
  related: ArcGISRelatedTableInfo,
  support: ArcGISRelatedEditSupport,
  record: ArcGISRelatedRecord,
  values: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<boolean> {
  const oid = related.objectIdField;
  if (!support.update || !oid) {
    throw new LocalizedError(
      `${ERROR_KEY}.relatedEditNotSupported`,
      "This relationship does not allow that related record edit.",
    );
  }
  const foreignKey = support.foreignKeyField;
  const next = { ...record.attributes, ...values };
  if (
    foreignKey &&
    JSON.stringify(valueOf(next, foreignKey)) !==
      JSON.stringify(valueOf(record.attributes, foreignKey))
  ) {
    throw new LocalizedError(
      `${ERROR_KEY}.relatedKeyManaged`,
      "The relationship key of a related record cannot be changed here.",
    );
  }
  const attributes = arcGISEditAttributes(asFeature(next), asFeature(record.attributes), related);
  if (!Object.keys(attributes).length) return false;
  await applyRelatedEdit(
    layerId,
    relationship,
    "updates",
    [{ attributes: { ...attributes, [oid]: record.objectId } }],
    signal,
  );
  return true;
}

/**
 * Delete one related row. The service applies any composite-relationship
 * behavior; nothing is cascaded here.
 *
 * @param layerId - The parent ArcGIS feature layer.
 * @param relationship - The relationship, from the parent's side.
 * @param support - The relationship's {@link arcGISRelatedEditSupport}.
 * @param objectId - The related row's service object ID.
 */
export async function deleteArcGISRelatedRecord(
  layerId: string,
  relationship: Pick<ArcGISRelationship, "relatedTableId">,
  support: ArcGISRelatedEditSupport,
  objectId: number,
): Promise<void> {
  if (!support.delete) {
    throw new LocalizedError(
      `${ERROR_KEY}.relatedEditNotSupported`,
      "This relationship does not allow that related record edit.",
    );
  }
  if (!Number.isSafeInteger(objectId) || objectId < 0) {
    throw new Error(`Invalid ArcGIS object ID: ${objectId}.`);
  }
  await applyRelatedEdit(layerId, relationship, "deletes", String(objectId));
}
