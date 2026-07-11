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
// case-insensitively against the error text (with any embedded request URL
// stripped first — see `classifyFetchFailure`) so the native path can be
// narrowed to a network failure even though it never throws a browser
// TypeError. Because the URL is removed before matching, a word appearing only
// in the URL's path or query (e.g. a `/certificate` path or `?timeout=30`
// param) cannot collide with these keywords.
const NATIVE_NETWORK_KEYWORDS = [
  "certificate",
  "tls",
  "ssl",
  "handshake",
  "dns error",
  "failed to lookup",
  "connection refused",
  "connection reset",
  "connect error",
  "tcp connect",
  "unreachable",
  "os error",
];

// Shown for a browser fetch failure: the browser cannot say which of these
// happened, and the desktop app bypasses browser CORS, so "try the desktop app"
// is genuinely useful advice here.
const BROWSER_NETWORK_HINT =
  "The request could not be completed. In the browser this is usually a CORS rejection (the server sent no Access-Control-Allow-Origin header for this origin), a TLS/certificate error, blocked mixed content, or an unreachable host. Try the desktop app, which is not subject to browser CORS, or check the host's certificate, firewall, and proxy rules.";

// Shown for a native (Tauri/reqwest) failure: this path already runs in the
// desktop app and is not subject to browser CORS, so the CORS / "try the desktop
// app" advice is dropped and only the transport-level guidance is kept.
const NATIVE_NETWORK_HINT =
  "The request could not be completed. This is usually a TLS/certificate error, a DNS failure, a refused connection, or an unreachable host. Check the host's certificate, firewall, and proxy rules.";

const TIMEOUT_HINT =
  "The request exceeded its time limit. The host may be slow, unreachable, or blocked by a firewall or proxy.";

/**
 * Reads an error's `name` and `message` across the shapes fetch failures arrive
 * in. `DOMException` (e.g. an `AbortError`/`TimeoutError` from
 * `AbortSignal.timeout()`) is not guaranteed to be `instanceof Error` on every
 * runtime — notably a known inconsistency on WebKit, the desktop app's macOS
 * webview — so it is matched explicitly, mirroring the guard in `diagnostics.ts`.
 */
function errorNameAndMessage(error: unknown): { name: string; message: string } {
  if (error instanceof Error || error instanceof DOMException) {
    return { name: error.name, message: error.message };
  }
  if (typeof error === "string") return { name: "", message: error };
  return { name: "", message: "" };
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
  const { name, message } = errorNameAndMessage(error);
  if (name === "AbortError") {
    return { kind: "abort", label: "aborted", hint: null };
  }
  if (name === "TimeoutError") {
    return { kind: "timeout", label: "timed out", hint: TIMEOUT_HINT };
  }

  const lowerMessage = message.toLowerCase();
  // The browser's opaque TypeError carries no URL, so match it on the full text.
  if (isBrowserNetworkMessage(lowerMessage)) {
    return {
      kind: "network",
      label: "network/TLS/CORS",
      hint: BROWSER_NETWORK_HINT,
    };
  }
  // A native reqwest error embeds the full request URL (usually in parens);
  // strip it before keyword/timeout matching so a word in the URL's path or
  // query — a `?timeout=30` param, a `/certificate` path — cannot collide with a
  // keyword and misclassify the failure.
  const causeText = lowerMessage
    .replace(/\(https?:\/\/[^)]*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  if (causeText.includes("timed out") || causeText.includes("timeout")) {
    return { kind: "timeout", label: "timed out", hint: TIMEOUT_HINT };
  }
  if (isNativeNetworkMessage(causeText)) {
    return { kind: "network", label: "network", hint: NATIVE_NETWORK_HINT };
  }
  return { kind: "unknown", label: "request failed", hint: null };
}
