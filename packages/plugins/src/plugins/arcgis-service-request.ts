/**
 * Request helpers shared by the ArcGIS operations that go straight to a
 * service outside the pending feature edits (attachments, related records):
 * error envelopes, JSON replies, and writes whose lost response must not be
 * mistaken for a refusal that is safe to repeat.
 */
import type { ArcGISFeatureLayerConnection } from "./arcgis-layer";
import { LocalizedError } from "../localized-error";

const ERROR_KEY = "arcgisService.errors";

/** The `error` object of an ArcGIS REST reply. */
export interface ArcGISServiceError {
  code?: unknown;
  message?: string;
  description?: string;
  details?: unknown;
}

/**
 * The localized errors an operation family reports. Each is a factory that
 * calls `new LocalizedError` with a literal key and English text in the
 * caller's module, where the catalog test can match them against `en.json`.
 */
export interface ArcGISOperationMessages {
  signInRequired: () => LocalizedError;
  notPermitted: () => LocalizedError;
  invalidResponse: () => LocalizedError;
  unconfirmed: (cause?: unknown) => LocalizedError;
}

/** Set query parameters on a URL, skipping undefined values. */
export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

export function requireHttps(url: string): void {
  if (new URL(url).protocol !== "https:") {
    throw new LocalizedError(`${ERROR_KEY}.writesRequireHttps`, "ArcGIS writes require HTTPS.");
  }
}

/**
 * Turn a service error envelope into a message, distinguishing sign-in and
 * permission refusals.
 *
 * @param error - The reply's `error` object.
 * @param fallback - The message when the service gave none.
 * @param messages - The operation family's localized errors.
 * @returns The error to throw.
 */
export function arcGISServiceError(
  error: ArcGISServiceError | undefined,
  fallback: string,
  messages: ArcGISOperationMessages,
): Error {
  const code = typeof error?.code === "number" ? error.code : Number(error?.code);
  if (code === 498 || code === 499) return messages.signInRequired();
  if (code === 403) return messages.notPermitted();
  const details = Array.isArray(error?.details)
    ? error.details.filter((d): d is string => typeof d === "string" && d.trim() !== "")
    : [];
  const text = [error?.message ?? error?.description, ...details]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  return new Error(text || fallback);
}

/** Read a JSON reply, rejecting an HTTP failure or a body that is not JSON. */
export async function readArcGISJson<T>(
  response: Response,
  messages: ArcGISOperationMessages,
): Promise<T & { error?: ArcGISServiceError }> {
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
    throw messages.invalidResponse();
  }
}

/**
 * Post a write, telling a refused write apart from one whose outcome is
 * unknown: once the request may have reached the server, a lost response must
 * not be reported as a failure that is safe to repeat.
 *
 * @param connection - The layer's live connection.
 * @param url - The operation URL; must be HTTPS.
 * @param body - A multipart upload or a form-encoded body.
 * @param messages - The operation family's localized errors.
 * @param signal - Aborts the request; aborting in flight is unconfirmed.
 * @returns The parsed reply, which may still carry a service `error`.
 */
export async function postArcGISWrite<T>(
  connection: ArcGISFeatureLayerConnection,
  url: string,
  body: FormData | URLSearchParams,
  messages: ArcGISOperationMessages,
  signal?: AbortSignal,
): Promise<T & { error?: ArcGISServiceError }> {
  requireHttps(url);
  signal?.throwIfAborted();
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
    throw messages.unconfirmed(error);
  }
  // A client error is a refusal; a server error or an unreadable body leaves
  // the outcome open.
  if (response.status >= 400 && response.status < 500) return readArcGISJson<T>(response, messages);
  try {
    return await readArcGISJson<T>(response, messages);
  } catch (error) {
    throw messages.unconfirmed(error);
  }
}
