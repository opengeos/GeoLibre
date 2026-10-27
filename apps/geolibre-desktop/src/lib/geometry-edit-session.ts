import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type * as GeoLibrePlugins from "@geolibre/plugins";
import type {
  ArcGISCreationTemplateSelection,
  GeoLibreAppAPI,
  PluginManager,
} from "@geolibre/plugins";
import { GEO_EDITOR_PLUGIN_ID } from "@geolibre/plugins/plugin-ids";
import type { FeatureCollection } from "geojson";

/** Why a geometry-edit session didn't start, or that it did. */
export type GeometryEditStartResult =
  | "started"
  | "unsupported-renderer"
  | "activation-failed"
  | "start-failed";

/** Choices made before the session starts. */
export interface GeometryEditStartOptions {
  /** The ArcGIS feature template new features start from (#3179); omit for defaults only. */
  creationTemplate?: ArcGISCreationTemplateSelection;
}

/** What starting a session needs from the host. */
export interface GeometryEditStartContext {
  /** The app API handed to the GeoEditor plugin. */
  app: GeoLibreAppAPI;
  /** Activates the GeoEditor plugin when it is off. */
  manager: Pick<PluginManager, "activate" | "isActive">;
  /** The primary map, to read features from a layer's own MapLibre source. */
  map: MapEngine | null | undefined;
  /**
   * The GeoEditor functions, passed in so callers that keep `@geolibre/plugins`
   * lazily loaded (the plugin app API) don't import it.
   */
  geoEditor: Pick<
    typeof GeoLibrePlugins,
    "isPluginEngineSupported" | "maplibreGeoEditorPlugin" | "startLayerGeometryEdit"
  >;
}

// Starts run one at a time: a second start would end the first session while
// the first is still loading its features, then the first load could finish
// against the wrong session. Settles once every start queued so far has.
let pendingStarts: Promise<void> = Promise.resolve();

/**
 * How long a start waits for the ones queued before it. A start that is
 * already running is never abandoned (that could leave the editor half set
 * up), but one that never finishes must not keep every later start, and the
 * Layers panel's Edit geometry toggle, waiting forever.
 */
export const GEOMETRY_EDIT_QUEUE_WAIT_MS = 60_000;

/**
 * Start a GeoEditor session on a layer, as the Layers panel's Edit geometry
 * action does: check the renderer can host the editor, read the layer's
 * features from its MapLibre source if the store has none, activate the
 * GeoEditor plugin if needed, then start the session. Calls are queued, so
 * overlapping starts run one after another; a start still waiting after
 * {@link GEOMETRY_EDIT_QUEUE_WAIT_MS} gives up with "start-failed".
 *
 * @param layerId - The layer to edit.
 * @param context - The host's app API, plugin manager, map and GeoEditor functions.
 * @param options - Choices made before the session starts.
 * @returns "started", or why the session could not start.
 */
export async function startGeometryEditSession(
  layerId: string,
  context: GeometryEditStartContext,
  options: GeometryEditStartOptions = {},
): Promise<GeometryEditStartResult> {
  const earlierStarts = pendingStarts;
  let finished!: () => void;
  const thisStart = new Promise<void>((resolve) => {
    finished = resolve;
  });
  // The next start waits for this one and, through it, for everything before:
  // even a start that gave up waiting leaves a stuck earlier one in the queue.
  pendingStarts = earlierStarts.then(() => thisStart);
  try {
    if (!(await settlesWithin(earlierStarts, GEOMETRY_EDIT_QUEUE_WAIT_MS))) return "start-failed";
    return await startWhenIdle(layerId, context, options);
  } finally {
    finished();
  }
}

/**
 * Wait for `promise` to settle, for at most `timeoutMs`.
 *
 * @param promise - What to wait for; it never rejects here.
 * @param timeoutMs - The longest wait.
 * @returns True if it settled in time.
 */
function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([promise.then(() => true as const), timedOut]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * The start itself, run once every earlier start has settled.
 *
 * @param layerId - The layer to edit.
 * @param context - The host's app API, plugin manager, map and GeoEditor functions.
 * @param options - Choices made before the session starts.
 * @returns "started", or why the session could not start.
 */
async function startWhenIdle(
  layerId: string,
  context: GeometryEditStartContext,
  options: GeometryEditStartOptions,
): Promise<GeometryEditStartResult> {
  const { app, manager, geoEditor } = context;
  // Don't load and activate the editor for a layer that isn't there.
  if (!useAppStore.getState().layers.some((layer) => layer.id === layerId)) {
    return "start-failed";
  }
  // The editor draws through a MapLibre or Mapbox map; on another renderer it
  // cannot start, and waiting for the map will not help.
  if (
    !geoEditor.isPluginEngineSupported(
      geoEditor.maplibreGeoEditorPlugin,
      useAppStore.getState().primaryRenderer,
    )
  ) {
    return "unsupported-renderer";
  }
  await loadLayerGeojsonFromSource(layerId, context.map);
  if (!manager.isActive(GEO_EDITOR_PLUGIN_ID)) {
    // The editor's packages load on first activation, so the result can be a
    // promise; awaiting a plain boolean is harmless.
    let activated: boolean;
    try {
      activated = await manager.activate(GEO_EDITOR_PLUGIN_ID, app);
    } catch {
      // The plugin manager rethrows an activate() that throws.
      return "activation-failed";
    }
    if (!activated || !manager.isActive(GEO_EDITOR_PLUGIN_ID)) return "activation-failed";
  }
  try {
    return (await geoEditor.startLayerGeometryEdit(app, layerId, options))
      ? "started"
      : "start-failed";
  } catch (error) {
    // Ending the previous session (its write-back or sketches restore) can
    // throw; report a failed start rather than reject.
    console.error("Starting a geometry edit session failed:", error);
    return "start-failed";
  }
}

/**
 * Add Vector Layer (geojson-mode) layers keep their features in a MapLibre
 * source rather than in `layer.geojson`. Read them back once so the editor has
 * features to load. Plain geojson layers already have `geojson`.
 */
async function loadLayerGeojsonFromSource(
  layerId: string,
  map: MapEngine | null | undefined,
): Promise<void> {
  const layer = useAppStore.getState().layers.find((candidate) => candidate.id === layerId);
  if (!layer || layer.geojson) return;
  const sourceIds = layer.metadata.sourceIds;
  const sourceId = Array.isArray(sourceIds) ? sourceIds[0] : undefined;
  if (typeof sourceId !== "string") return;
  const source = map?.getMap()?.getSource(sourceId) as
    | { getData?: () => Promise<unknown> }
    | undefined;
  if (!source || typeof source.getData !== "function") return;
  try {
    const data = await source.getData();
    if (
      data &&
      typeof data === "object" &&
      (data as { type?: string }).type === "FeatureCollection"
    ) {
      useAppStore.getState().updateLayer(layerId, { geojson: data as FeatureCollection });
    }
  } catch {
    // Best effort; startLayerGeometryEdit will fail and surface an error.
  }
}
