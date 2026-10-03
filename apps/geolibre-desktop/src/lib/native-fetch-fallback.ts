/**
 * The desktop app's whole-file fetch tries the native client first (not subject
 * to webview CORS) and falls back to the webview's own `fetch` for what the
 * native client refuses or cannot reach (a loopback host the SSRF guard blocks,
 * a proxy or certificate only the system webview knows). This decides when that
 * fallback is worth making and which of the two errors the caller receives, so
 * a plugin is told what the server actually did (issue #2840).
 */

import { classifyFetchFailure } from "./fetch-error";
import { tileErrorStatus } from "./tile-retry";

/**
 * Statuses that depend on who asks. A WAF can refuse the native client's
 * `GeoLibre Desktop` user agent and still serve a browser, so these keep the
 * webview fallback; any other status is the server's answer to anyone.
 */
const CLIENT_DEPENDENT_STATUSES = new Set([401, 403]);

/**
 * Budget for the webview retry after the native client could not reach the
 * host at all (timeout, refused connection, DNS). The retry stays for networks
 * only the system webview can cross, such as a PAC proxy, which answer well
 * within this; for a host that is simply down it caps a wait the webview would
 * otherwise stretch to its own connect timeout (21 s on WebView2, minutes on
 * WebKitGTK).
 */
export const UNREACHABLE_WEBVIEW_BUDGET_MS = 10_000;

/** The error `fetchArrayBuffer` throws for a non-2xx webview response. */
const WEBVIEW_HTTP_STATUS = /^HTTP \d{3}\b/;

/**
 * Normalizes a rejection into an `Error`. Tauri's `invoke` rejects with the
 * command's plain string, which leaves a plugin reading `error.message` with
 * `undefined`; the text, and with it the status `tileErrorStatus` reads, is
 * kept as the message.
 *
 * @param error - The rejection value.
 * @returns The same value when it is already an `Error`, otherwise a wrapper.
 */
export function asFetchError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : String(error), { cause: error });
}

/**
 * Fetches through the native client, falling back to the webview only when the
 * server never answered the native request.
 *
 * - The native client got an HTTP error status: the server has spoken, and
 *   asking again from the webview could only lose that status to CORS. Its
 *   error is thrown without a second request. 401 and 403 are the exception,
 *   since they can depend on the client (see `CLIENT_DEPENDENT_STATUSES`).
 * - Any other native failure: the webview is tried, within
 *   {@link UNREACHABLE_WEBVIEW_BUDGET_MS} when the native client could not
 *   reach the host. If it fails too, the caller gets the native error, which
 *   names the reason (timeout, DNS, certificate), unless the webview reached
 *   the server and got a status of its own, which is then the more precise of
 *   the two.
 *
 * @param fetchNative - The native request.
 * @param fetchWebview - The webview request, made only when the fallback runs.
 *   It receives a signal to abort on when the retry has a time budget.
 * @returns Whichever request succeeded.
 */
export async function fetchNativeWithWebviewFallback<T>(
  fetchNative: () => Promise<T>,
  fetchWebview: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  let nativeError: unknown;
  try {
    return await fetchNative();
  } catch (error) {
    nativeError = error;
  }
  const nativeStatus = tileErrorStatus(nativeError);
  if (nativeStatus !== null && !CLIENT_DEPENDENT_STATUSES.has(nativeStatus)) {
    throw asFetchError(nativeError);
  }
  const signal = nativeCouldNotReachHost(nativeError)
    ? AbortSignal.timeout(UNREACHABLE_WEBVIEW_BUDGET_MS)
    : undefined;
  try {
    return await fetchWebview(signal);
  } catch (webviewError) {
    if (webviewError instanceof Error && WEBVIEW_HTTP_STATUS.test(webviewError.message)) {
      throw webviewError;
    }
    throw asFetchError(nativeError);
  }
}

/**
 * Whether a native failure happened before any response: a timeout, a DNS or
 * connection failure. reqwest's top-level "error sending request" carries no
 * cause (the backend formats only the outer error), but it is only ever raised
 * before a response arrives, so it counts too.
 *
 * @param error - The native rejection.
 * @returns True when the host was never reached.
 */
function nativeCouldNotReachHost(error: unknown): boolean {
  const { kind } = classifyFetchFailure(error);
  if (kind === "timeout" || kind === "network") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("error sending request");
}
