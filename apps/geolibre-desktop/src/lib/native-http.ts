/**
 * Thin wrappers around the native Tauri HTTP commands (`fetch_url_bytes`,
 * `resolve_url_redirect`) that record every call in the Diagnostics network log.
 *
 * These commands run in Rust and never pass through `window.fetch`, so the
 * diagnostics fetch interceptor cannot see them; their failures used to surface
 * only in the UI that started the request. Routing every native call through
 * here makes them visible in the Diagnostics panel — success entries are gated
 * behind "Log all network requests" like ordinary fetches, while failures are
 * always recorded and classified with an actionable hint (issue #1175).
 */

import { invoke } from "@tauri-apps/api/core";
import {
  appendDiagnostic,
  formatUnknown,
  type DiagnosticInput,
} from "./diagnostics";
import { classifyFetchFailure } from "./fetch-error";

/** The native HTTP commands exposed by the Tauri backend. */
export type NativeHttpCommand = "fetch_url_bytes" | "resolve_url_redirect";

interface NativeHttpOptions {
  /** Short feature label (e.g. "WFS GetCapabilities") added to the record. */
  context?: string;
}

function recordSource(command: NativeHttpCommand, context?: string): string {
  return context ? `native ${command} — ${context}` : `native ${command}`;
}

/**
 * Builds the info-level diagnostics record for a successful native HTTP call.
 * Exported for testing (the wrapper cannot run without the Tauri runtime).
 */
export function nativeHttpSuccessRecord(
  command: NativeHttpCommand,
  url: string,
  durationMs: number,
  context?: string,
): DiagnosticInput {
  return {
    category: "network",
    level: "info",
    message: `GET ${command}`,
    durationMs,
    method: "GET",
    source: recordSource(command, context),
    url,
  };
}

/**
 * Builds the error-level diagnostics record for a failed native HTTP call,
 * classifying the failure and prepending an actionable hint to the raw error.
 * Exported for testing (the wrapper cannot run without the Tauri runtime).
 */
export function nativeHttpFailureRecord(
  command: NativeHttpCommand,
  url: string,
  error: unknown,
  durationMs: number,
  context?: string,
): DiagnosticInput {
  const { kind, label, hint } = classifyFetchFailure(error);
  const rawError = formatUnknown(error);
  return {
    category: "network",
    level: "error",
    // Only append the classification when it says something useful; an ordinary
    // non-2xx status is "unknown" (label "request failed"), and appending it
    // would read as the redundant "failed (request failed)".
    message:
      kind !== "unknown"
        ? `GET ${command} failed (${label})`
        : `GET ${command} failed`,
    detail: hint ? `${hint}\n\n${rawError}` : rawError,
    durationMs,
    method: "GET",
    source: recordSource(command, context),
    url,
  };
}

async function invokeNativeHttp<T>(
  command: NativeHttpCommand,
  url: string,
  options?: NativeHttpOptions,
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await invoke<T>(command, { url });
    appendDiagnostic(
      nativeHttpSuccessRecord(
        command,
        url,
        Math.round(performance.now() - startedAt),
        options?.context,
      ),
    );
    return result;
  } catch (error) {
    appendDiagnostic(
      nativeHttpFailureRecord(
        command,
        url,
        error,
        Math.round(performance.now() - startedAt),
        options?.context,
      ),
    );
    throw error;
  }
}

/**
 * Fetches a URL's bytes through the native `fetch_url_bytes` command (not
 * subject to browser CORS), recording the request in the diagnostics log.
 *
 * @param url - The absolute HTTP(S) URL to fetch.
 * @param options - Optional context label for the diagnostics record.
 * @returns The response body bytes (Tauri may hand back a plain number array).
 */
export function fetchUrlBytes(
  url: string,
  options?: NativeHttpOptions,
): Promise<number[] | Uint8Array> {
  return invokeNativeHttp<number[] | Uint8Array>("fetch_url_bytes", url, options);
}

/**
 * Resolves a redirecting/short URL to its final XYZ template through the native
 * `resolve_url_redirect` command, recording the request in the diagnostics log.
 *
 * @param url - The short or redirecting HTTP(S) URL to resolve.
 * @param options - Optional context label for the diagnostics record.
 * @returns The resolved URL.
 */
export function resolveUrlRedirect(
  url: string,
  options?: NativeHttpOptions,
): Promise<string> {
  return invokeNativeHttp<string>("resolve_url_redirect", url, options);
}
