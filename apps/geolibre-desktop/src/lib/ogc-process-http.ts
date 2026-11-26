import { OgcProcessError } from "./ogc-process-errors";
import { readLimitedBody } from "../components/layout/add-data/helpers";
import { isTauri } from "./is-tauri";
import { normalizeFetchError } from "./ogc-json";
import { waitForWcsRequest } from "./wcs";
import {
  MAX_PROCESS_INPUT_BYTES,
  MAX_PROCESS_METADATA_BYTES,
  MAX_PROCESS_RESULT_BYTES,
  OGC_PROCESS_PROXY_PATH,
} from "./ogc-process-limits";

export interface ProcessHttpResponse {
  status: number;
  url: string;
  contentType: string | null;
  location: string | null;
  retryAfter: string | null;
  link: string | null;
  body: Uint8Array<ArrayBuffer>;
}

/** Validate service links without allowing URL user information or non-HTTP schemes. */
export function processHttpUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new OgcProcessError("invalidUrl");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new OgcProcessError("invalidUrl");
  url.hash = "";
  return url;
}

/** One bounded request; an execution POST is never retried as a GET on an older host. */
export async function processHttp(
  value: string,
  signal: AbortSignal,
  options: {
    method?: "GET" | "POST" | "DELETE";
    body?: string;
    preferAsync?: boolean;
    maxBytes?: number;
    accept?: string;
  } = {},
): Promise<ProcessHttpResponse> {
  const url = processHttpUrl(value).href;
  const method = options.method ?? "GET";
  const maxBytes = options.maxBytes ?? MAX_PROCESS_METADATA_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PROCESS_RESULT_BYTES)
    throw new OgcProcessError("responseLimit");
  if (method === "POST") {
    if (!options.body || new TextEncoder().encode(options.body).length > MAX_PROCESS_INPUT_BYTES)
      throw new OgcProcessError("inputLimit");
    const body: unknown = JSON.parse(options.body);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new OgcProcessError("inputObject");
  } else if (options.body !== undefined) {
    throw new OgcProcessError("requestBody");
  }
  const deadline = AbortSignal.timeout(120_000);
  const abort = AbortSignal.any([signal, deadline]);
  abort.throwIfAborted();
  try {
    if (isTauri()) {
      const { requestOgcProcess } = await import("./native-http");
      // In particular, do not submit a job cancelled while the module loaded.
      abort.throwIfAborted();
      const pending = requestOgcProcess(url, {
        ...options,
        method,
        maxBytes,
        timeoutSecs: 120,
        context: "OGC API Processes",
      });
      // Once dispatched, the bounded native write may outlive observation.
      // Await its outcome so an accepted job is not discarded on cancellation.
      const result = method === "GET" ? await waitForWcsRequest(pending, abort) : await pending;
      if (!(method === "POST" && [201, 202].includes(result.status) && result.location))
        abort.throwIfAborted();
      const body =
        result.body.buffer instanceof ArrayBuffer
          ? new Uint8Array(result.body.buffer, result.body.byteOffset, result.body.byteLength)
          : new Uint8Array(result.body);
      if (body.byteLength > maxBytes) {
        if (method === "POST" && [201, 202].includes(result.status) && result.location)
          return { ...result, body: new Uint8Array() };
        throw new OgcProcessError("responseTooLarge");
      }
      return { ...result, body };
    }
    const dev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
    const target = dev ? `${OGC_PROCESS_PROXY_PATH}?url=${encodeURIComponent(url)}` : url;
    const headers = new Headers({ Accept: options.accept ?? "application/json" });
    if (dev) headers.set("x-geolibre-max-bytes", String(maxBytes));
    if (method === "POST") headers.set("Content-Type", "application/json");
    if (method === "POST" && options.preferAsync) headers.set("Prefer", "respond-async");
    const response = await fetch(target, {
      method,
      body: options.body,
      headers,
      signal: abort,
      redirect: method === "GET" ? "follow" : "error",
    });
    let body: Uint8Array<ArrayBuffer>;
    try {
      body = await readLimitedBody(
        response,
        response.ok ? maxBytes : Math.min(maxBytes, 64 * 1024),
      );
    } catch (error) {
      const accepted =
        method === "POST" &&
        [201, 202].includes(response.status) &&
        response.headers.has("location");
      if (!accepted && (response.ok || abort.aborted)) throw error;
      body = new Uint8Array();
    }
    if (
      !(
        method === "POST" &&
        [201, 202].includes(response.status) &&
        response.headers.has("location")
      )
    )
      abort.throwIfAborted();
    return {
      status: response.status,
      url: dev ? (response.headers.get("x-geolibre-final-url") ?? url) : response.url || url,
      contentType: response.headers.get("content-type"),
      location: response.headers.get("location"),
      retryAfter: response.headers.get("retry-after"),
      link: response.headers.get("link"),
      body,
    };
  } catch (error) {
    if (
      !signal.aborted &&
      (deadline.aborted || (error instanceof DOMException && error.name === "TimeoutError"))
    )
      throw new OgcProcessError("requestTimeout");
    throw normalizeFetchError(error);
  }
}
