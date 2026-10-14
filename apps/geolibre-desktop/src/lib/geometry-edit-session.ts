import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type * as GeoLibrePlugins from "@geolibre/plugins";
import type { GeoLibreAppAPI, PluginManager } from "@geolibre/plugins";
import { GEO_EDITOR_PLUGIN_ID } from "@geolibre/plugins/plugin-ids";
import type { FeatureCollection } from "geojson";

/** Why a geometry-edit session didn't start, or that it did. */
export type GeometryEditStartResult =
  | "started"
  | "unsupported-renderer"
  | "activation-failed"
  | "start-failed";

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
// against the wrong session.
let pendingStarts: Promise<unknown> = Promise.resolve();

/**
 * Start a GeoEditor session on a layer, as the Layers panel's Edit geometry
 * action does: check the renderer can host the editor, read the layer's
 * features from its MapLibre source if the store has none, activate the
 * GeoEditor plugin if needed, then start the session. Calls are queued, so
 * overlapping starts run one after another.
 *
 * @param layerId - The layer to edit.
 * @param context - The host's app API, plugin manager, map and GeoEditor functions.
 * @returns "started", or why the session could not start.
 */
export function startGeometryEditSession(
  layerId: string,
  context: GeometryEditStartContext,
): Promise<GeometryEditStartResult> {
  const start = pendingStarts.then(() => startWhenIdle(layerId, context));
  pendingStarts = start.catch(() => undefined);
  return start;
}

/**
 * The start itself, run once every earlier start has settled.
 *
 * @param layerId - The layer to edit.
 * @param context - The host's app API, plugin manager, map and GeoEditor functions.
 * @returns "started", or why the session could not start.
 */
async function startWhenIdle(
  layerId: string,
  context: GeometryEditStartContext,
): Promise<GeometryEditStartResult> {
  const { app, manager, geoEditor } = context;
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
    const activated = await manager.activate(GEO_EDITOR_PLUGIN_ID, app);
    if (!activated || !manager.isActive(GEO_EDITOR_PLUGIN_ID)) return "activation-failed";
  }
  return (await geoEditor.startLayerGeometryEdit(app, layerId)) ? "started" : "start-failed";
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
