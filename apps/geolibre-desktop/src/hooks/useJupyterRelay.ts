import { type RefObject, useEffect } from "react";
import type { MapEngine } from "@geolibre/map";
import { subscribeJupyterServer } from "../lib/jupyter";
import {
  type RelayCommand,
  type RelayResult,
  encodeRelayResult,
  parseRelayMessage,
  relayReconnectDelay,
  relaySocketUrl,
  runRelayCommand,
} from "../lib/jupyter-relay";
import { connectLiveRelay, subscribeLiveRelayReady } from "../lib/live-relay";
import { isDesktopRuntime } from "../lib/is-mobile";
import { type ScriptingHandlers, createScriptingHandlers } from "../lib/scripting/scriptingApi";

// The app side of the desktop map-command relays. This is the SIBLING of
// useNotebookBridge: that one receives commands over postMessage from the
// notebook iframe the app embeds, which only works while the notebook is
// rendered inside the Notebook panel. This one subscribes to loopback
// WebSockets, so a kernel driven by ANY frontend (notably VS Code's Jupyter
// extension attached to the same server, issue #1442) or a Live MCP client
// reaches the same map.
//
// Two relays speak the same frames:
// - the Jupyter relay, on the JupyterLab server Processing -> Jupyter Notebook
//   starts, over a loopback WebSocket;
// - the desktop relay the Tauri shell hosts itself (lib/live-relay.ts), so Live
//   MCP works with no Python at all once the user allows it
//   (useLiveMcpStartup), including in the Mac App Store build. Its commands
//   arrive as Tauri events rather than over a socket.
//
// Both feed the SAME createScriptingHandlers surface used by the in-app Python
// console and the Jupyter widget, so behaviour cannot drift between transports.
//
// No result timeout is applied on this side: a processing run may take many
// minutes, and the relay that dispatched the command owns the wait.

/**
 * Keep one relay socket connected while `subscribe` reports a server.
 *
 * @param subscribe - Lifecycle source for the server hosting the relay.
 * @param socketUrl - Builds the relay WebSocket URL for that server.
 * @param handlers - The scripting command surface.
 * @param label - Names the relay in console warnings.
 * @returns A cleanup function that closes the socket and unsubscribes.
 */
function connectRelay<T>(
  subscribe: (listener: (info: T | null) => void) => () => void,
  socketUrl: (info: T) => string,
  handlers: ScriptingHandlers,
  label: string,
): () => void {
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  // Bumped on every server change/unmount so a socket opened for a previous
  // server can never resurrect the reconnect loop after we moved on.
  let generation = 0;

  const reply = (activeSocket: WebSocket, payload: RelayResult) => {
    if (activeSocket.readyState !== WebSocket.OPEN) return;
    try {
      activeSocket.send(encodeRelayResult(payload));
    } catch (error) {
      console.warn(`${label}: could not return a command result`, error);
    }
  };

  const run = async (command: RelayCommand, activeSocket: WebSocket) => {
    const result = await runRelayCommand(handlers, command);
    if (result) reply(activeSocket, result);
  };

  const close = () => {
    generation += 1;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // Drop the handlers first: onclose must not schedule a reconnect for a
    // socket we are deliberately tearing down.
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      socket = null;
    }
  };

  const unsubscribe = subscribe((info) => {
    close();
    if (!info) return;
    const mine = generation;
    attempt = 0;

    const connect = () => {
      if (generation !== mine) return;
      let next: WebSocket;
      try {
        next = new WebSocket(socketUrl(info));
      } catch (error) {
        console.warn(`${label}: could not open the command socket`, error);
        return;
      }
      socket = next;
      next.onopen = () => {
        attempt = 0;
      };
      next.onmessage = (event: MessageEvent) => {
        const command = parseRelayMessage(event.data);
        if (command) void run(command, next);
      };
      next.onclose = () => {
        if (generation !== mine) return;
        socket = null;
        // The server outlives a dropped socket (it runs until it is stopped,
        // which reports null here), so keep retrying.
        retryTimer = setTimeout(connect, relayReconnectDelay(attempt));
        attempt += 1;
      };
    };

    connect();
  });

  return () => {
    unsubscribe();
    close();
  };
}

/**
 * Subscribe to the desktop map-command relays for the app's lifetime, running
 * each relayed command against the live map.
 *
 * Connects to the Jupyter relay whenever a Jupyter server is running, and
 * reconnects with backoff if its socket drops. Subscribes to the desktop shell's
 * Live MCP relay whenever the user has allowed it. Inert on web.
 *
 * @param mapControllerRef - Ref to the live map controller, read lazily by the
 *   command handlers.
 */
export function useJupyterRelay(mapControllerRef: RefObject<MapEngine | null>): void {
  useEffect(() => {
    const handlers = createScriptingHandlers({
      getController: () => mapControllerRef.current,
    });
    const stopJupyter = connectRelay(
      subscribeJupyterServer,
      relaySocketUrl,
      handlers,
      "Jupyter relay",
    );
    const stopDesktop = isDesktopRuntime()
      ? connectLiveRelay(subscribeLiveRelayReady, handlers)
      : null;
    return () => {
      stopJupyter();
      stopDesktop?.();
    };
    // Mount-only: the ref is stable and read lazily inside the handlers.
  }, [mapControllerRef]);
}
