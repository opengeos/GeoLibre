import {
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
  type GeoLibreProject,
} from "@geolibre/core";
import { type RefObject, useEffect } from "react";
import type { MapController } from "@geolibre/map";
import { getPluginManager } from "./usePlugins";

// How long to wait after the last store change before posting a fresh project
// snapshot to the host. Coalesces the burst of store writes a single user
// action (adding a layer, panning) produces into one message.
const STATE_DEBOUNCE_MS = 250;

interface LoadProjectMessage {
  type: "geolibre:load-project";
  project: GeoLibreProject | string;
  seq?: number;
}

interface RequestStateMessage {
  type: "geolibre:request-state";
}

type InboundMessage = LoadProjectMessage | RequestStateMessage;

/**
 * Detects whether the app is running inside the GeoLibre Jupyter/embed host.
 *
 * The app is considered embedded when it is framed (a different `window.parent`)
 * or when it is opened with an explicit `?embed=1` query parameter, which lets
 * the host force the bridge on for a standalone `to_html()` export.
 *
 * @returns True when the postMessage bridge should be active.
 */
function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.parent && window.parent !== window) return true;
  } catch {
    // A cross-origin parent throws on access; being unable to read it at all
    // still means we are framed.
    return true;
  }
  const embed = new URLSearchParams(window.location.search).get("embed");
  return embed === "1" || embed === "true";
}

/**
 * Bridges the running app with an embedding host (the GeoLibre Python widget)
 * over `window.postMessage`.
 *
 * When embedded, the hook:
 * - applies a `geolibre:load-project` message by replacing the current project,
 * - posts a debounced `geolibre:state` snapshot whenever the store changes, so
 *   the host (and Python) sees map view, layer, and basemap edits,
 * - answers a `geolibre:request-state` with an immediate snapshot, and
 * - announces `geolibre:ready` on mount so the host can flush queued messages.
 *
 * Loop prevention lives on the host side: the host does not echo a project it
 * received from the app back into the iframe. Outside an embedding host the
 * hook is an inert no-op.
 *
 * @param mapControllerRef - Ref to the live map controller, read so the emitted
 *   snapshot captures the current camera (pan/zoom) rather than only the store.
 */
export function useEmbedBridge(
  mapControllerRef: RefObject<MapController | null>,
): void {
  useEffect(() => {
    if (!isEmbedded()) return;
    // The host is the embedding parent (the Jupyter/embed widget). In a browser
    // `window.parent` is always defined; when the app is the top-level document
    // (the `?embed=1` self-test) it is `window` itself, so the bridge naturally
    // posts to and receives from itself.
    const host = window.parent;

    let disposed = false;
    let debounceTimer: number | null = null;
    // The seq of the most recent host->app load, echoed back so the host can
    // correlate a snapshot with the load that triggered it.
    let lastLoadedSeq = 0;
    let lastPostedContent: string | null = null;

    const buildProject = (): GeoLibreProject => {
      const state = useAppStore.getState();
      return projectFromStore({
        projectName: state.projectName,
        // Mirror the Save/Share path: read the live camera from the controller
        // so pan/zoom round-trips, falling back to the store before the map is
        // ready.
        mapView: mapControllerRef.current?.readView() ?? state.mapView,
        basemapStyleUrl: state.basemapStyleUrl,
        basemapVisible: state.basemapVisible,
        basemapOpacity: state.basemapOpacity,
        layers: state.layers,
        preferences: state.preferences,
        plugins: {
          ...getPluginManager().getProjectState(),
          manifestUrls: state.projectPlugins?.manifestUrls ?? [],
        },
        metadata: state.metadata,
      });
    };

    const postState = () => {
      if (disposed) return;
      const project = buildProject();
      const content = serializeProject(project);
      // Many store writes (selection, hover) do not change the serialized
      // project; skip posting an identical snapshot to keep the host quiet.
      if (content === lastPostedContent) return;
      lastPostedContent = content;
      try {
        // Posted to the parent window object directly. "*" is used as the target
        // origin because the framed app does not know the embedding host's
        // origin; the message still only reaches that one parent window.
        host.postMessage(
          {
            type: "geolibre:state",
            seq: lastLoadedSeq,
            project,
          },
          "*",
        );
      } catch (error) {
        console.error("[GeoLibre] Failed to post embed state", error);
      }
    };

    const scheduleState = () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        postState();
      }, STATE_DEBOUNCE_MS);
    };

    const applyLoad = (message: LoadProjectMessage) => {
      try {
        const project =
          typeof message.project === "string"
            ? parseProject(message.project)
            : parseProject(JSON.stringify(message.project));
        // Reset (not retain) when a load omits seq, so a later snapshot never
        // echoes a stale, unrelated sequence number.
        lastLoadedSeq = typeof message.seq === "number" ? message.seq : 0;
        useAppStore
          .getState()
          .loadProject(project, null, { rememberRecent: false });
        // Suppress the snapshot this load would otherwise echo. loadProject is
        // synchronous, so cache the post-normalisation project (merged styles,
        // computed defaults) rather than the raw input; otherwise the first
        // snapshot would differ from this string and be re-posted to the host.
        lastPostedContent = serializeProject(buildProject());
      } catch (error) {
        host.postMessage(
          {
            type: "geolibre:error",
            message: error instanceof Error ? error.message : String(error),
          },
          "*",
        );
      }
    };

    const handleMessage = (event: MessageEvent) => {
      // Only accept messages from the embedding host (the parent window), so an
      // arbitrary same-page script cannot inject a project. This matters most
      // for the standalone `?embed=1` (`to_html()`) export, where the app may be
      // framed by a third-party page.
      if (event.source !== host) return;
      const data = event.data as Partial<InboundMessage> | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "geolibre:load-project") {
        applyLoad(data as LoadProjectMessage);
      } else if (data.type === "geolibre:request-state") {
        // Force a snapshot regardless of the dedupe cache.
        lastPostedContent = null;
        postState();
      }
    };

    window.addEventListener("message", handleMessage);
    const unsubscribe = useAppStore.subscribe(scheduleState);

    host.postMessage(
      { type: "geolibre:ready", version: __GEOLIBRE_VERSION__ },
      "*",
    );

    return () => {
      disposed = true;
      window.removeEventListener("message", handleMessage);
      unsubscribe();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    };
  }, [mapControllerRef]);
}
