/**
 * A `fetch` for plugins that goes through the desktop app's native HTTP client
 * (`plugin_http_request` in `src-tauri/src/plugin_http.rs`) instead of the
 * webview: any method, no CORS, and a cookie jar that lasts the app session.
 *
 * The webview cannot hold a service's session cookie: the page runs at
 * `tauri://localhost`, so a cookie set by `https://service.example` is
 * third-party and WebKit drops it. A plugin that signs in with a cookie (Data to
 * Science, issue #2837) gets a 200 from its login and a 401 from the next call.
 * Plugins receive this as `app.nativeFetch` on the desktop only.
 */

import type { Channel, invoke as nativeInvoke } from "@tauri-apps/api/core";
import { redactUrlCredentials } from "@geolibre/core";
import type { DiagnosticInput } from "./diagnostics";

/** The request the native command takes; the body is base64. */
export interface PluginHttpPayload {
  url: string;
  method: string;
  headers: [string, string][];
  body?: string;
}

/** The native command's answer; the body is base64. */
export interface PluginHttpResult {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  body: string;
}

type PluginHttpSend = (
  request: PluginHttpPayload,
  signal?: AbortSignal | null,
) => Promise<PluginHttpResult>;

type RecordDiagnostic = (record: DiagnosticInput) => void;

// Statuses whose Response must not carry a body (the constructor throws).
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so a large body does not overflow the argument limit of apply.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function diagnosticRecord(
  method: string,
  url: string,
  durationMs: number,
  outcome: { status: number } | { error: unknown },
): DiagnosticInput {
  const failed = "error" in outcome || outcome.status >= 400;
  return {
    category: "network",
    level: failed ? "error" : "info",
    message: "error" in outcome ? `${method} plugin request failed` : `${method} ${outcome.status}`,
    ...("error" in outcome
      ? { detail: redactUrlCredentials(String(outcome.error)) }
      : { status: outcome.status }),
    durationMs,
    method,
    source: "native plugin fetch",
    url: redactUrlCredentials(url),
  };
}

/**
 * Adapt the native plugin HTTP command to the `fetch` signature.
 *
 * @param send - Sends one request natively (see {@link createPluginHttpSend}).
 * @param record - Receives a Diagnostics record per request, if given.
 * @returns A `fetch`-compatible function.
 */
export function createPluginNativeFetch(
  send: PluginHttpSend,
  record?: RecordDiagnostic,
): typeof globalThis.fetch {
  return async (input, init) => {
    // The Request constructor normalizes every input form (URL, string,
    // Request, init overrides) and encodes the body with its Content-Type, so a
    // URLSearchParams or FormData body arrives the way the webview would send it.
    const request = new Request(input, init);
    const { signal } = request;
    signal.throwIfAborted();
    const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const payload: PluginHttpPayload = {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      ...(bytes ? { body: toBase64(bytes) } : {}),
    };
    const startedAt = performance.now();
    let onAbort: (() => void) | undefined;
    let result: PluginHttpResult;
    try {
      // Reject promptly while the native cancellation acknowledgement is in flight.
      result = await Promise.race([
        send(payload, signal),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      record?.(
        diagnosticRecord(request.method, request.url, Math.round(performance.now() - startedAt), {
          error,
        }),
      );
      // A network failure from fetch is a TypeError; keep that contract.
      throw new TypeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    record?.(
      diagnosticRecord(request.method, request.url, Math.round(performance.now() - startedAt), {
        status: result.status,
      }),
    );
    const body =
      NULL_BODY_STATUSES.has(result.status) || request.method === "HEAD"
        ? null
        : fromBase64(result.body);
    const response = new Response(body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
    // A constructed Response has an empty url; report where the request ended up.
    Object.defineProperty(response, "url", { value: result.url });
    return response;
  };
}

/**
 * Send requests through the native command, coordinating cancellation with
 * Rust, including aborts that land before Rust has registered the request.
 *
 * @param invoke - Tauri's `invoke`.
 * @param createReady - Creates the channel Rust signals once it can cancel.
 * @returns A sender for {@link createPluginNativeFetch}.
 */
export function createPluginHttpSend(
  invoke: typeof nativeInvoke,
  createReady: () => Pick<Channel<void>, "onmessage">,
): PluginHttpSend {
  return async (request, signal) => {
    signal?.throwIfAborted();
    const requestId = crypto.randomUUID();
    const ready = createReady();
    let registered = false;
    const onAbort = () => {
      if (registered) {
        void invoke("cancel_plugin_http_request", { requestId }).catch((error: unknown) => {
          console.error("[GeoLibre] Failed to cancel native plugin request", error);
        });
      }
    };
    ready.onmessage = () => {
      registered = true;
      if (signal?.aborted) onAbort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await invoke<PluginHttpResult>("plugin_http_request", {
        request,
        requestId,
        ready,
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
