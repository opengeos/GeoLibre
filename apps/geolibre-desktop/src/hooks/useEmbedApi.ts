import { useAppStore } from "@geolibre/core";
import type { GeoLibreLayer } from "@geolibre/core";
import { type RefObject, useEffect } from "react";
import type { MapController } from "@geolibre/map";
import { captureMapImage } from "../lib/print-layout-export";
import {
  EMBED_ORIGIN_WILDCARD,
  buildEmbedEvent,
  isEmbedOriginAllowed,
  parseEmbedRequest,
  readEmbedOrigins,
  resolveHighlightIds,
  type EmbedCommand,
  type EmbedEventType,
} from "../lib/embed-api";
import { fetchProjectFromUrl, projectUrlFromLocation } from "../lib/project-url";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import { isKnownWhiteboxToolId } from "../lib/whitebox-tool-url";

// Runtime `postMessage` API for a host page that frames GeoLibre (issue #1462).
// Where `?url=`, `?maponly`, and `?tool=` configure the app once at load time,
// this lets the host keep talking to a live map: fly to a record the user just
// clicked in the host UI, highlight it, open a processing tool, and learn when
// the user selects a feature, moves the map, or finishes a tool — all without
// reloading the iframe and throwing away the session.
//
// Trust: unlike the Jupyter bridges (which trust the page that embeds them), the
// host here is a third party, so the API stays off until the deployment names
// the origins it trusts via GEOLIBRE_EMBED_ORIGINS. Every inbound message is
// checked against that list and every outbound message is scoped to a listed
// origin, never "*" (unless the operator configured the "*" wildcard).

/** Minimum gap between `viewChanged` events while the user drags the map. */
const VIEW_THROTTLE_MS = 250;

/**
 * Bridges a framed GeoLibre with an arbitrary host page over a versioned
 * `postMessage` protocol.
 *
 * Host → app: `loadProject`, `setView`, `highlightFeature`, `openTool`.
 * App → host: `ready`, `ack`, `projectLoaded`, `selectionChanged`,
 * `viewChanged`, `toolCompleted`, `serverFileWritten`.
 *
 * The hook is an inert no-op unless the app is framed AND the deployment
 * configured an origin allowlist (see {@link readEmbedOrigins}); a public build
 * with no allowlist can never be driven by the page that frames it.
 *
 * @param mapControllerRef - Ref to the live map controller (shared with
 *   MapCanvas and the other bridges), used to drive and read the camera.
 */
export function useEmbedApi(mapControllerRef: RefObject<MapController | null>): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const allowedOrigins = readEmbedOrigins();
    if (allowedOrigins.length === 0) return;
    const host = window.parent;
    // Not framed: there is no host to talk to (the app is the top-level page).
    if (!host || host === window) return;

    const wildcard = allowedOrigins.includes(EMBED_ORIGIN_WILDCARD);
    // Learned from the host's first allowed message; until then broadcasts go to
    // each configured origin, so the host never has to speak first to hear
    // `ready`. Scoping to the exact origin afterwards keeps later payloads off
    // any other frame that happens to share the allowlist.
    let hostOrigin: string | null = null;
    let hostVersion: 1 | 2 = 2;
    let disposed = false;

    const emit = (type: EmbedEventType, payload: Record<string, unknown>) => {
      if (disposed) return;
      const message = buildEmbedEvent(type, payload, hostVersion);
      const targets = hostOrigin
        ? [hostOrigin]
        : wildcard
          ? [EMBED_ORIGIN_WILDCARD]
          : allowedOrigins;
      for (const target of targets) {
        try {
          host.postMessage(message, target);
        } catch (error) {
          console.error("[GeoLibre] Failed to post embed event", error);
        }
      }
    };

    const ack = (requestId: string | null, ok: boolean, error?: string, result?: unknown) => {
      if (!requestId) return;
      emit("ack", {
        requestId,
        ok,
        ...(error ? { error } : {}),
        ...(result === undefined ? {} : { result }),
      });
    };

    const controller = () => mapControllerRef.current;

    // -- verbs ---------------------------------------------------------------

    // The URL the current project came from, echoed in `projectLoaded` so the
    // host can tell its own load from one the user triggered.
    let projectSourceUrl: string | null = projectUrlFromLocation();
    let loadAbort: AbortController | null = null;

    const loadProjectFromUrl = async (url: string) => {
      // A second load supersedes the first; otherwise a slow fetch could land
      // after a newer one and leave the map showing the wrong project.
      loadAbort?.abort();
      const abort = new AbortController();
      loadAbort = abort;
      const project = await fetchProjectFromUrl(url, { signal: abort.signal });
      const resolved = await resolveProjectXyzLayers(project, abort.signal);
      if (abort.signal.aborted) return;
      projectSourceUrl = url;
      // Host-driven loads are transient deep links, like `?url=`: they are not
      // added to the recent-projects list.
      useAppStore.getState().loadProject(resolved, null, { rememberRecent: false });
    };

    const applySetView = (command: Extract<EmbedCommand, { type: "setView" }>) => {
      const map = controller();
      if (!map) throw new Error("The map is not ready yet");
      if (command.target.kind === "bbox") map.fitBounds(command.target.bbox);
      else {
        const { kind: _kind, ...camera } = command.target;
        map.flyTo(camera);
      }
    };

    const applyHighlight = (command: Extract<EmbedCommand, { type: "highlightFeature" }>) => {
      const { target } = command;
      const state = useAppStore.getState();
      const layer = state.layers.find((item) => item.id === target.layerId);
      if (!layer) throw new Error(`No layer with id "${target.layerId}"`);
      const ids = resolveHighlightIds(layer.geojson?.features ?? [], target);
      // A request that names nothing is the documented "clear the highlight"
      // form. A request that DOES name features but resolves to none is a
      // failure, not a clear: the id may be a typo, or the layer may keep its
      // features in its MapLibre source rather than `geojson` (vector tiles,
      // source-owned layers), where nothing can be resolved here. Report that
      // instead of wiping the user's selection behind an `ok` ack.
      const askedForFeatures = target.featureIds.length > 0 || target.filter !== null;
      if (askedForFeatures && ids.length === 0) {
        throw new Error(
          `highlightFeature matched no features in layer "${target.layerId}"` +
            (layer.geojson ? "" : " (the layer's features are not readable from the store)"),
        );
      }
      // Drive the store as well as the map so the Attribute table and Layers
      // panel agree with what the host highlighted, exactly as a map click does.
      state.selectLayer(target.layerId);
      state.selectFeatures(ids);
      controller()?.highlightFeature(layer, ids, { fit: target.fit });
      return ids;
    };

    const applyOpenTool = (command: Extract<EmbedCommand, { type: "openTool" }>) => {
      const state = useAppStore.getState();
      if (!isKnownWhiteboxToolId(command.id)) {
        // Mirror `?tool=<unknown>`: open Processing without a preselection
        // rather than silently doing nothing.
        state.setProcessingInitialTool(null);
        state.setProcessingOpen(true);
        throw new Error(`Unknown tool "${command.id}"`);
      }
      if (Object.keys(command.params).length > 0) {
        state.setProcessingRerun({
          kind: "whitebox",
          toolId: command.id,
          parameters: command.params,
        });
      }
      state.setProcessingInitialTool(command.id);
      state.setProcessingOpen(true);
    };

    const requireLayer = (layerId: string) => {
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (!layer) throw new Error(`No layer with id "${layerId}"`);
      return layer;
    };

    const runCommand = async (command: EmbedCommand): Promise<unknown> => {
      switch (command.type) {
        case "loadProject":
          await loadProjectFromUrl(command.url);
          return;
        case "setView":
          applySetView(command);
          return;
        case "highlightFeature":
          applyHighlight(command);
          return;
        case "openTool":
          applyOpenTool(command);
          return;
        case "setLayerVisibility":
          requireLayer(command.layerId);
          useAppStore.getState().setLayerVisibility(command.layerId, command.visible);
          return;
        case "listLayers":
          return useAppStore.getState().layers.map(({ id, name, type, visible, opacity }) => ({
            id,
            name,
            type,
            visible,
            opacity,
          }));
        case "setFilter":
          requireLayer(command.layerId);
          useAppStore.getState().updateLayer(command.layerId, {
            embedFilter: command.expression ?? undefined,
          });
          return;
        case "getViewport": {
          const view = controller()?.readView();
          if (!view) throw new Error("The map is not ready yet");
          return view;
        }
        case "addLayer": {
          const state = useAppStore.getState();
          if (state.layers.some((layer) => layer.id === command.spec.id)) {
            throw new Error(`A layer with id "${command.spec.id}" already exists`);
          }
          const spec = command.spec;
          const layer: GeoLibreLayer = {
            id: spec.id,
            name: spec.name,
            type: spec.type as GeoLibreLayer["type"],
            source: spec.source,
            visible: spec.visible ?? true,
            opacity: spec.opacity ?? 1,
            style: (spec.style ?? {}) as unknown as GeoLibreLayer["style"],
            metadata: spec.metadata ?? {},
            ...(spec.geojson ? { geojson: spec.geojson as GeoLibreLayer["geojson"] } : {}),
            ...(spec.beforeId ? { beforeId: spec.beforeId } : {}),
          };
          state.addLayer(layer);
          return layer.id;
        }
        case "exportImage": {
          const map = controller()?.getMap();
          if (!map) throw new Error("The map is not ready yet");
          return captureMapImage(map).image.toDataURL("image/png");
        }
      }
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== host) return;
      if (!isEmbedOriginAllowed(event.origin, allowedOrigins)) return;
      const request = parseEmbedRequest(event.data);
      if (!request) return;
      // A valid, allowed message identifies the host: scope every later event to
      // exactly this origin. ("null" is an opaque origin, only reachable under
      // the wildcard, and cannot be used as a postMessage target.)
      if (!hostOrigin && event.origin && event.origin !== "null") hostOrigin = event.origin;
      const requestedVersion = (event.data as { v?: unknown }).v;
      hostVersion = requestedVersion === 1 ? 1 : 2;
      if ("error" in request) {
        ack(request.requestId, false, request.error);
        return;
      }
      void runCommand(request.command).then(
        (result) => ack(request.requestId, true, undefined, result),
        (error: unknown) => {
          ack(request.requestId, false, error instanceof Error ? error.message : String(error));
        },
      );
    };

    window.addEventListener("message", handleMessage);

    // -- events --------------------------------------------------------------

    const store = useAppStore.getState();
    let prevGeneration = store.projectGeneration;
    let prevSelectedLayer = store.selectedLayerId;
    let prevSelection = store.selectedFeatureIds.join(" ");
    const emittedRuns = new Set(store.processingHistory.map((run) => run.id));

    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.projectGeneration !== prevGeneration) {
        prevGeneration = state.projectGeneration;
        emit("projectLoaded", {
          url: projectSourceUrl,
          name: state.projectName,
          layerIds: state.layers.map((layer) => layer.id),
        });
      }
      const selection = state.selectedFeatureIds.join(" ");
      if (selection !== prevSelection || state.selectedLayerId !== prevSelectedLayer) {
        prevSelection = selection;
        prevSelectedLayer = state.selectedLayerId;
        emit("selectionChanged", {
          layerId: state.selectedLayerId,
          featureIds: [...state.selectedFeatureIds],
        });
      }
      for (const run of state.processingHistory) {
        if (emittedRuns.has(run.id)) continue;
        emittedRuns.add(run.id);
        emit("toolCompleted", {
          id: run.toolId,
          name: run.toolName,
          status: run.status,
          engine: run.engine,
          durationMs: run.durationMs,
          outputLayerNames: run.outputLayerNames ?? [],
          ...(run.error ? { error: run.error } : {}),
        });
        // File-based tools (the sidecar's conversion/Whitebox jobs) record where
        // they wrote; surface that as its own event so a host can pick the file
        // up server-side.
        if (run.status === "success" && run.outputPath) {
          emit("serverFileWritten", { path: run.outputPath, toolId: run.toolId });
        }
      }
    });

    // Camera events. The controller and its map appear asynchronously, so poll
    // animation frames until the map exists (same pattern as useCommandBridge).
    let viewMap: ReturnType<MapController["getMap"]> | null = null;
    let lastViewAt = 0;
    let trailingTimer: number | null = null;
    const postView = () => {
      const view = controller()?.readView();
      if (!view) return;
      lastViewAt = Date.now();
      emit("viewChanged", {
        bbox: view.bbox ?? null,
        center: view.center,
        zoom: view.zoom,
        bearing: view.bearing,
        pitch: view.pitch,
      });
    };
    const onMapMove = () => {
      const elapsed = Date.now() - lastViewAt;
      if (elapsed >= VIEW_THROTTLE_MS) {
        if (trailingTimer !== null) {
          window.clearTimeout(trailingTimer);
          trailingTimer = null;
        }
        postView();
        return;
      }
      // Within the throttle window: schedule the trailing edge so the host still
      // gets the final position of a drag.
      if (trailingTimer !== null) return;
      trailingTimer = window.setTimeout(() => {
        trailingTimer = null;
        postView();
      }, VIEW_THROTTLE_MS - elapsed);
    };
    let rafId: number | null = null;
    const attach = () => {
      const map = controller()?.getMap();
      if (!map) {
        rafId = requestAnimationFrame(attach);
        return;
      }
      viewMap = map;
      map.on("move", onMapMove);
      map.on("moveend", onMapMove);
    };
    rafId = requestAnimationFrame(attach);

    emit("ready", { version: __GEOLIBRE_VERSION__ });
    // Existing v1 hosts filter by the envelope version. Announce both versions
    // until the first request identifies which one this host speaks.
    hostVersion = 1;
    emit("ready", { version: __GEOLIBRE_VERSION__ });
    hostVersion = 2;

    return () => {
      disposed = true;
      window.removeEventListener("message", handleMessage);
      unsubscribe();
      loadAbort?.abort();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (trailingTimer !== null) window.clearTimeout(trailingTimer);
      viewMap?.off("move", onMapMove);
      viewMap?.off("moveend", onMapMove);
    };
    // Mount-only: mapControllerRef is a stable ref read lazily inside handlers.
  }, [mapControllerRef]);
}
