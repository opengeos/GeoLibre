import { type RefObject, useEffect } from "react";
import type { MapController } from "@geolibre/map";
import { subscribeJupyterServer } from "../lib/jupyter";
import {
  type RelayCommand,
  type RelayResult,
  parseRelayMessage,
  relayReconnectDelay,
  relaySocketUrl,
  runRelayCommand,
} from "../lib/jupyter-relay";
import { createScriptingHandlers } from "../lib/scripting/scriptingApi";

// The app side of the desktop Jupyter map-command relay. This is the SIBLING of
// useNotebookBridge: that one receives commands over postMessage from the
// notebook iframe the app embeds, which only works while the notebook is
// rendered inside the Notebook panel. This one subscribes to a loopback
// WebSocket on the Jupyter server itself, so a kernel driven by ANY frontend —
// notably VS Code's Jupyter extension attached to the same server — reaches the
// same map (issue #1442).
//
// Both feed the SAME createScriptingHandlers surface used by the in-app Python
// console and the Jupyter widget, so behaviour cannot drift between transports.

/**
 * Subscribe to the desktop Jupyter server's map-command relay for the app's
 * lifetime, running each relayed command against the live map.
 *
 * Connects whenever a Jupyter server is running (started by the Notebook panel)
 * and reconnects with backoff if the socket drops. Inert on web and on desktop
 * until a server has been started.
 *
 * @param mapControllerRef - Ref to the live map controller, read lazily by the
 *   command handlers.
 */
export function useJupyterRelay(mapControllerRef: RefObject<MapController | null>): void {
  useEffect(() => {
    const handlers = createScriptingHandlers({
      getController: () => mapControllerRef.current,
    });

    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // Bumped on every server change/unmount so a socket opened for a previous
    // server can never resurrect the reconnect loop after we moved on.
    let generation = 0;

    const reply = (activeSocket: WebSocket, payload: RelayResult) => {
      if (activeSocket.readyState !== WebSocket.OPEN) return;
      try {
        activeSocket.send(JSON.stringify(payload));
      } catch (error) {
        console.warn("Jupyter relay: could not return a command result", error);
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

    const unsubscribe = subscribeJupyterServer((info) => {
      close();
      if (!info) return;
      const mine = generation;
      attempt = 0;

      const connect = () => {
        if (generation !== mine) return;
        let next: WebSocket;
        try {
          next = new WebSocket(relaySocketUrl(info));
        } catch (error) {
          console.warn("Jupyter relay: could not open the command socket", error);
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
          // The server outlives a dropped socket (it runs for the app's
          // lifetime), so keep retrying rather than giving up on the channel.
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
    // Mount-only: the ref is stable and read lazily inside the handlers.
  }, [mapControllerRef]);
}
