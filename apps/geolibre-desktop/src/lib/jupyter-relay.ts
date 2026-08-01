import type { JupyterServerInfo } from "./jupyter";

// Wire format for the desktop Jupyter map-command relay
// (backend/geolibre_server/geolibre_server/jupyter_relay.py). The relay lets a
// kernel drive the map regardless of which *frontend* is running the cell — the
// embedded Notebook panel, or an external client such as VS Code's Jupyter
// extension (issue #1442) — where the postMessage transport in useNotebookBridge
// only reaches the map from inside the app's own iframe.
//
// Pure helpers live here (not in the hook) so the protocol is unit-testable.

/** One scripting command relayed from a kernel, in the shared bridge envelope. */
export interface RelayCommand {
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

/** URL path the relay's endpoints are mounted under, mirroring `RELAY_PATH`. */
const RELAY_PATH = "geolibre/relay";

/**
 * Build the app-side WebSocket URL for a running Jupyter server.
 *
 * The token rides in the query string because a WebSocket handshake cannot carry
 * an `Authorization` header, and the server's session cookie is unavailable to
 * us (the app is a different origin than the loopback server).
 *
 * @param info - The running server's connection details.
 * @returns A `ws://` URL for the relay socket.
 */
export function relaySocketUrl(info: JupyterServerInfo): string {
  const url = new URL(`${info.url.replace(/\/+$/, "")}/${RELAY_PATH}/socket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (info.token) url.searchParams.set("token", info.token);
  return url.toString();
}

/**
 * Parse one relay frame into a command, rejecting anything malformed.
 *
 * @param data - The raw WebSocket payload.
 * @returns The command, or null for a non-command frame (e.g. the relay's
 *   `geolibre:relay-ready` greeting) or an unparseable one.
 */
export function parseRelayMessage(data: unknown): RelayCommand | null {
  if (typeof data !== "string") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const message = payload as {
    type?: unknown;
    requestId?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (message.type !== "geolibre:command") return null;
  if (typeof message.method !== "string" || !message.method) return null;
  const params =
    message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? (message.params as Record<string, unknown>)
      : {};
  return {
    requestId: typeof message.requestId === "string" ? message.requestId : "",
    method: message.method,
    params,
  };
}

/** Reconnect backoff (ms) after a dropped socket, capped so it stays responsive. */
export const RELAY_RECONNECT_MIN_MS = 1_000;
export const RELAY_RECONNECT_MAX_MS = 15_000;

/**
 * Next reconnect delay for a given consecutive-failure count (exponential).
 *
 * @param attempt - How many reconnects have already failed (0 for the first).
 * @returns The delay in milliseconds, capped at {@link RELAY_RECONNECT_MAX_MS}.
 */
export function relayReconnectDelay(attempt: number): number {
  const delay = RELAY_RECONNECT_MIN_MS * 2 ** Math.max(0, attempt);
  return Math.min(delay, RELAY_RECONNECT_MAX_MS);
}
