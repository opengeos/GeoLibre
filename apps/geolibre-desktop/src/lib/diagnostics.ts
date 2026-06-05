import { useEffect, useSyncExternalStore } from "react";

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
}

const MAX_DIAGNOSTIC_RECORDS = 500;
const MAX_FIELD_LENGTH = 3000;

const listeners = new Set<() => void>();
let records: DiagnosticRecord[] = [];
let sequence = 0;
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

function formatUnknown(value: unknown): string {
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
    for (const param of REDACTED_URL_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.set(param, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
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
  const record: DiagnosticRecord = {
    ...input,
    id: `diagnostic-${Date.now()}-${sequence++}`,
    timestamp: input.timestamp ?? new Date().toISOString(),
    message: truncate(input.message),
    detail: input.detail ? truncate(input.detail) : undefined,
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

export function useDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDiagnosticsCapture(): void {
  useEffect(() => installDiagnosticsCapture(), []);
}

/**
 * Installs the fetch/console/window interceptors and returns a cleanup
 * function. Ref-counted so concurrent callers share one installation; the
 * interceptors are only removed once every returned cleanup has been called.
 * Each caller must therefore invoke its cleanup exactly once (guaranteed when
 * used via useDiagnosticsCapture's effect).
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

  const originalFetch = window.fetch.bind(window);
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  const patchedFetch: typeof fetch = async (input, init) => {
    const startedAt = performance.now();
    const method = requestMethod(input, init);
    const url = requestUrl(input);

    try {
      const response = await originalFetch(input, init);
      appendDiagnostic({
        category: "network",
        level: response.ok ? "info" : "error",
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
      appendDiagnostic({
        category: "network",
        level: isAbort ? "info" : "error",
        message: isAbort ? `${method} aborted` : `${method} request failed`,
        detail: isAbort ? undefined : formatUnknown(error),
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
    try {
      appendDiagnostic({
        category: "console",
        level: "warning",
        message: formatConsoleArgs(args) || "console.warn",
      });
    } finally {
      originalConsoleWarn(...args);
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
    appendDiagnostic({
      category: "runtime",
      level: "error",
      message: "Unhandled promise rejection",
      detail: formatUnknown(event.reason),
    });
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
