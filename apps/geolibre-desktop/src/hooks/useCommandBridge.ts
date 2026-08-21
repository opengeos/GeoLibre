import { useAppStore } from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import { type RefObject, useEffect } from "react";
import type { MapController } from "@geolibre/map";
import { getEmbedHost, isEmbedded } from "./embedHost";
import { createScriptingHandlers } from "../lib/scripting/scriptingApi";

// Request/reply + event channel that backs the Python scripting API. Where
// useEmbedBridge syncs the whole project, this handles the things the project
// trait cannot express: live reads (camera, identify, layer features, a map
// screenshot), imperative animation (flyTo/fitBounds), running processing
// algorithms, and pushing user-interaction events (click, selection, layer
// changes) back to Python. It rides the SAME postMessage host as useEmbedBridge.
// The command implementations are shared with the in-app Python console via
// createScriptingHandlers.

interface CommandMessage {
  type: "geolibre:command";
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Bridges the running app with the GeoLibre Python widget's scripting API over
 * `window.postMessage`, using a request/reply protocol on top of anywidget's
 * custom-message channel (relayed by `_frontend.js`).
 *
 * Inbound: `geolibre:command` `{requestId, method, params}` → the matching
 * handler runs and a `geolibre:result` `{requestId, ok, value?, error?}` is
 * ALWAYS posted back (even on failure) so the blocking Python caller never
 * hangs. Outbound: `geolibre:event` `{event, payload}` for user interaction.
 *
 * Outside an embedding host the hook is an inert no-op.
 *
 * @param mapControllerRef - Ref to the live map controller (the same ref
 *   useEmbedBridge and MapCanvas share), used to read/drive the camera and query
 *   rendered features.
 */
export function useCommandBridge(mapControllerRef: RefObject<MapController | null>): void {
  useEffect(() => {
    if (!isEmbedded()) return;
    const hostChannel = getEmbedHost();
    const host = hostChannel.window;

    const controller = () => mapControllerRef.current;

    // Command implementations are shared with the in-app Python console. A thrown
    // handler is turned into an `ok:false` reply by the caller below.
    const handlers = createScriptingHandlers({ getController: controller });

    const reply = (requestId: string, ok: boolean, extra: object) => {
      host.postMessage(
        { type: "geolibre:result", requestId, ok, ...extra },
        hostChannel.targetOrigin(),
      );
    };

    const handleCommand = async (message: CommandMessage) => {
      // Own-property only, so an inherited member ("constructor", "toString", …)
      // can never be invoked as a command.
      const handler = Object.hasOwn(handlers, message.method)
        ? handlers[message.method]
        : undefined;
      if (!handler) {
        reply(message.requestId, false, {
          error: `Unknown command "${message.method}"`,
        });
        return;
      }
      try {
        const value = await handler(message.params ?? {});
        reply(message.requestId, true, { value });
      } catch (error) {
        reply(message.requestId, false, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const handleMessage = (event: MessageEvent) => {
      // Same trust rule as the project bridge: only the embedding host. note()
      // also marks the shared handshake and learns the host origin.
      if (!hostChannel.note(event)) return;
      const data = event.data as Partial<CommandMessage> | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "geolibre:command" && typeof data.requestId === "string") {
        void handleCommand(data as CommandMessage);
      }
    };

    // Emit a user-interaction event to Python. Gated on the handshake so a silent
    // third-party frame that embeds a `?embed=1` export never receives events.
    const emit = (eventName: string, payload: unknown) => {
      if (!hostChannel.handshakeComplete) return;
      host.postMessage(
        { type: "geolibre:event", event: eventName, payload },
        hostChannel.targetOrigin(),
      );
    };

    window.addEventListener("message", handleMessage);

    // Selection / layer-set events from the store. Track the previous values so a
    // single subscription can tell which of the two changed.
    let prevSelectedLayer = useAppStore.getState().selectedLayerId;
    let prevSelectedFeature = useAppStore.getState().selectedFeatureId;
    let prevLayerIds = useAppStore
      .getState()
      .layers.map((layer) => layer.id)
      .join("\0");
    const unsubscribe = useAppStore.subscribe((state) => {
      if (
        state.selectedLayerId !== prevSelectedLayer ||
        state.selectedFeatureId !== prevSelectedFeature
      ) {
        prevSelectedLayer = state.selectedLayerId;
        prevSelectedFeature = state.selectedFeatureId;
        emit("selection-change", {
          layerId: state.selectedLayerId,
          featureId: state.selectedFeatureId,
        });
      }
      const layerIds = state.layers.map((layer) => layer.id).join("\0");
      if (layerIds !== prevLayerIds) {
        prevLayerIds = layerIds;
        emit("layer-change", { layerIds: state.layers.map((l) => l.id) });
      }
    });

    // Map click events. The controller (and its map) become available
    // asynchronously after the map loads, so poll on animation frames until the
    // map exists, then attach the listener.
    let clickMap: ReturnType<MapController["getMap"]> | null = null;
    const onMapClick = (event: maplibregl.MapMouseEvent) => {
      const lngLat: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      emit("click", {
        lngLat,
        features: controller()?.identifyFeatures(lngLat) ?? [],
      });
    };
    let rafId: number | null = null;
    const attachClick = () => {
      const map = controller()?.getMap();
      if (map) {
        clickMap = map;
        map.on("click", onMapClick);
        return;
      }
      rafId = requestAnimationFrame(attachClick);
    };
    rafId = requestAnimationFrame(attachClick);

    return () => {
      window.removeEventListener("message", handleMessage);
      unsubscribe();
      if (rafId !== null) cancelAnimationFrame(rafId);
      clickMap?.off("click", onMapClick);
    };
    // Mount-only: mapControllerRef is a stable ref read lazily inside handlers.
  }, [mapControllerRef]);
}
