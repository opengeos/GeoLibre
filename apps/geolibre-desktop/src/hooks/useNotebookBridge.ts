import { useAppStore } from "@geolibre/core";
import type maplibregl from "maplibre-gl";
import { type RefObject, useEffect } from "react";
import type { MapController } from "@geolibre/map";
import { createScriptingHandlers } from "../lib/scripting/scriptingApi";

// The host side of the notebook scripting bridge. This is the MIRROR of
// useCommandBridge: there, the app is the embedded iframe talking up to a host;
// here, the app is the host talking down to the notebook it embeds in the
// Notebook panel (JupyterLite on web, a JupyterLab server on desktop).
//
// A `geolibre` client running in the notebook kernel posts scripting commands to
// `window.parent` (this app); we run them against the SAME createScriptingHandlers
// surface used by the in-app console and the Jupyter widget, and post events
// (click/selection/layer changes) back down to the iframe.

interface CommandMessage {
  type: "geolibre:command";
  requestId: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Bridge the live app (as host) with a notebook embedded in the Notebook panel.
 *
 * Inbound: `geolibre:command` `{requestId, method, params}` from the notebook
 * iframe → the matching handler runs and a `geolibre:result`
 * `{requestId, ok, value?, error?}` is posted back (even on failure). A
 * `geolibre:notebook-ready` handshake marks the channel live so events flow.
 * Outbound: `geolibre:event` `{event, payload}` for user interaction.
 *
 * Trust: only messages whose `event.source` is the notebook iframe's own
 * `contentWindow` are accepted, so an unrelated frame cannot drive the map.
 *
 * @param iframeRef - Ref to the notebook `<iframe>` (its `contentWindow` is the
 *   trusted peer and the target for replies/events).
 * @param mapControllerRef - Ref to the live map controller, read lazily by the
 *   command handlers.
 */
export function useNotebookBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  mapControllerRef: RefObject<MapController | null>,
): void {
  useEffect(() => {
    const controller = () => mapControllerRef.current;
    const handlers = createScriptingHandlers({ getController: controller });

    // The notebook iframe's expected origin, derived from its src — same-origin
    // on web (JupyterLite), the loopback server origin on desktop. Used both to
    // reject messages from a different origin (a WindowProxy can outlive a
    // navigation, so event.source alone is not enough) and to scope replies.
    const expectedOrigin = (): string | null => {
      const src = iframeRef.current?.src;
      if (!src) return null;
      try {
        return new URL(src, window.location.href).origin;
      } catch {
        return null;
      }
    };
    // Start scoped to the expected origin (not "*") so even the first reply is
    // not broadcast; refined to the actual origin once a message is accepted.
    let frameOrigin = expectedOrigin() ?? window.location.origin;
    // Whether the notebook client has announced itself; gates outbound events.
    let connected = false;

    const frameWindow = (): Window | null =>
      iframeRef.current?.contentWindow ?? null;

    const reply = (requestId: string, ok: boolean, extra: object) => {
      const win = frameWindow();
      if (!win) return;
      win.postMessage(
        { type: "geolibre:result", requestId, ok, ...extra },
        frameOrigin,
      );
    };

    const handleCommand = async (message: CommandMessage) => {
      // Own-property only, so an inherited member ("constructor", …) can never
      // be invoked as a command.
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
      // Trust only the notebook iframe's own window AND its expected origin (so a
      // page navigated into the same frame slot can't drive the map).
      const win = frameWindow();
      if (!win || event.source !== win) return;
      const allowed = expectedOrigin();
      if (allowed && event.origin !== allowed) return;
      if (event.origin && event.origin !== "null") frameOrigin = event.origin;
      const data = event.data as
        | { type?: string; requestId?: unknown }
        | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "geolibre:notebook-ready") {
        connected = true;
        return;
      }
      if (
        data.type === "geolibre:command" &&
        typeof data.requestId === "string"
      ) {
        void handleCommand(data as CommandMessage);
      }
    };

    const emit = (eventName: string, payload: unknown) => {
      if (!connected) return;
      const win = frameWindow();
      if (!win) return;
      win.postMessage(
        { type: "geolibre:event", event: eventName, payload },
        frameOrigin,
      );
    };

    window.addEventListener("message", handleMessage);

    // Selection / layer-set events from the store (same tracking as
    // useCommandBridge), pushed down to the notebook.
    let prevSelectedLayer = useAppStore.getState().selectedLayerId;
    let prevSelectedFeature = useAppStore.getState().selectedFeatureId;
    let prevLayerIds = useAppStore
      .getState()
      .layers.map((layer) => layer.id)
      .join(" ");
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
      const layerIds = state.layers.map((layer) => layer.id).join(" ");
      if (layerIds !== prevLayerIds) {
        prevLayerIds = layerIds;
        emit("layer-change", { layerIds: state.layers.map((l) => l.id) });
      }
    });

    // Map click events. The controller/map appear asynchronously after the map
    // loads, so poll on animation frames until the map exists, then attach.
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
    // Mount-only: both refs are stable and read lazily inside the closures.
  }, [iframeRef, mapControllerRef]);
}
