import { useSyncExternalStore } from "react";
import { classifyFetchFailure } from "./fetch-error";
import { isTauri } from "./is-tauri";

export type DiagnosticCategory = "console" | "map" | "network" | "runtime";
export type DiagnosticLevel = "error" | "info" | "warning";

export interface DiagnosticRecord {
  id: string;
  timestamp: string;
  category: DiagnosticCategory;
  level: DiagnosticLevel;
  message: string;
  detail?: string;
  durationMs?: number;
  method?: string;
  source?: string;
  status?: number;
  url?: string;
}

export interface DiagnosticInput
  extends Omit<DiagnosticRecord, "id" | "timestamp"> {
  timestamp?: string;
}

export interface DiagnosticsSnapshot {
  records: DiagnosticRecord[];
  totalCount: number;
  errorCount: number;
  warningCount: number;
  networkCount: number;
  captureNetworkInfo: boolean;
}

const MAX_DIAGNOSTIC_RECORDS = 500;
const MAX_FIELD_LENGTH = 3000;
const CAPTURE_NETWORK_INFO_STORAGE_KEY =
  "geolibre.diagnostics.captureNetworkInfo";

// On some WebView2 (Windows) and WKWebView (macOS) builds the first requests to
// Tauri's custom IPC/asset protocols can momentarily fail while those schemes
// are still being registered, surfacing as a `TypeError: Failed to fetch` (or
// `Load failed` on WebKit). Tauri's IPC layer logs the warning below once and
// transparently retries every call over its postMessage interface, and MapLibre
// recovers and renders the map, so these are benign startup transients. They are
// still recorded as diagnostics, but kept out of the developer console where
// they read as fatal errors (see GitHub issue #332). Scoped to the desktop
// runtime and a short post-launch window so genuine later fetch failures are
// untouched.
//
// Tradeoff: the match is on the generic message text, not the failing origin.
// MapLibre's rejection is a plain `Failed to fetch` with no `ipc.localhost` in
// the message, so narrowing to that origin would miss the very rejection this
// targets. The cost is that a genuine plugin/network fetch that rejects within
// the startup window is also downgraded from error to warning — acceptable
// because the window is short and the event is still recorded in diagnostics.
const STARTUP_FETCH_GRACE_MS = 15_000;
const FETCH_FAILURE_MESSAGES = ["Failed to fetch", "Load failed"];
// Logged verbatim by Tauri's runtime-injected ipc-protocol.js (tauri 2.x) the
// first time the custom-protocol IPC falls back to postMessage.
const TAURI_IPC_FALLBACK_WARNING =
  "IPC custom protocol failed, Tauri will now use the postMessage interface instead";

// MapLibre warns this every time a camera animation eases around a point (the
// inertia of a rotate/tilt gesture, double-click zoom, etc.) while the globe
// projection is active — globe simply ignores the around-point and the camera
// still moves correctly. It is harmless but fires on routine interaction, so it
// is kept out of the diagnostics panel (still echoed to the console for devs).
const BENIGN_CONSOLE_WARNINGS = [
  "Easing around a point is not supported under globe projection.",
];

/** Whether a console.warn message is a known-benign warning to drop entirely. */
function isBenignConsoleWarning(args: unknown[]): boolean {
  return (
    typeof args[0] === "string" &&
    BENIGN_CONSOLE_WARNINGS.some((needle) =>
      (args[0] as string).includes(needle),
    )
  );
}

// Request header that flags a fetch whose failure (typically a 404) is expected
// and harmless — e.g. an optional config file that may simply be absent. A
// non-ok response to such a request is recorded at info level instead of error,
// so it does not surface as a problem in the diagnostics panel (issue follow-up
// to #500: the optional admin-profile.json 404 on every load).
export const OPTIONAL_RESOURCE_HEADER = "x-geolibre-optional-resource";

/** Read a single header value across the Headers/array/record init shapes. */
function readHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(target);
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === target) return value;
    }
    return null;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/** Whether a request opted out of error-level logging for benign failures. */
function isOptionalResourceRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): boolean {
  // Per the fetch spec, when init.headers is provided it replaces a Request
  // input's headers entirely, so only fall back to the Request's own headers
  // when init omits them — otherwise an init that drops the marker would still
  // be treated as optional.
  if (init?.headers !== undefined) {
    return readHeader(init.headers, OPTIONAL_RESOURCE_HEADER) != null;
  }
  return (
    input instanceof Request &&
    input.headers.get(OPTIONAL_RESOURCE_HEADER) != null
  );
}

/**
 * Remove the optional-resource marker before the request leaves the app. It is a
 * client-side diagnostics hint with no meaning to any server; forwarding it
 * would, on a cross-origin request, turn it into a non-simple header that forces
 * a CORS preflight the server would have to allow.
 */
function stripOptionalResourceHeader(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] } {
  // init.headers, when present, is what actually gets sent (it replaces a
  // Request input's headers), so strip it there.
  if (init?.headers !== undefined) {
    if (readHeader(init.headers, OPTIONAL_RESOURCE_HEADER) == null) {
      return { input, init };
    }
    const headers = new Headers(init.headers);
    headers.delete(OPTIONAL_RESOURCE_HEADER);
    return { input, init: { ...init, headers } };
  }
  // Otherwise a Request input may carry it; rebuild without the marker.
  if (input instanceof Request && input.headers.has(OPTIONAL_RESOURCE_HEADER)) {
    const headers = new Headers(input.headers);
    headers.delete(OPTIONAL_RESOURCE_HEADER);
    return { input: new Request(input, { headers }), init };
  }
  return { input, init };
}

function looksLikeFetchFailure(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : "";
  return FETCH_FAILURE_MESSAGES.some((needle) => message.includes(needle));
}

// Note: called once at module import, so the initial value is frozen for the
// lifetime of the module. Tests that need a different starting state must
// mock localStorage before importing this module, or call
// setCaptureNetworkInfo() to change it afterwards.
function readStoredCaptureNetworkInfo(): boolean {
  try {
    return window.localStorage.getItem(CAPTURE_NETWORK_INFO_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const listeners = new Set<() => void>();
let records: DiagnosticRecord[] = [];
let sequence = 0;
// Capturing every successful request floods the store and re-renders
// subscribers on each fetch, so info-level network entries are opt-in.
let captureNetworkInfo = readStoredCaptureNetworkInfo();
let snapshot = createSnapshot(records);
let captureRefCount = 0;
let captureCleanup: (() => void) | null = null;

function createSnapshot(nextRecords: DiagnosticRecord[]): DiagnosticsSnapshot {
  let errorCount = 0;
  let warningCount = 0;
  let networkCount = 0;
  for (const record of nextRecords) {
    if (record.level === "error") errorCount += 1;
    else if (record.level === "warning") warningCount += 1;
    if (record.category === "network") networkCount += 1;
  }
  return {
    records: nextRecords,
    totalCount: nextRecords.length,
    errorCount,
    warningCount,
    networkCount,
    captureNetworkInfo,
  };
}

function emitChange(): void {
  snapshot = createSnapshot(records);
  for (const listener of listeners) listener();
}

function truncate(value: string): string {
  return value.length > MAX_FIELD_LENGTH
    ? `${value.slice(0, MAX_FIELD_LENGTH)}...`
    : value;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;

  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      value,
      (_key, nestedValue: unknown) => {
        if (typeof nestedValue !== "object" || nestedValue === null) {
          return nestedValue;
        }
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
        return nestedValue;
      },
      2,
      // JSON.stringify returns undefined for undefined, functions, and
      // symbols; fall back to String() so the field is never dropped.
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Renders an arbitrary thrown value as a diagnostics detail string: an Error's
 * stack (or message), a string as-is, anything else JSON-stringified. Exported
 * so callers that build their own records (e.g. native-http.ts) format errors
 * the same way.
 */
export function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  return safeStringify(value);
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatUnknown).filter(Boolean).join(" ");
}

const REDACTED_URL_PARAMS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "key",
  "token",
]);

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const param of [...url.searchParams.keys()]) {
      if (REDACTED_URL_PARAMS.has(param.toLowerCase())) {
        url.searchParams.set(param, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
}

// Matches an http(s) URL embedded in free text, stopping before whitespace or a
// closing delimiter so a URL inside `(...)` or quotes is captured without its
// surrounding punctuation.
const EMBEDDED_URL = /https?:\/\/[^\s)"'<>]+/g;

// A record's `detail` often carries a raw error string, and a native
// (Rust/reqwest) error embeds the full request URL verbatim — including any
// `api_key`/`token` query param that `redactUrl` strips from the record's `url`
// field. The detail is rendered in the panel and included in the "Copy JSON"
// export, so redact any URLs it contains the same way, keeping secrets out of
// exported diagnostics.
function redactUrlsInText(text: string): string {
  return text.replace(EMBEDDED_URL, (match) => redactUrl(match));
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.toString();
  return String(input);
}

function requestMethod(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): string {
  return (
    init?.method ??
    (input instanceof Request && input.method ? input.method : "GET")
  ).toUpperCase();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): DiagnosticsSnapshot {
  return snapshot;
}

export function appendDiagnostic(input: DiagnosticInput): void {
  if (
    input.category === "network" &&
    input.level === "info" &&
    !captureNetworkInfo
  ) {
    return;
  }

  const record: DiagnosticRecord = {
    ...input,
    id: `diagnostic-${Date.now()}-${sequence++}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    // Runtime/plugin/console emitters can forward an arbitrary error or console
    // string (which may embed a tokenized URL) into either field, so redact both
    // the same way as the `url` field before storing/exporting them.
    message: truncate(redactUrlsInText(input.message)),
    detail: input.detail ? truncate(redactUrlsInText(input.detail)) : undefined,
    source: input.source ? truncate(input.source) : undefined,
    url: input.url ? truncate(redactUrl(input.url)) : undefined,
  };

  records = [record, ...records].slice(0, MAX_DIAGNOSTIC_RECORDS);
  emitChange();
}

export function clearDiagnostics(): void {
  records = [];
  emitChange();
}

/**
 * Enables or disables capturing info-level network diagnostics (successful
 * and aborted requests). Disabled by default to avoid the overhead of
 * recording every request; the choice persists across sessions.
 *
 * @param enabled - Whether info-level network entries should be recorded.
 */
export function setCaptureNetworkInfo(enabled: boolean): void {
  if (captureNetworkInfo === enabled) return;
  captureNetworkInfo = enabled;
  try {
    // The key is only present when the user has explicitly opted in; the
    // default-off state matches a pristine localStorage.
    if (enabled) {
      window.localStorage.setItem(CAPTURE_NETWORK_INFO_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(CAPTURE_NETWORK_INFO_STORAGE_KEY);
    }
  } catch {
    // Persistence is best-effort; the in-memory flag still applies.
  }
  emitChange();
}

export function useDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Returns the current diagnostics snapshot outside of React (e.g. in tests).
 *
 * @returns The current diagnostics snapshot (treat as read-only).
 */
export function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return snapshot;
}

/**
 * Installs the fetch/console/window interceptors and returns a cleanup
 * function. Ref-counted so concurrent callers share one installation; the
 * interceptors are only removed once every returned cleanup has been called.
 * Each caller must therefore invoke its cleanup exactly once (e.g. from a
 * useEffect cleanup or a single entry-point install as in main.tsx).
 */
export function installDiagnosticsCapture(): () => void {
  captureRefCount += 1;
  if (captureCleanup) {
    return () => {
      captureRefCount -= 1;
      if (captureRefCount === 0) {
        captureCleanup?.();
        captureCleanup = null;
      }
    };
  }

  const installedAt = Date.now();
  const originalFetch = window.fetch.bind(window);
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  // Suppression only applies to the desktop runtime during the post-launch
  // window; a Tauri IPC fallback that happens later (e.g. after an OS
  // suspend/resume) stays console-visible rather than being silently swallowed.
  const inStartupWindow = (): boolean =>
    isTauri() && Date.now() - installedAt <= STARTUP_FETCH_GRACE_MS;

  // Within the startup window, a desktop "Failed to fetch" rejection/warning is
  // the Tauri custom-protocol fallback warming up rather than a real failure.
  const isBenignStartupFetch = (reason: unknown): boolean =>
    inStartupWindow() && looksLikeFetchFailure(reason);

  const patchedFetch: typeof fetch = async (input, init) => {
    const startedAt = performance.now();
    const method = requestMethod(input, init);
    const url = requestUrl(input);

    // A request may declare that a failure (a non-ok response such as a 404, or
    // a thrown network error) is expected — e.g. an optional config file that
    // may be absent — so it is logged as info rather than flagged an error. The
    // marker is read here, then stripped so it never reaches the server.
    const optional = isOptionalResourceRequest(input, init);
    const forwarded = stripOptionalResourceHeader(input, init);

    try {
      const response = await originalFetch(forwarded.input, forwarded.init);
      appendDiagnostic({
        category: "network",
        level: response.ok || optional ? "info" : "error",
        message: `${method} ${response.status} ${response.statusText}`.trim(),
        durationMs: Math.round(performance.now() - startedAt),
        method,
        status: response.status,
        url,
      });
      return response;
    } catch (error) {
      const isAbort =
        (error instanceof DOMException || error instanceof Error) &&
        error.name === "AbortError";
      // A "Failed to fetch"/"Load failed" thrown during the desktop startup
      // window is the Tauri custom-protocol IPC warming up: the call is retried
      // over postMessage and the app recovers. Record it as a benign warning
      // rather than a critical network error so it does not surface as an
      // alarming failure to a user inspecting the panel at launch (issue #657).
      // It mirrors the unhandled-rejection downgrade below; genuine failures
      // outside the window are still flagged as errors.
      const benignStartup = !isAbort && !optional && isBenignStartupFetch(error);
      // Classify a genuine failure (network/TLS/CORS vs. timeout) so the panel
      // record interprets the otherwise-opaque browser error and carries an
      // actionable hint (issue #1175). Aborts, optional-resource failures, and
      // the benign startup warm-up keep their existing handling above.
      const classified = !isAbort && !optional && !benignStartup;
      const failure = classified ? classifyFetchFailure(error) : null;
      const rawDetail = isAbort ? undefined : formatUnknown(error);
      appendDiagnostic({
        category: "network",
        level:
          isAbort || optional ? "info" : benignStartup ? "warning" : "error",
        message: isAbort
          ? `${method} aborted`
          : benignStartup
            ? `${method} request failed (benign Tauri custom-protocol warm-up)`
            : failure && failure.kind !== "unknown"
              ? `${method} request failed (${failure.label})`
              : `${method} request failed`,
        detail:
          failure?.hint && rawDetail
            ? `${failure.hint}\n\n${rawDetail}`
            : rawDetail,
        durationMs: Math.round(performance.now() - startedAt),
        method,
        url,
      });
      throw error;
    }
  };

  console.error = (...args: unknown[]) => {
    try {
      appendDiagnostic({
        category: "console",
        level: "error",
        message: formatConsoleArgs(args) || "console.error",
      });
    } finally {
      originalConsoleError(...args);
    }
  };

  console.warn = (...args: unknown[]) => {
    // Known-benign third-party warnings (e.g. MapLibre's globe easing notice on
    // every rotate/tilt gesture) are echoed to the console so a contributor
    // debugging map animations still sees them, but kept out of the diagnostics
    // panel, where they would clutter the log on routine interaction.
    if (isBenignConsoleWarning(args)) {
      originalConsoleWarn(...args);
      return;
    }
    const isTauriIpcFallback =
      inStartupWindow() &&
      typeof args[0] === "string" &&
      args[0].includes(TAURI_IPC_FALLBACK_WARNING);
    try {
      appendDiagnostic({
        category: "console",
        level: "warning",
        message: formatConsoleArgs(args) || "console.warn",
      });
    } finally {
      // Record Tauri's one-time IPC-fallback notice but don't echo it to the
      // console: the fallback is automatic and harmless, and the warning only
      // alarms users inspecting the console at startup (issue #332).
      if (!isTauriIpcFallback) originalConsoleWarn(...args);
    }
  };

  const handleWindowError = (event: ErrorEvent) => {
    appendDiagnostic({
      category: "runtime",
      level: "error",
      message: event.message || "Unhandled runtime error",
      detail: event.error ? formatUnknown(event.error) : undefined,
      source: event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : undefined,
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const benign = isBenignStartupFetch(event.reason);
    appendDiagnostic({
      category: benign ? "network" : "runtime",
      level: benign ? "warning" : "error",
      message: benign
        ? "Benign startup fetch rejection (Tauri custom-protocol warm-up)"
        : "Unhandled promise rejection",
      detail: formatUnknown(event.reason),
    });
    // MapLibre and Tauri both recover from the custom-protocol warm-up failure,
    // so swallow the rejection to keep an "Uncaught (in promise) TypeError:
    // Failed to fetch" out of the console (issue #332). It stays in diagnostics.
    if (benign) event.preventDefault();
  };

  window.fetch = patchedFetch;
  window.addEventListener("error", handleWindowError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  captureCleanup = () => {
    window.fetch = originalFetch;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    window.removeEventListener("error", handleWindowError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };

  return () => {
    captureRefCount -= 1;
    if (captureRefCount === 0) {
      captureCleanup?.();
      captureCleanup = null;
    }
  };
}
