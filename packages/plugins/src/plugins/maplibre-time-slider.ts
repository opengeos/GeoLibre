import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  TimeSliderControl,
  type SourceSpec,
  type TimeSliderConfig,
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
 * Seed configuration applied on first activation. It mirrors the four bundled
 * "Add data" examples from maplibre-gl-time-slider, one per source type (COG,
 * XYZ, GeoJSON, WMS), so every supported type is demonstrated out of the box.
 *
 * The examples cover different periods, so a single timeline cannot show all of
 * them at once: the active timeline defaults to the Landsat COG (yearly,
 * 1984-2013), which renders immediately. The other sources appear in the Layers
 * panel and render once the user moves the timeline into their range via the
 * dock (year/month/day granularity pills are all offered). Each source has a
 * stable explicit `id` so its maplibre layer id and GeoLibre store-layer id
 * stay constant across save/load.
 */
const SEED_OPTIONS: TimeSliderOptions = {
  startDate: "1984-01-01",
  endDate: "2013-01-01",
  granularity: "year",
  granularities: ["year", "month", "day"],
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
      // Footprint of the COG so MapLibre only requests in-bounds tiles
      // (out-of-bounds tiles 404 at TiTiler and would flood the console).
      bounds: [
        -74.72222465917544, -8.586918476798596, -74.15951996520296,
        -8.282218213133522,
      ],
    },
    // The remaining examples cover other periods, so they are seeded hidden to
    // avoid requesting out-of-range tiles under the default Landsat timeline.
    // They appear in the Layers panel; toggle them on after moving the timeline
    // into their range (MODIS: Aug 2023 daily; earthquakes: 2015 monthly).
    {
      type: "xyz",
      id: "time-slider-modis-truecolor",
      name: "MODIS Terra True Color (XYZ)",
      visible: false,
      tiles:
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor" +
        "/default/{date:YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg",
    },
    {
      type: "geojson",
      id: "time-slider-earthquakes",
      name: "Significant Earthquakes 2015",
      visible: false,
      data: "https://maplibre.org/maplibre-gl-js/docs/assets/significant-earthquakes-2015.geojson",
      timeProperty: "time",
      window: { unit: "month", before: 0, after: 1 },
    },
    {
      type: "wms",
      id: "time-slider-modis-wms",
      name: "MODIS Terra True Color (WMS)",
      visible: false,
      baseUrl:
        "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?version=1.3.0&service=WMS" +
        "&request=GetMap&format=image/png&transparent=true&CRS=EPSG:3857" +
        "&width=256&height=256&bbox={bbox-epsg-3857}",
      layers: "MODIS_Terra_CorrectedReflectance_TrueColor",
    },
  ],
};

let timeSliderPosition: GeoLibreMapControlPosition = "bottom-left";
let timeSliderControl: TimeSliderControl | null = null;
// Last known config, kept so deactivating/reactivating (or restoring a saved
// project) rebuilds the timeline and its layers exactly.
let savedConfig: TimeSliderConfig | null = null;
// Detaches the active control's store-sync listeners; set by attachStoreSync,
// cleared when invoked. Bound to a specific control so handlers cannot leak.
let detachStoreSync: (() => void) | null = null;

export const maplibreTimeSliderPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-time-slider",
  name: "Time Slider",
  version: "1.0.2",
  activate: (app: GeoLibreAppAPI) => {
    if (timeSliderControl) return;
    const control = new TimeSliderControl(
      savedConfig ? configToOptions(savedConfig) : SEED_OPTIONS,
    );
    timeSliderControl = control;
    attachStoreSync(control);

    const added = app.addMapControl(control, timeSliderPosition);
    if (!added) {
      detachStoreSync?.();
      timeSliderControl = null;
      return false;
    }
    // Layers (especially the async COG) only exist a tick after the control is
    // added, so reconcile the store once they have been created. Capture the
    // control locally so a later reassignment cannot redirect this callback.
    setTimeout(() => syncStoreLayers(control), 0);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    if (!timeSliderControl) return;
    savedConfig = timeSliderControl.getConfig();
    detachStoreSync?.();
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
    detachStoreSync?.();
    app.removeMapControl(timeSliderControl);
    const control = new TimeSliderControl(configToOptions(config));
    timeSliderControl = control;
    attachStoreSync(control);
    const added = app.addMapControl(control, timeSliderPosition);
    if (!added) {
      detachStoreSync?.();
      timeSliderControl = null;
      // Preserve the captured config so a later activate() restores the user's
      // layers, and drop the now-orphaned store layers (the previous control's
      // map layers were already removed above).
      savedConfig = config;
      removeAllTimeSliderStoreLayers();
      return false;
    }
    setTimeout(() => syncStoreLayers(control), 0);
  },
  getProjectState: () => {
    const config = timeSliderControl?.getConfig() ?? savedConfig;
    // getConfig() includes optional keys (e.g. dateFormat/beforeId) with
    // `undefined` values. The host drops plugin settings that are not strictly
    // JSON-compatible, and `undefined` fails that check, so round-trip through
    // JSON to strip those keys before persisting.
    return config
      ? (JSON.parse(JSON.stringify(config)) as TimeSliderConfig)
      : undefined;
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => {
    const nextConfig = normalizeConfig(state);
    if (!nextConfig) {
      // A reset/new project (or an invalid value) clears the cached config so
      // the next activation seeds fresh. If a control is still live (e.g. an
      // invalid settings entry arrives while the plugin stays active across a
      // project switch), tear it down and re-seed so the previous project's
      // timeline cannot linger on screen.
      savedConfig = null;
      if (timeSliderControl) {
        detachStoreSync?.();
        app.removeMapControl(timeSliderControl);
        timeSliderControl = null;
        removeAllTimeSliderStoreLayers();
        return maplibreTimeSliderPlugin.activate(app) !== false;
      }
      return false;
    }

    savedConfig = nextConfig;
    if (!timeSliderControl) return true;

    // setConfig replaces the sources in place without firing
    // sourceadd/sourceremove, so reconcile the store via the setTimeout below
    // once the new layers exist. Capture the control so a later reassignment
    // cannot redirect this callback.
    const control = timeSliderControl;
    control.setConfig(nextConfig);
    setTimeout(() => syncStoreLayers(control), 0);
    return true;
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
    // Copy each source so the rebuilt control cannot mutate the cached config.
    sources: config.sources.map((source) => ({ ...source })),
    collapsible: true,
  };
}

/**
 * Returns true when a source URL-bearing field is safe to hand to the library:
 * absent/empty, a non-string (e.g. inline GeoJSON data objects), or a plain
 * http(s) URL. Other schemes (javascript:/data:/file:) are rejected.
 *
 * @param value - A candidate `url`/`tiles`/`data`/`baseUrl` value.
 * @returns Whether the value is safe.
 */
function isSafeSourceUrl(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return true;
  return /^https?:\/\//i.test(value);
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
    typeof candidate.granularity !== "string" ||
    (candidate.currentDate !== undefined &&
      typeof candidate.currentDate !== "string") ||
    !Array.isArray(candidate.sources) ||
    (candidate.sources as unknown[]).some((source) => {
      if (!source || typeof source !== "object") return true;
      const spec = source as {
        id?: unknown;
        url?: unknown;
        tiles?: unknown;
        data?: unknown;
        baseUrl?: unknown;
      };
      // Reject malformed ids and any URL-bearing field that is not a plain
      // http(s) URL. A crafted project file could otherwise smuggle a
      // javascript:/data:/file: URI that MapLibre would fetch, which matters
      // under the Tauri desktop target.
      return (
        typeof spec.id !== "string" ||
        !isSafeSourceUrl(spec.url) ||
        !isSafeSourceUrl(spec.tiles) ||
        !isSafeSourceUrl(spec.data) ||
        !isSafeSourceUrl(spec.baseUrl)
      );
    })
  ) {
    return null;
  }
  return candidate as TimeSliderConfig;
}

// Only sourceadd/sourceremove change the store's layer set. statechange also
// fires on every playback tick (goTo emits it), so subscribing it to a store
// reconcile would run at animation speed for no benefit; opacity and
// visibility are intentionally left to the Layers panel.
function attachStoreSync(control: TimeSliderControl): void {
  const onSourceAdd = () => syncStoreLayers(control);
  const onSourceRemove = () => syncStoreLayers(control);
  control.on("sourceadd", onSourceAdd);
  control.on("sourceremove", onSourceRemove);
  // Bind the detacher to this specific control and its own handler closures so
  // a second attach can never orphan the previous control's listeners.
  detachStoreSync = () => {
    control.off("sourceadd", onSourceAdd);
    control.off("sourceremove", onSourceRemove);
    detachStoreSync = null;
  };
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
