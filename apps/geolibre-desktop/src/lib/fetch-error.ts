/**
 * Classifies a failed outbound request (a browser `fetch()` rejection or a
 * native Tauri HTTP command error) into an actionable category with a hint.
 *
 * The browser deliberately collapses distinct network failures — a CORS
 * rejection, a TLS/certificate error, a DNS failure, a refused connection,
 * blocked mixed content — into one indistinguishable `TypeError: Failed to
 * fetch` (`Load failed` on WebKit), so the exact cause often cannot be pinned
 * down from the thrown value. The hint therefore enumerates the common causes so
 * a user or admin knows what to investigate. The native (Rust/reqwest) path does
 * carry a descriptive message, so its errors can be narrowed further by keyword.
 */

export type FetchFailureKind = "abort" | "timeout" | "network" | "unknown";

export interface FetchFailure {
  kind: FetchFailureKind;
  /** Short label for a diagnostics record message (e.g. "network/TLS/CORS"). */
  label: string;
  /** One-sentence actionable hint, or null when none applies (aborts). */
  hint: string | null;
}

// Browser fetch collapses every network-layer failure into this opaque message.
const BROWSER_NETWORK_MESSAGES = ["failed to fetch", "load failed"];

// Keywords a native reqwest error uses for the same underlying failures. Matched
// case-insensitively against the error text so the native path can be narrowed
// to a network failure even though it never throws a browser TypeError.
const NATIVE_NETWORK_KEYWORDS = [
  "certificate",
  "tls",
  "ssl",
  "handshake",
  "dns",
  "resolve",
  "connect",
  "connection",
  "unreachable",
  "network",
  "refused",
];

const NETWORK_HINT =
  "The request could not be completed. In the browser this is usually a CORS rejection (the server sent no Access-Control-Allow-Origin header for this origin), a TLS/certificate error, blocked mixed content, or an unreachable host. Try the desktop app, which is not subject to browser CORS, or check the host's certificate, firewall, and proxy rules.";

const TIMEOUT_HINT =
  "The request exceeded its time limit. The host may be slow, unreachable, or blocked by a firewall or proxy.";

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function isBrowserNetworkMessage(lowerMessage: string): boolean {
  return BROWSER_NETWORK_MESSAGES.some((needle) =>
    lowerMessage.includes(needle),
  );
}

function isNativeNetworkMessage(lowerMessage: string): boolean {
  return NATIVE_NETWORK_KEYWORDS.some((needle) =>
    lowerMessage.includes(needle),
  );
}

/**
 * Classifies a thrown fetch/native-HTTP failure. Aborts and timeouts are
 * identified by their `DOMException`/`Error` name (or a "timed out" message from
 * a wrapped race), network failures by the browser's opaque message or the
 * native path's descriptive keywords; everything else is left `unknown` so its
 * own message is preserved rather than being mislabeled.
 */
export function classifyFetchFailure(error: unknown): FetchFailure {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") {
    return { kind: "abort", label: "aborted", hint: null };
  }
  if (name === "TimeoutError") {
    return { kind: "timeout", label: "timed out", hint: TIMEOUT_HINT };
  }

  const lowerMessage = messageOf(error).toLowerCase();
  if (lowerMessage.includes("timed out") || lowerMessage.includes("timeout")) {
    return { kind: "timeout", label: "timed out", hint: TIMEOUT_HINT };
  }
  if (isBrowserNetworkMessage(lowerMessage)) {
    return { kind: "network", label: "network/TLS/CORS", hint: NETWORK_HINT };
  }
  if (isNativeNetworkMessage(lowerMessage)) {
    return { kind: "network", label: "network", hint: NETWORK_HINT };
  }
  return { kind: "unknown", label: "request failed", hint: null };
}

/**
 * Builds a user-facing message for a failed request: the classified hint when
 * the failure is a recognized network/timeout kind, otherwise the error's own
 * message, falling back to the provided default. Used by the Add Data forms so
 * the originating UI surfaces an actionable hint rather than a bare "Failed to
 * fetch".
 */
export function fetchFailureMessage(error: unknown, fallback: string): string {
  const { hint } = classifyFetchFailure(error);
  if (hint) return hint;
  const message = messageOf(error).trim();
  return message || fallback;
}
