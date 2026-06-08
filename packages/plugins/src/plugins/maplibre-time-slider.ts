import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  TimeSliderControl,
  type SourceSpec,
  type TimeSliderConfig,
  type TimeSliderEventHandler,
  type TimeSliderOptions,
} from "maplibre-gl-time-slider";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

/**
 * Marker placed on every GeoLibre store layer that mirrors a time-slider
 * source, used to reconcile and prune the plugin's layers without touching any
 * others (mirrors the Esri Wayback `sourceKind` convention).
 */
const STORE_LAYER_SOURCE_KIND = "time-slider";

/**
 * Seed configuration applied on first activation: the opengeos Landsat annual
 * composite COG (1984-2013) served via TiTiler, so a layer appears immediately.
 * The source has a stable explicit `id` so the maplibre layer id and the
 * GeoLibre store-layer id stay constant across save/load.
 */
const SEED_OPTIONS: TimeSliderOptions = {
  startDate: "1984-01-01",
  endDate: "2013-01-01",
  granularity: "year",
  granularities: ["year"],
  speed: 800,
  collapsible: true,
  collapsed: false,
  sources: [
    {
      type: "cog",
      id: "time-slider-landsat",
      name: "Landsat Annual Composite",
      url: "https://data.source.coop/giswqs/opengeos/landsat_ts/{date:YYYY}.tif",
      rescale: [0, 110],
      nodata: 0,
      bidx: [1, 2, 3],
    },
  ],
};

let timeSliderPosition: GeoLibreMapControlPosition = "bottom-left";
let timeSliderControl: TimeSliderControl | null = null;
// Last known config, kept so deactivating/reactivating (or restoring a saved
// project) rebuilds the timeline and its layers exactly.
let savedConfig: TimeSliderConfig | null = null;
let sourceAddHandler: TimeSliderEventHandler | null = null;
let sourceRemoveHandler: TimeSliderEventHandler | null = null;
let stateChangeHandler: TimeSliderEventHandler | null = null;

export const maplibreTimeSliderPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-time-slider",
  name: "Time Slider",
  version: "1.0.1",
  activate: (app: GeoLibreAppAPI) => {
    timeSliderControl = new TimeSliderControl(
      savedConfig ? configToOptions(savedConfig) : SEED_OPTIONS,
    );
    attachStoreSync(timeSliderControl);

    const added = app.addMapControl(timeSliderControl, timeSliderPosition);
    if (!added) {
      detachStoreSync(timeSliderControl);
      timeSliderControl = null;
      return false;
    }
    // Layers (especially the async COG) only exist a tick after the control is
    // added, so reconcile the store once they have been created.
    setTimeout(() => syncStoreLayers(timeSliderControl), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!timeSliderControl) return;
    savedConfig = timeSliderControl.getConfig();
    detachStoreSync(timeSliderControl);
    app.removeMapControl(timeSliderControl);
    timeSliderControl = null;
    removeAllTimeSliderStoreLayers();
  },
  getMapControlPosition: () => timeSliderPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    timeSliderPosition = position;
    if (!timeSliderControl) return;
    // The library's onRemove destroys all adapters/layers and clears event
    // handlers, so capture the full config first and rebuild a fresh control
    // at the new position to preserve user-added layers.
    const config = timeSliderControl.getConfig();
    detachStoreSync(timeSliderControl);
    app.removeMapControl(timeSliderControl);
    timeSliderControl = new TimeSliderControl(configToOptions(config));
    attachStoreSync(timeSliderControl);
    const added = app.addMapControl(timeSliderControl, timeSliderPosition);
    if (!added) {
      detachStoreSync(timeSliderControl);
      timeSliderControl = null;
      return false;
    }
    setTimeout(() => syncStoreLayers(timeSliderControl), 0);
  },
  getProjectState: () =>
    timeSliderControl?.getConfig() ?? savedConfig ?? undefined,
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => {
    const nextConfig = normalizeConfig(state);
    if (!nextConfig) return false;

    savedConfig = nextConfig;
    if (!timeSliderControl) return true;

    // setConfig replaces every layer with those in the saved config; the
    // resulting `change`/`statechange` events drive the store reconcile.
    timeSliderControl.setConfig(nextConfig);
    setTimeout(() => syncStoreLayers(timeSliderControl), 0);
  },
};

/**
 * Builds constructor options from a serialized config so a fresh control
 * restores the full timeline state and all of its sources.
 *
 * @param config - A config produced by `TimeSliderControl.getConfig()`.
 * @returns Options for a new `TimeSliderControl`.
 */
function configToOptions(config: TimeSliderConfig): TimeSliderOptions {
  return {
    startDate: config.startDate,
    endDate: config.endDate,
    interval: config.interval,
    granularity: config.granularity,
    granularities: config.granularities,
    initialDate: config.currentDate,
    speed: config.speed,
    loop: config.loop,
    autoPlay: config.autoPlay,
    theme: config.theme,
    dateFormat: config.dateFormat,
    collapsed: config.collapsed,
    beforeId: config.beforeId,
    sources: config.sources,
    collapsible: true,
  };
}

/**
 * Minimal validation of a restored project value before treating it as a
 * `TimeSliderConfig` (it arrives untyped from the saved project file).
 *
 * @param state - The raw value from the saved project.
 * @returns The config when it looks valid, otherwise null.
 */
function normalizeConfig(state: unknown): TimeSliderConfig | null {
  if (!state || typeof state !== "object") return null;
  const candidate = state as Partial<TimeSliderConfig>;
  if (
    typeof candidate.startDate !== "string" ||
    typeof candidate.endDate !== "string" ||
    !Array.isArray(candidate.sources)
  ) {
    return null;
  }
  return candidate as TimeSliderConfig;
}

function attachStoreSync(control: TimeSliderControl): void {
  sourceAddHandler = () => syncStoreLayers(control);
  sourceRemoveHandler = () => syncStoreLayers(control);
  stateChangeHandler = () => syncStoreLayers(control);
  control.on("sourceadd", sourceAddHandler);
  control.on("sourceremove", sourceRemoveHandler);
  control.on("statechange", stateChangeHandler);
}

function detachStoreSync(control: TimeSliderControl): void {
  if (sourceAddHandler) {
    control.off("sourceadd", sourceAddHandler);
    sourceAddHandler = null;
  }
  if (sourceRemoveHandler) {
    control.off("sourceremove", sourceRemoveHandler);
    sourceRemoveHandler = null;
  }
  if (stateChangeHandler) {
    control.off("statechange", stateChangeHandler);
    stateChangeHandler = null;
  }
}

/**
 * Reconciles the GeoLibre layer store with the control's current sources: each
 * source becomes (or updates) an external-native store layer, and store layers
 * whose source no longer exists are pruned. The maplibre layer id equals the
 * source id for every adapter type, so `nativeLayerIds` lets the Layers panel
 * and the on-map layer control drive the underlying layer.
 */
function syncStoreLayers(control: TimeSliderControl | null): void {
  if (!control) return;
  const activeIds = new Set<string>();
  for (const spec of control.getSources()) {
    if (!spec.id) continue;
    activeIds.add(spec.id);
    addOrUpdateStoreLayer(createStoreLayer(spec));
  }

  const store = useAppStore.getState();
  const staleIds = store.layers
    .filter(
      (layer) =>
        layer.metadata.sourceKind === STORE_LAYER_SOURCE_KIND &&
        !activeIds.has(layer.id),
    )
    .map((layer) => layer.id);
  for (const id of staleIds) {
    store.removeLayer(id);
  }
}

function addOrUpdateStoreLayer(layer: GeoLibreLayer): void {
  const store = useAppStore.getState();
  const existingLayer = store.layers.find((item) => item.id === layer.id);
  if (!existingLayer) {
    store.addLayer(layer);
    return;
  }

  if (!shouldUpdateStoreLayer(existingLayer, layer)) return;

  // Only sync identity/source/metadata; visibility and opacity are left to the
  // user via the Layers panel so a dock-side state change cannot clobber them.
  store.updateLayer(layer.id, {
    metadata: layer.metadata,
    name: layer.name,
    source: layer.source,
  });
}

function shouldUpdateStoreLayer(
  existingLayer: GeoLibreLayer,
  nextLayer: GeoLibreLayer,
): boolean {
  return (
    existingLayer.name !== nextLayer.name ||
    JSON.stringify(existingLayer.metadata) !==
      JSON.stringify(nextLayer.metadata) ||
    JSON.stringify(existingLayer.source) !== JSON.stringify(nextLayer.source)
  );
}

function createStoreLayer(spec: SourceSpec): GeoLibreLayer {
  const sourceId = spec.id as string;
  const layerType = spec.type === "geojson" ? "geojson" : "raster";
  return {
    id: sourceId,
    name: spec.name ?? sourceId,
    type: layerType,
    source: { type: layerType, sourceId },
    visible: spec.visible !== false,
    opacity: spec.opacity ?? 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [sourceId],
      sourceId,
      sourceIds: [sourceId],
      sourceKind: STORE_LAYER_SOURCE_KIND,
    },
  };
}

function removeAllTimeSliderStoreLayers(): void {
  const store = useAppStore.getState();
  const ids = store.layers
    .filter((layer) => layer.metadata.sourceKind === STORE_LAYER_SOURCE_KIND)
    .map((layer) => layer.id);
  for (const id of ids) {
    store.removeLayer(id);
  }
}
