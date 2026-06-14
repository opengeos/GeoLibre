// WebSocket transport for live collaboration (issue #307).
//
// `resolveCollabBaseUrl` gates the whole feature: it returns the validated relay
// base (a `wss://` host, or `ws://` on loopback for `wrangler dev`) or `null`
// when unset/misconfigured, in which case the collaboration UI stays hidden and
// the hook is an inert no-op. The session-create REST call and the WebSocket URL
// are both derived from this one base.

import type { ClientMessage, ServerMessage } from "./collab-protocol";
import type { CollaborationMode } from "@geolibre/core";

export interface CreateSessionResult {
  sessionId: string;
  hostToken: string;
  mode: CollaborationMode;
}

const CREATE_TIMEOUT_MS = 15_000;
// Reconnect backoff bounds; jittered between attempts.
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * Resolve the collaboration relay base from the Vite env, returning `null` when
 * unset or invalid so callers can keep the feature dark.
 *
 * Only `wss://` (or `ws://` on loopback for local `wrangler dev`) is accepted,
 * mirroring `resolveShareBaseUrl`: parse the URL and match the hostname exactly
 * so a value like `ws://localhost.evil.com` is rejected.
 *
 * @param configured - The raw env value; defaults to `VITE_GEOLIBRE_COLLAB_URL`.
 * @returns The trimmed base URL without a trailing slash, or `null`.
 */
export function resolveCollabBaseUrl(
  configured: unknown = import.meta.env?.VITE_GEOLIBRE_COLLAB_URL,
): string | null {
  if (typeof configured !== "string" || !configured.trim()) return null;
  const trimmed = configured.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (
      url.protocol === "wss:" ||
      (url.protocol === "ws:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
    ) {
      return trimmed;
    }
  } catch {
    // Invalid URL; treat as unconfigured.
  }
  return null;
}

/** Map a `ws(s)://` base to its `http(s)://` origin for the REST create call. */
export function httpBaseFromWs(wsBase: string): string {
  return wsBase.replace(/^ws/, "http");
}

/** Build the WebSocket join URL for a session code. */
export function sessionWsUrl(wsBase: string, sessionId: string): string {
  return `${wsBase}/sessions/${encodeURIComponent(sessionId)}/ws`;
}

/**
 * Create a new session on the relay and return its shareable code plus the host
 * token (which only the creator ever sees, so a guest can't claim host).
 *
 * @param mode - Initial session mode (view-only or co-edit).
 * @param baseUrl - Override the relay base; defaults to the configured env value.
 * @param fetchImpl - Injected for testing; defaults to the global fetch.
 */
export async function createSession(
  mode: CollaborationMode,
  baseUrl: string | null = resolveCollabBaseUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<CreateSessionResult> {
  if (!baseUrl) {
    throw new Error("Live collaboration is not configured.");
  }
  const httpBase = httpBaseFromWs(baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(`${httpBase}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Timed out creating the session. Please try again.");
    }
    throw new Error("Could not reach the collaboration server.");
  }
  if (!response.ok) {
    throw new Error(`Could not create the session (HTTP ${response.status}).`);
  }
  const payload = (await response.json().catch(() => ({}))) as
    | Partial<CreateSessionResult>
    | undefined;
  if (!payload?.sessionId || !payload.hostToken) {
    throw new Error("The collaboration server returned an unexpected response.");
  }
  return {
    sessionId: payload.sessionId,
    hostToken: payload.hostToken,
    mode: payload.mode === "view-only" ? "view-only" : "co-edit",
  };
}

export interface CollabConnectionHandlers {
  onOpen: () => void;
  onMessage: (message: ServerMessage) => void;
  /** Fired on each disconnect; `reconnecting` is false once we give up/close. */
  onClose: (reconnecting: boolean) => void;
}

/**
 * A reconnecting WebSocket wrapper around one collaboration session. It parses
 * inbound frames into `ServerMessage`s and reconnects with jittered exponential
 * backoff until {@link close} is called.
 */
export class CollabConnection {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: CollabConnectionHandlers,
    // Injected in tests; defaults to the global WebSocket.
    private readonly WebSocketImpl: typeof WebSocket = WebSocket,
  ) {}

  connect(): void {
    this.closedByUs = false;
    this.open();
  }

  private open(): void {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.attempt = 0;
      this.handlers.onOpen();
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handlers.onMessage(message);
    });
    ws.addEventListener("close", () => {
      if (this.closedByUs) {
        this.handlers.onClose(false);
        return;
      }
      this.handlers.onClose(true);
      this.scheduleReconnect();
    });
    // An error is always followed by a close event, where reconnect is handled.
    ws.addEventListener("error", () => {});
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** this.attempt,
    );
    this.attempt += 1;
    // Jitter avoids a thundering herd when a relay restarts and every client
    // reconnects at once.
    const jittered = delay / 2 + (delay / 2) * pseudoJitter(this.attempt);
    this.reconnectTimer = setTimeout(() => this.open(), jittered);
  }

  /** Send a client message if the socket is open; silently drops otherwise. */
  send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === this.WebSocketImpl.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /** Permanently close the connection and stop reconnecting. */
  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}

// Deterministic-per-attempt jitter in [0, 1) without Math.random, so reconnect
// timing stays testable while still spreading clients apart.
function pseudoJitter(attempt: number): number {
  const x = Math.sin(attempt * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
