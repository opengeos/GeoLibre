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
  // An explicit opt-in always activates the bridge — this is how the Jupyter
  // widget and `to_html()` exports run (they load the app with `?embed=1`).
  const embed = new URLSearchParams(window.location.search).get("embed");
  if (embed === "1" || embed === "true") return true;
  try {
    // A same-origin framing host (readable parent) is trusted, so activate.
    return Boolean(window.parent && window.parent !== window);
  } catch {
    // A cross-origin parent throws on access. Without the explicit `?embed=1`
    // opt-in, don't activate the bridge — otherwise any third-party page that
    // iframes a deployed app would start receiving project state.
    return false;
  }
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
 * Trust model: the embedding host is fully trusted and receives the entire
 * project state. Project snapshots are not broadcast until the host sends its
 * first message (which is also when the bridge learns its origin and scopes
 * subsequent posts to it); only the version-only `geolibre:ready` ping precedes
 * the handshake and is the single message sent to `"*"`. Any page that frames
 * the app (not just the Jupyter widget) therefore becomes that trusted host, so
 * `?embed=1` standalone exports should only be served from a trusted context.
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
    // The host's origin, learned from the first message it sends (a lightweight
    // handshake). Outbound project/error messages are scoped to it once known,
    // so a project a third party frames can never receive the data. Until then
    // (only the version-only `ready` ping precedes any inbound message) we fall
    // back to "*".
    let hostOrigin: string | null = null;
    // Whether the host has sent at least one message. Until it has, the bridge
    // must not proactively broadcast project state: a third-party page that
    // frames a `?embed=1` export but never speaks would otherwise receive every
    // snapshot through the "*" fallback below. The version-only `ready` ping is
    // the sole message sent before the handshake completes.
    let hostHandshakeComplete = false;
    const targetOrigin = () => hostOrigin ?? "*";

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
        storymap: state.storymap,
        metadata: state.metadata,
      });
    };

    const postState = () => {
      if (disposed) return;
      // Don't broadcast state before the host has identified itself (see
      // hostHandshakeComplete); otherwise an uncooperative third-party frame
      // that never speaks would keep receiving snapshots via the "*" fallback.
      if (!hostHandshakeComplete) return;
      const content = serializeProject(buildProject());
      // Many store writes (selection, hover) do not change the serialized
      // project; skip posting an identical snapshot to keep the host quiet.
      if (content === lastPostedContent) return;
      lastPostedContent = content;
      try {
        // Post the JSON-parsed snapshot (not the raw store object) so the wire
        // payload exactly matches the serialized `.geolibre.json` form and is
        // guaranteed structured-clone-safe even if a layer's free-form metadata
        // ever holds a non-clone value. Scoped to the host origin once known.
        host.postMessage(
          {
            type: "geolibre:state",
            seq: lastLoadedSeq,
            project: JSON.parse(content) as GeoLibreProject,
          },
          targetOrigin(),
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
      // Advance the seq before parsing so a later snapshot carries the right
      // correlation id even when the load fails. Reset (not retain) when a load
      // omits seq, so a snapshot never echoes a stale, unrelated sequence number.
      lastLoadedSeq = typeof message.seq === "number" ? message.seq : 0;
      try {
        // parseProject takes a JSON string and runs the schema validation and
        // normalisation the app relies on, so an object payload is re-stringified
        // to feed it through the same path.
        const project =
          typeof message.project === "string"
            ? parseProject(message.project)
            : parseProject(JSON.stringify(message.project));
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
          targetOrigin(),
        );
      }
    };

    const handleMessage = (event: MessageEvent) => {
      // Only accept messages from the embedding host (the parent window), so an
      // arbitrary same-page script cannot inject a project. This matters most
      // for the standalone `?embed=1` (`to_html()`) export, where the app may be
      // framed by a third-party page.
      if (event.source !== host) return;
      // The host has spoken: proactive state pushes are safe from here on.
      hostHandshakeComplete = true;
      // Learn the host's origin from its first message and scope outbound
      // messages to it from then on. "null" (opaque/file origins) stays "*".
      if (event.origin && event.origin !== "null") hostOrigin = event.origin;
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
    // Mount-only: mapControllerRef is a stable ref, so the bridge is set up
    // once and reads the live controller through the ref inside buildProject.
  }, []);
}
