/**
 * Attachments of records in an ArcGIS feature layer: the photos, PDFs and other
 * files a service stores against a record, addressed by the layer, the record's
 * object ID and the attachment ID.
 *
 * Each operation goes straight to the service and reports its own outcome; none
 * of them joins the pending edits that Save edits to ArcGIS service sends. The
 * requests reuse the layer's live connection (its token provider and, on
 * desktop, the native transport), so nothing here is written to a project.
 */
import type { Feature } from "geojson";
import type { GeoLibreLayer } from "@geolibre/core";
import { ARCGIS_FEATURE_SOURCE_KIND } from "./arcgis-defaults";
import { arcGISObjectId, type ArcGISEditInfo } from "./arcgis-edits";
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

/** One file attached to a record, as the service lists it. */
export interface ArcGISAttachmentInfo {
  /** The attachment ID, unique within the layer. */
  id: number;
  /** The stored file name. Not an identifier: names may repeat. */
  name: string;
  contentType: string;
  /** Size in bytes. */
  size: number;
  globalId?: string;
  keywords?: string;
}

/** Which attachment operations a layer offers, before the server checks the user. */
export interface ArcGISAttachmentSupport {
  list: boolean;
  add: boolean;
  update: boolean;
  delete: boolean;
}

export interface ArcGISAttachmentLayerInfo extends ArcGISEditInfo {
  hasAttachments?: boolean;
}

const ERROR_KEY = "arcgisService.errors";

const MESSAGES: ArcGISOperationMessages = {
  signInRequired: () =>
    new LocalizedError(
      `${ERROR_KEY}.attachmentSignInRequired`,
      "The ArcGIS service requires a valid sign-in for this attachment operation. Sign in again and retry.",
    ),
  notPermitted: () =>
    new LocalizedError(
      `${ERROR_KEY}.attachmentNotPermitted`,
      "You do not have permission for this attachment operation on the ArcGIS service.",
    ),
  invalidResponse: () =>
    new LocalizedError(
      `${ERROR_KEY}.attachmentInvalidResponse`,
      "The ArcGIS service returned an unexpected attachment response.",
    ),
  unconfirmed: (cause) =>
    new LocalizedError(
      `${ERROR_KEY}.attachmentUnconfirmed`,
      "The attachment change could not be confirmed. Refresh the attachment list before trying again.",
      undefined,
      cause ? { cause } : undefined,
    ),
};

/**
 * The attachment operations a layer's metadata advertises.
 *
 * Esri allows adding an attachment with the Create or Update capability, and
 * replacing or deleting one with Update (not Delete). Writes also follow the
 * feature editing rules: versioned layers stay read-only, and the layer's
 * GeoLibre permissions can withhold them. Advertised operations are only an
 * upper bound; the server still decides for the signed-in user.
 *
 * @param layer - Any layer.
 * @returns The supported operations, or `undefined` when the layer has no attachments.
 */
export function arcGISAttachmentSupport(
  layer: GeoLibreLayer | null | undefined,
): ArcGISAttachmentSupport | undefined {
  if (layer?.metadata.sourceKind !== ARCGIS_FEATURE_SOURCE_KIND) return undefined;
  return supportFor(layer, layer.metadata.arcgisEditInfo as ArcGISAttachmentLayerInfo | undefined);
}

/**
 * The attachment operations a table related to an ArcGIS feature layer
 * advertises, for its rows. The rules are those of
 * {@link arcGISAttachmentSupport}, read from the related table's own
 * metadata; the parent layer's GeoLibre permissions still apply, and writes
 * still need the service to be a FeatureServer.
 *
 * @param layer - The parent ArcGIS feature layer.
 * @param related - The related table's `?f=json` metadata.
 * @returns The supported operations, or `undefined` when the table has no attachments.
 */
export function arcGISRelatedAttachmentSupport(
  layer: GeoLibreLayer | null | undefined,
  related: ArcGISAttachmentLayerInfo | null | undefined,
): ArcGISAttachmentSupport | undefined {
  if (layer?.metadata.sourceKind !== ARCGIS_FEATURE_SOURCE_KIND) return undefined;
  return supportFor(layer, related ?? undefined);
}

function supportFor(
  layer: GeoLibreLayer,
  info: ArcGISAttachmentLayerInfo | undefined,
): ArcGISAttachmentSupport | undefined {
  if (typeof layer.source.arcgisQueryUrl !== "string") return undefined;
  if (!info?.hasAttachments || !info.objectIdField) return undefined;
  const caps = new Set(
    info.capabilities
      ?.toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  );
  // Writes need a FeatureServer: a MapServer layer advertising attachments
  // serves them read-only.
  const featureServer = /\/FeatureServer\/\d+\/query\/?$/i.test(layer.source.arcgisQueryUrl);
  const writable = featureServer && !info.isDataVersioned;
  const create = layer.capabilities?.create !== false && caps.has("create");
  const update = layer.capabilities?.update !== false && caps.has("update");
  return {
    // A layer that omits capabilities still answers queries.
    list: layer.capabilities?.query !== false && (!info.capabilities || caps.has("query")),
    add: writable && (create || update),
    update: writable && update,
    delete: writable && update,
  };
}

/**
 * The service object ID of a feature, which attachments are keyed by.
 *
 * @param layer - The ArcGIS feature layer holding the feature.
 * @param feature - A feature of that layer.
 * @returns The object ID, or `undefined` for a feature not yet saved to the service.
 */
export function arcGISAttachmentObjectId(
  layer: GeoLibreLayer,
  feature: Feature | null | undefined,
): number | undefined {
  const field = (layer.metadata.arcgisEditInfo as ArcGISEditInfo | undefined)?.objectIdField;
  if (!field || !feature) return undefined;
  try {
    return arcGISObjectId(feature, field);
  } catch {
    return undefined;
  }
}

/**
 * Whose attachments: an ArcGIS feature layer's own records (its layer ID), or
 * the rows of a table related to it in the same service, which use the
 * layer's connection.
 */
export type ArcGISAttachmentSource = string | { layerId: string; tableId: number };

async function connect(source: ArcGISAttachmentSource): Promise<ArcGISFeatureLayerConnection> {
  const layerId = typeof source === "string" ? source : source.layerId;
  const connection = await arcGISFeatureLayerConnection(layerId);
  if (!connection) {
    throw new LocalizedError(`${ERROR_KEY}.missingServiceUrl`, "Missing ArcGIS service URL.");
  }
  if (typeof source === "string") return connection;
  if (!Number.isSafeInteger(source.tableId) || source.tableId < 0) {
    throw new Error(`Invalid ArcGIS table ID: ${source.tableId}.`);
  }
  return {
    ...connection,
    layerUrl: `${connection.layerUrl.replace(/\/\d+$/, "")}/${source.tableId}`,
  };
}

function recordUrl(connection: ArcGISFeatureLayerConnection, objectId: number): string {
  if (!Number.isSafeInteger(objectId) || objectId < 0) {
    throw new Error(`Invalid ArcGIS object ID: ${objectId}.`);
  }
  return `${connection.layerUrl}/${objectId}`;
}

/** Turn a service error envelope into a message, distinguishing sign-in and permission refusals. */
function serviceError(error: ArcGISServiceError | undefined, fallback: string): Error {
  return arcGISServiceError(error, fallback, MESSAGES);
}

const readJson = <T>(response: Response) => readArcGISJson<T>(response, MESSAGES);

function parseAttachmentInfo(value: unknown): ArcGISAttachmentInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (!Number.isSafeInteger(entry.id)) return undefined;
  return {
    id: entry.id as number,
    name: typeof entry.name === "string" ? entry.name : String(entry.id),
    contentType:
      typeof entry.contentType === "string" && entry.contentType
        ? entry.contentType
        : "application/octet-stream",
    size: typeof entry.size === "number" && entry.size >= 0 ? entry.size : 0,
    ...(typeof entry.globalId === "string" ? { globalId: entry.globalId } : {}),
    ...(typeof entry.keywords === "string" && entry.keywords ? { keywords: entry.keywords } : {}),
  };
}

/**
 * List the files attached to one record.
 *
 * @param source - The ArcGIS feature layer, or a table related to it.
 * @param objectId - The record's service object ID.
 * @param signal - Aborts the request, for example when the selection changes.
 * @returns The record's attachments, in service order.
 */
export async function listArcGISAttachments(
  source: ArcGISAttachmentSource,
  objectId: number,
  signal?: AbortSignal,
): Promise<ArcGISAttachmentInfo[]> {
  const connection = await connect(source);
  const url = withQuery(`${recordUrl(connection, objectId)}/attachments`, {
    f: "json",
    token: connection.token,
  });
  const json = await readJson<{ attachmentInfos?: unknown }>(
    await connection.fetch(url, { signal }),
  );
  if (json.error) throw serviceError(json.error, "ArcGIS could not list the attachments.");
  if (!Array.isArray(json.attachmentInfos)) {
    throw MESSAGES.invalidResponse();
  }
  return json.attachmentInfos
    .map(parseAttachmentInfo)
    .filter((info): info is ArcGISAttachmentInfo => info !== undefined);
}

/**
 * Download one attachment's original bytes.
 *
 * An attachment that is itself JSON passes through untouched; for any other
 * type, a JSON body is the service reporting an error in place of the file.
 *
 * @param source - The ArcGIS feature layer, or a table related to it.
 * @param objectId - The record's service object ID.
 * @param attachment - The attachment, as listed.
 * @param signal - Aborts the transfer.
 * @returns The file, typed with the attachment's content type.
 */
export async function downloadArcGISAttachment(
  source: ArcGISAttachmentSource,
  objectId: number,
  attachment: Pick<ArcGISAttachmentInfo, "id" | "contentType">,
  signal?: AbortSignal,
): Promise<Blob> {
  const connection = await connect(source);
  const url = withQuery(`${recordUrl(connection, objectId)}/attachments/${attachment.id}`, {
    token: connection.token,
  });
  const response = await connection.fetch(url, { signal });
  if (!response.ok) {
    throw new LocalizedError(
      `${ERROR_KEY}.serviceRequestFailed`,
      "ArcGIS service request failed with {{status}}.",
      { status: response.status },
    );
  }
  const bytes = await response.arrayBuffer();
  const served = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  const expectsJson = /json/i.test(attachment.contentType);
  if (!expectsJson && served.includes("json")) {
    let error: ArcGISServiceError | undefined;
    try {
      error = (JSON.parse(new TextDecoder().decode(bytes)) as { error?: ArcGISServiceError }).error;
    } catch {
      error = undefined;
    }
    if (error) throw serviceError(error, "ArcGIS could not download the attachment.");
  }
  return new Blob([bytes], { type: attachment.contentType });
}

/** The service's word on a single attachment write. */
interface ArcGISAttachmentEditResult {
  objectId?: unknown;
  globalId?: string;
  success?: boolean;
  error?: ArcGISServiceError;
}

function postAttachmentWrite<T>(
  connection: ArcGISFeatureLayerConnection,
  url: string,
  body: FormData | URLSearchParams,
  signal?: AbortSignal,
) {
  return postArcGISWrite<T>(connection, url, body, MESSAGES, signal);
}

function uploadForm(file: Blob, fileName: string, token: string | undefined): FormData {
  const form = new FormData();
  form.set("f", "json");
  if (token) form.set("token", token);
  form.set("attachment", file, fileName);
  return form;
}

function attachmentResult(
  result: ArcGISAttachmentEditResult | undefined,
  fallback: string,
): number | undefined {
  if (!result || typeof result.success !== "boolean") {
    throw MESSAGES.invalidResponse();
  }
  if (!result.success) throw serviceError(result.error, fallback);
  return Number.isSafeInteger(result.objectId) ? (result.objectId as number) : undefined;
}

/**
 * Attach a file to a record.
 *
 * @param source - The ArcGIS feature layer, or a table related to it.
 * @param objectId - The record's service object ID.
 * @param file - The file to upload.
 * @param fileName - The name to store, defaulting to the file's own.
 * @param signal - Aborts the upload; an upload aborted in flight is unconfirmed.
 * @returns The new attachment's ID.
 */
export async function addArcGISAttachment(
  source: ArcGISAttachmentSource,
  objectId: number,
  file: Blob,
  fileName = file instanceof File ? file.name : "attachment",
  signal?: AbortSignal,
): Promise<number> {
  const connection = await connect(source);
  const json = await postAttachmentWrite<{ addAttachmentResult?: ArcGISAttachmentEditResult }>(
    connection,
    `${recordUrl(connection, objectId)}/addAttachment`,
    uploadForm(file, fileName, connection.token),
    signal,
  );
  if (json.error) throw serviceError(json.error, "ArcGIS rejected the attachment.");
  const id = attachmentResult(json.addAttachmentResult, "ArcGIS rejected the attachment.");
  // Success without the new attachment's ID is not a confirmed upload.
  if (id === undefined) {
    throw MESSAGES.unconfirmed();
  }
  return id;
}

/**
 * Replace the content of an existing attachment, keeping its ID.
 *
 * @param source - The ArcGIS feature layer, or a table related to it.
 * @param objectId - The record's service object ID.
 * @param attachmentId - The attachment to replace.
 * @param file - The new content.
 * @param fileName - The name to store, defaulting to the file's own.
 * @param signal - Aborts the upload; an upload aborted in flight is unconfirmed.
 */
export async function updateArcGISAttachment(
  source: ArcGISAttachmentSource,
  objectId: number,
  attachmentId: number,
  file: Blob,
  fileName = file instanceof File ? file.name : "attachment",
  signal?: AbortSignal,
): Promise<void> {
  const connection = await connect(source);
  const form = uploadForm(file, fileName, connection.token);
  form.set("attachmentId", String(attachmentId));
  const json = await postAttachmentWrite<{
    updateAttachmentResult?: ArcGISAttachmentEditResult;
  }>(connection, `${recordUrl(connection, objectId)}/updateAttachment`, form, signal);
  if (json.error) throw serviceError(json.error, "ArcGIS rejected the replacement.");
  attachmentResult(json.updateAttachmentResult, "ArcGIS rejected the replacement.");
}

/**
 * Delete attachments of one record.
 *
 * @param source - The ArcGIS feature layer, or a table related to it.
 * @param objectId - The record's service object ID.
 * @param attachmentIds - The attachments to delete.
 * @returns The IDs deleted, and a message per attachment the service refused.
 */
export async function deleteArcGISAttachments(
  source: ArcGISAttachmentSource,
  objectId: number,
  attachmentIds: number[],
): Promise<{ deleted: number[]; errors: string[] }> {
  if (!attachmentIds.length) return { deleted: [], errors: [] };
  const connection = await connect(source);
  const body = new URLSearchParams({ f: "json", attachmentIds: attachmentIds.join(",") });
  if (connection.token) body.set("token", connection.token);
  const json = await postAttachmentWrite<{ deleteAttachmentResults?: unknown }>(
    connection,
    `${recordUrl(connection, objectId)}/deleteAttachments`,
    body,
  );
  if (json.error) throw serviceError(json.error, "ArcGIS could not delete the attachments.");
  const results = json.deleteAttachmentResults;
  if (!Array.isArray(results) || results.length !== attachmentIds.length) {
    throw MESSAGES.invalidResponse();
  }
  const deleted: number[] = [];
  const errors: string[] = [];
  (results as ArcGISAttachmentEditResult[]).forEach((result, i) => {
    const id = Number.isSafeInteger(result?.objectId)
      ? (result.objectId as number)
      : attachmentIds[i];
    if (result?.success === true) deleted.push(id);
    else
      errors.push(
        `${id}: ${serviceError(result?.error, "ArcGIS could not delete the attachment.").message}`,
      );
  });
  return { deleted, errors };
}
