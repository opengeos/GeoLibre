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
import { LocalizedError } from "../localized-error";

const ERROR_KEY = "arcgisService.errors";

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

interface ArcGISAttachmentLayerInfo extends ArcGISEditInfo {
  hasAttachments?: boolean;
}

interface ArcGISServiceError {
  code?: unknown;
  message?: string;
  description?: string;
  details?: unknown;
}

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
  if (typeof layer.source.arcgisQueryUrl !== "string") return undefined;
  const info = layer.metadata.arcgisEditInfo as ArcGISAttachmentLayerInfo | undefined;
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

async function connect(layerId: string): Promise<ArcGISFeatureLayerConnection> {
  const connection = await arcGISFeatureLayerConnection(layerId);
  if (!connection) {
    throw new LocalizedError(`${ERROR_KEY}.missingServiceUrl`, "Missing ArcGIS service URL.");
  }
  return connection;
}

function recordUrl(connection: ArcGISFeatureLayerConnection, objectId: number): string {
  if (!Number.isSafeInteger(objectId) || objectId < 0) {
    throw new Error(`Invalid ArcGIS object ID: ${objectId}.`);
  }
  return `${connection.layerUrl}/${objectId}`;
}

function withQuery(url: string, params: Record<string, string | undefined>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

function requireHttps(url: string): void {
  if (new URL(url).protocol !== "https:") {
    throw new LocalizedError(`${ERROR_KEY}.writesRequireHttps`, "ArcGIS writes require HTTPS.");
  }
}

/** Turn a service error envelope into a message, distinguishing sign-in and permission refusals. */
function serviceError(error: ArcGISServiceError | undefined, fallback: string): Error {
  const code = typeof error?.code === "number" ? error.code : Number(error?.code);
  if (code === 498 || code === 499) {
    return new LocalizedError(
      `${ERROR_KEY}.attachmentSignInRequired`,
      "The ArcGIS service requires a valid sign-in for this attachment operation. Sign in again and retry.",
    );
  }
  if (code === 403) {
    return new LocalizedError(
      `${ERROR_KEY}.attachmentNotPermitted`,
      "You do not have permission for this attachment operation on the ArcGIS service.",
    );
  }
  const details = Array.isArray(error?.details)
    ? error.details.filter((d): d is string => typeof d === "string" && d.trim() !== "")
    : [];
  const text = [error?.message ?? error?.description, ...details]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  return new Error(text || fallback);
}

async function readJson<T>(response: Response): Promise<T & { error?: ArcGISServiceError }> {
  if (!response.ok) {
    throw new LocalizedError(
      `${ERROR_KEY}.serviceRequestFailed`,
      "ArcGIS service request failed with {{status}}.",
      { status: response.status },
    );
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as T & { error?: ArcGISServiceError };
  } catch {
    throw new LocalizedError(
      `${ERROR_KEY}.attachmentInvalidResponse`,
      "The ArcGIS service returned an unexpected attachment response.",
    );
  }
}

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
 * @param layerId - The ArcGIS feature layer.
 * @param objectId - The record's service object ID.
 * @param signal - Aborts the request, for example when the selection changes.
 * @returns The record's attachments, in service order.
 */
export async function listArcGISAttachments(
  layerId: string,
  objectId: number,
  signal?: AbortSignal,
): Promise<ArcGISAttachmentInfo[]> {
  const connection = await connect(layerId);
  const url = withQuery(`${recordUrl(connection, objectId)}/attachments`, {
    f: "json",
    token: connection.token,
  });
  const json = await readJson<{ attachmentInfos?: unknown }>(
    await connection.fetch(url, { signal }),
  );
  if (json.error) throw serviceError(json.error, "ArcGIS could not list the attachments.");
  if (!Array.isArray(json.attachmentInfos)) {
    throw new LocalizedError(
      `${ERROR_KEY}.attachmentInvalidResponse`,
      "The ArcGIS service returned an unexpected attachment response.",
    );
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
 * @param layerId - The ArcGIS feature layer.
 * @param objectId - The record's service object ID.
 * @param attachment - The attachment, as listed.
 * @param signal - Aborts the transfer.
 * @returns The file, typed with the attachment's content type.
 */
export async function downloadArcGISAttachment(
  layerId: string,
  objectId: number,
  attachment: Pick<ArcGISAttachmentInfo, "id" | "contentType">,
  signal?: AbortSignal,
): Promise<Blob> {
  const connection = await connect(layerId);
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

/**
 * Post a write, telling a refused write apart from one whose outcome is
 * unknown: once the request may have reached the server, a lost response must
 * not be reported as a failure that is safe to repeat.
 */
async function postAttachmentWrite<T>(
  connection: ArcGISFeatureLayerConnection,
  url: string,
  body: FormData | URLSearchParams,
  signal?: AbortSignal,
): Promise<T & { error?: ArcGISServiceError }> {
  requireHttps(url);
  signal?.throwIfAborted();
  const unconfirmed = (cause?: unknown) =>
    new LocalizedError(
      `${ERROR_KEY}.attachmentUnconfirmed`,
      "The attachment change could not be confirmed. Refresh the attachment list before trying again.",
      undefined,
      { cause },
    );
  let response: Response;
  try {
    response =
      body instanceof FormData
        ? await connection.fetch(url, { method: "POST", body, redirect: "error", signal })
        : await connection.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
            redirect: "error",
            signal,
          });
  } catch (error) {
    throw unconfirmed(error);
  }
  // A client error is a refusal; a server error or an unreadable body leaves
  // the outcome open.
  if (response.status >= 400 && response.status < 500) return readJson<T>(response);
  try {
    return await readJson<T>(response);
  } catch (error) {
    throw unconfirmed(error);
  }
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
    throw new LocalizedError(
      `${ERROR_KEY}.attachmentInvalidResponse`,
      "The ArcGIS service returned an unexpected attachment response.",
    );
  }
  if (!result.success) throw serviceError(result.error, fallback);
  return Number.isSafeInteger(result.objectId) ? (result.objectId as number) : undefined;
}

/**
 * Attach a file to a record.
 *
 * @param layerId - The ArcGIS feature layer.
 * @param objectId - The record's service object ID.
 * @param file - The file to upload.
 * @param fileName - The name to store, defaulting to the file's own.
 * @param signal - Aborts the upload; an upload aborted in flight is unconfirmed.
 * @returns The new attachment's ID.
 */
export async function addArcGISAttachment(
  layerId: string,
  objectId: number,
  file: Blob,
  fileName = file instanceof File ? file.name : "attachment",
  signal?: AbortSignal,
): Promise<number> {
  const connection = await connect(layerId);
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
    throw new LocalizedError(
      `${ERROR_KEY}.attachmentUnconfirmed`,
      "The attachment change could not be confirmed. Refresh the attachment list before trying again.",
    );
  }
  return id;
}

/**
 * Replace the content of an existing attachment, keeping its ID.
 *
 * @param layerId - The ArcGIS feature layer.
 * @param objectId - The record's service object ID.
 * @param attachmentId - The attachment to replace.
 * @param file - The new content.
 * @param fileName - The name to store, defaulting to the file's own.
 * @param signal - Aborts the upload; an upload aborted in flight is unconfirmed.
 */
export async function updateArcGISAttachment(
  layerId: string,
  objectId: number,
  attachmentId: number,
  file: Blob,
  fileName = file instanceof File ? file.name : "attachment",
  signal?: AbortSignal,
): Promise<void> {
  const connection = await connect(layerId);
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
 * @param layerId - The ArcGIS feature layer.
 * @param objectId - The record's service object ID.
 * @param attachmentIds - The attachments to delete.
 * @returns The IDs deleted, and a message per attachment the service refused.
 */
export async function deleteArcGISAttachments(
  layerId: string,
  objectId: number,
  attachmentIds: number[],
): Promise<{ deleted: number[]; errors: string[] }> {
  if (!attachmentIds.length) return { deleted: [], errors: [] };
  const connection = await connect(layerId);
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
    throw new LocalizedError(
      `${ERROR_KEY}.attachmentInvalidResponse`,
      "The ArcGIS service returned an unexpected attachment response.",
    );
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
