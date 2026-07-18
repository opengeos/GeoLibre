import { parseProject, serializeProject, useAppStore, type GeoLibreProject } from "@geolibre/core";
import { type RefObject, useEffect } from "react";
import type { MapController } from "@geolibre/map";
import { buildProjectSnapshot } from "../lib/build-project-snapshot";
import { getEmbedHost, isEmbedded } from "./embedHost";

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
export function useEmbedBridge(mapControllerRef: RefObject<MapController | null>): void {
  useEffect(() => {
    if (!isEmbedded()) return;
    // The host is the embedding parent (the Jupyter/embed widget). The shared
    // channel tracks the host's origin and handshake state (see embedHost.ts).
    const hostChannel = getEmbedHost();
    const host = hostChannel.window;
    const targetOrigin = () => hostChannel.targetOrigin();

    let disposed = false;
    let debounceTimer: number | null = null;
    // The seq of the most recent host->app load, echoed back so the host can
    // correlate a snapshot with the load that triggered it.
    let lastLoadedSeq = 0;
    let lastPostedContent: string | null = null;

    const buildProject = (): GeoLibreProject => buildProjectSnapshot(mapControllerRef);

    const postState = () => {
      if (disposed) return;
      // Don't broadcast state before the host has identified itself (see
      // hostChannel.handshakeComplete); otherwise an uncooperative third-party
      // frame that never speaks would keep receiving snapshots via "*".
      if (!hostChannel.handshakeComplete) return;
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
        useAppStore.getState().loadProject(project, null, { rememberRecent: false });
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
      // framed by a third-party page. note() also marks the handshake complete
      // and learns the host's origin for scoping outbound messages.
      if (!hostChannel.note(event)) return;
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

    host.postMessage({ type: "geolibre:ready", version: __GEOLIBRE_VERSION__ }, "*");

    return () => {
      disposed = true;
      window.removeEventListener("message", handleMessage);
      unsubscribe();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    };
    // Mount-only: mapControllerRef is a stable ref, so the bridge is set up
    // once and reads the live controller through the ref inside buildProject.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
