import type { JupyterServerInfo } from "./jupyter";
import type { ScriptingHandlers } from "./scripting/scriptingApi";

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

/** The correlated reply the app sends back for a command carrying a requestId. */
export type RelayResult =
  | { type: "geolibre:result"; requestId: string; ok: true; value: unknown }
  | { type: "geolibre:result"; requestId: string; ok: false; error: string };

/**
 * Run one relayed command against the scripting handlers and build its reply.
 *
 * @param handlers - The scripting command surface (`createScriptingHandlers`).
 * @param command - The parsed command to run.
 * @returns The result to send back, or null for a fire-and-forget command (empty
 *   `requestId`) — the handler still ran, there is just nothing to correlate.
 */
export async function runRelayCommand(
  handlers: ScriptingHandlers,
  command: RelayCommand,
): Promise<RelayResult | null> {
  // Own-property only, so an inherited member ("constructor", …) can never be
  // invoked as a command.
  if (!Object.hasOwn(handlers, command.method)) {
    console.warn(`Jupyter relay: unknown command "${command.method}"`);
    return command.requestId
      ? {
          type: "geolibre:result",
          requestId: command.requestId,
          ok: false,
          error: `Unknown command "${command.method}"`,
        }
      : null;
  }
  try {
    const value = await handlers[command.method](command.params);
    return command.requestId
      ? { type: "geolibre:result", requestId: command.requestId, ok: true, value }
      : null;
  } catch (error) {
    console.error(`Jupyter relay: command "${command.method}" failed`, error);
    return command.requestId
      ? {
          type: "geolibre:result",
          requestId: command.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      : null;
  }
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
