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
import { buildTimeFilter, type TimeBinding } from "./time-slider-binding";

/**
 * Marker placed on every GeoLibre store layer that mirrors a time-slider
 * source, used to reconcile and prune the plugin's layers without touching any
 * others (mirrors the Esri Wayback `sourceKind` convention).
 */
const STORE_LAYER_SOURCE_KIND = "time-slider";

/**
 * Default configuration applied on first activation. No data sources are seeded:
 * the dock opens expanded (`collapsed: false`) with an empty timeline so the
 * user can add their own layers via the dock's "Add data" form. Seeding sample
 * sources was removed because the bundled examples cover different periods, so
 * the out-of-range ones flooded the console with 404 tile errors.
 *
 * The starting range matches the dock's default "Add data" example (the Landsat
 * annual COG, 1984-2013 yearly): COG is the form's default type, so its example
 * timeline is only applied when the user actively switches type. Aligning the
 * default here means the prefilled Landsat COG renders across its whole valid
 * range out of the box rather than against an unrelated span (which would
 * request tiles for years the data does not cover).
 */
function buildDefaultOptions(): TimeSliderOptions {
  return {
    startDate: "1984-01-01",
    endDate: "2013-01-01",
    granularity: "year",
    granularities: ["year", "month", "day"],
    speed: 800,
    collapsible: true,
    collapsed: false,
    // Match the in-app light/dark toggle rather than the system
    // `prefers-color-scheme`, which the dock's default `auto` theme follows and
    // which may differ from the in-app theme. startThemeSync keeps it in sync.
    theme: resolveDocumentTheme(),
    sources: [],
  };
}

/**
 * Reads the current GeoLibre theme from the `dark` class that the desktop app
 * toggles on the document element, so the time slider dock is forced to match
 * the in-app theme instead of the system `prefers-color-scheme`.
 *
 * @returns `"dark"` when the app is in dark mode, otherwise `"light"`.
 */
function resolveDocumentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// Observes the document element's `class` so the dock theme tracks the in-app
// light/dark toggle. A single module-level observer suffices: only one control
// is ever active at a time.
let themeObserver: MutationObserver | null = null;

/**
 * Forces the control's theme to the current in-app theme and keeps it in sync
 * with the light/dark toggle by observing the document element's `class`.
 *
 * @param control - The active time-slider control.
 */
function startThemeSync(control: TimeSliderControl): void {
  control.setTheme(resolveDocumentTheme());
  if (
    themeObserver ||
    typeof MutationObserver === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  // The observer fires on any `class` mutation of <html>, so cache the last
  // applied theme and only call setTheme when the dark/light value flips. It
  // targets the module-level `timeSliderControl` (late-bound, like PrintControl)
  // so a rebuilt control still receives theme updates.
  let lastTheme = resolveDocumentTheme();
  themeObserver = new MutationObserver(() => {
    const next = resolveDocumentTheme();
    if (next === lastTheme) return;
    lastTheme = next;
    timeSliderControl?.setTheme(next);
  });
  themeObserver.observe(document.documentElement, {
    attributeFilter: ["class"],
  });
}

/**
 * Stops the document-theme observer started by {@link startThemeSync}.
 */
function stopThemeSync(): void {
  themeObserver?.disconnect();
  themeObserver = null;
}

let timeSliderPosition: GeoLibreMapControlPosition = "bottom-left";
let timeSliderControl: TimeSliderControl | null = null;
// Last known config, kept so deactivating/reactivating (or restoring a saved
// project) rebuilds the timeline and its layers exactly.
let savedConfig: TimeSliderConfig | null = null;
// Detaches the active control's store-sync listeners; set by attachStoreSync,
// cleared when invoked. Bound to a specific control so handlers cannot leak.
let detachStoreSync: (() => void) | null = null;

/** Stable id of this plugin, exported so the UI can activate/query it. */
export const TIME_SLIDER_PLUGIN_ID = "maplibre-gl-time-slider";

export const maplibreTimeSliderPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-time-slider",
  name: "Time Slider",
  version: "1.0.3",
  activate: (app: GeoLibreAppAPI) => {
    if (timeSliderControl) return;
    const control = new TimeSliderControl(
      savedConfig ? configToOptions(savedConfig) : buildDefaultOptions(),
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
      // the next activation rebuilds the default empty timeline. If a control is
      // still live (e.g. an invalid settings entry arrives while the plugin
      // stays active across a project switch), tear it down and rebuild so the
      // previous project's timeline cannot linger on screen.
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
  // Force the dock theme to follow the in-app light/dark toggle for as long as
  // this control is attached.
  startThemeSync(control);
  const detachBindingSync = attachBindingSync(control);
  // Bind the detacher to this specific control and its own handler closures so
  // a second attach can never orphan the previous control's listeners.
  detachStoreSync = () => {
    control.off("sourceadd", onSourceAdd);
    control.off("sourceremove", onSourceRemove);
    detachBindingSync();
    stopThemeSync();
    detachStoreSync = null;
  };
}

// ----- Bound GeoLibre layers ------------------------------------------------
// The Time Slider can drive vector layers added through GeoLibre's own Add Data
// menu: a "Bind to Time Slider" action stores a `timeBinding` on the layer's
// metadata, and while the dock is active the timeline's current date is turned
// into a MapLibre filter written to the layer's transient `timeFilter`. The
// layer's styling and opacity stay under the Layers panel's control; only the
// visible feature set narrows. See `time-slider-binding.ts`.

// Last range pushed to the control, so an unrelated store change does not
// re-snap the marker by calling setRange again with identical bounds.
let lastBoundRangeKey: string | null = null;
// The control's range from just before the first binding overrode it, restored
// when the last binding is removed so any pre-existing temporal sources keep
// their own range across a bind/unbind cycle.
let preBindingRange: {
  start: string;
  end: string;
  granularity: TimeBinding["granularity"];
} | null = null;
// Guards our own timeFilter writes from re-entering the store subscription.
let applyingBoundFilters = false;
// JSON of the last time filter pushed to each bound layer, so a playback tick
// that lands in the same window does not re-serialize the stored filter and
// re-write the store. Cleared when a layer is unbound or the dock detaches.
const appliedFilterKeys = new Map<string, string>();

interface BoundLayer {
  id: string;
  binding: TimeBinding;
}

/**
 * Collect the store layers that carry a {@link TimeBinding} on their metadata.
 */
function getBoundLayers(): BoundLayer[] {
  const bound: BoundLayer[] = [];
  for (const layer of useAppStore.getState().layers) {
    const binding = layer.metadata?.timeBinding as TimeBinding | undefined;
    if (binding && typeof binding.property === "string") {
      bound.push({ id: layer.id, binding });
    }
  }
  return bound;
}

/**
 * Recompute and write each bound layer's time filter for the control's current
 * date. Writes are diffed so a no-op date tick does not churn the store, and a
 * re-entrancy guard keeps these writes from retriggering the store sync.
 */
function applyBoundFilters(
  control: TimeSliderControl,
  bound: BoundLayer[],
): void {
  if (bound.length === 0) return;
  const date = new Date(control.getConfig().currentDate);
  const store = useAppStore.getState();
  applyingBoundFilters = true;
  try {
    for (const { id, binding } of bound) {
      const layer = store.layers.find((item) => item.id === id);
      if (!layer) continue;
      const filter = buildTimeFilter(binding, date);
      const key = JSON.stringify(filter);
      // Compare against the last filter we applied (one serialization) rather
      // than re-serializing the stored filter on every tick.
      if (appliedFilterKeys.get(id) !== key) {
        store.updateLayer(id, { timeFilter: filter });
        appliedFilterKeys.set(id, key);
      }
    }
  } finally {
    applyingBoundFilters = false;
  }
}

/**
 * Drop the transient time filter from layers that are no longer bound (or from
 * every layer, when the dock is torn down) so they show their full feature set
 * again.
 */
function clearBoundFilters(ids: string[]): void {
  if (ids.length === 0) return;
  const store = useAppStore.getState();
  applyingBoundFilters = true;
  try {
    for (const id of ids) {
      appliedFilterKeys.delete(id);
      const layer = store.layers.find((item) => item.id === id);
      if (layer && layer.timeFilter !== undefined) {
        store.updateLayer(id, { timeFilter: undefined });
      }
    }
  } finally {
    applyingBoundFilters = false;
  }
}

/**
 * Reconcile the timeline range with the union of every bound layer's extent and
 * refresh their filters. Called on activation and whenever the set of bound
 * layers (or their bindings) changes.
 */
function reconcileBoundLayers(control: TimeSliderControl): void {
  const bound = getBoundLayers();
  if (bound.length > 0) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let granularity = bound[0].binding.granularity;
    let widestSpan = -1;
    for (const { binding } of bound) {
      if (binding.min < min) min = binding.min;
      if (binding.max > max) max = binding.max;
      const span = binding.max - binding.min;
      // The widest dataset sets the stepping granularity for the shared track.
      if (span > widestSpan) {
        widestSpan = span;
        granularity = binding.granularity;
      }
    }
    const rangeKey = `${min}|${max}|${granularity}`;
    if (rangeKey !== lastBoundRangeKey) {
      // Capture the range the control had before any binding overrode it, so it
      // can be restored when every binding is later removed.
      if (lastBoundRangeKey === null) {
        const config = control.getConfig();
        preBindingRange = {
          start: config.startDate,
          end: config.endDate,
          granularity: config.granularity,
        };
      }
      lastBoundRangeKey = rangeKey;
      control.setRange(new Date(min), new Date(max), undefined, granularity);
    }
  } else {
    // The last binding was removed: restore the pre-binding range so any other
    // temporal sources are not stranded at the bound layer's range.
    if (lastBoundRangeKey !== null && preBindingRange) {
      control.setRange(
        preBindingRange.start,
        preBindingRange.end,
        undefined,
        preBindingRange.granularity,
      );
    }
    preBindingRange = null;
    lastBoundRangeKey = null;
  }
  applyBoundFilters(control, bound);
}

/**
 * Wire the control's date changes and the GeoLibre store together so bound
 * layers track the timeline. Returns a detacher that also clears every applied
 * time filter, so deactivating the dock restores full feature visibility.
 *
 * @param control - The active time-slider control.
 * @returns A teardown function.
 */
function attachBindingSync(control: TimeSliderControl): () => void {
  lastBoundRangeKey = null;
  preBindingRange = null;
  appliedFilterKeys.clear();
  // `statechange` fires on every date change (scrub and each playback tick) plus
  // range/granularity changes, which is exactly when bound filters must update.
  const onStateChange = () => applyBoundFilters(control, getBoundLayers());
  control.on("statechange", onStateChange);

  // Track the set of bound layers so a store change only re-snaps the range when
  // a binding was actually added, removed, or edited (not on every opacity drag).
  let boundSignature = bindingSignature();
  let boundIds = getBoundLayers().map((entry) => entry.id);
  const unsubscribe = useAppStore.subscribe(() => {
    if (applyingBoundFilters) return;
    const nextSignature = bindingSignature();
    if (nextSignature === boundSignature) return;
    const nextIds = getBoundLayers().map((entry) => entry.id);
    const removed = boundIds.filter((id) => !nextIds.includes(id));
    boundSignature = nextSignature;
    boundIds = nextIds;
    if (removed.length > 0) clearBoundFilters(removed);
    reconcileBoundLayers(control);
  });

  // Apply once now so a binding made before activation takes effect immediately.
  reconcileBoundLayers(control);

  return () => {
    control.off("statechange", onStateChange);
    unsubscribe();
    clearBoundFilters(getBoundLayers().map((entry) => entry.id));
    appliedFilterKeys.clear();
    lastBoundRangeKey = null;
    preBindingRange = null;
  };
}

/**
 * A compact signature of the current bindings (ids + configs) used to detect
 * binding changes without reacting to unrelated store updates.
 */
function bindingSignature(): string {
  return JSON.stringify(
    getBoundLayers().map(({ id, binding }) => [id, binding]),
  );
}

/**
 * Read the {@link TimeBinding} stored on a layer's metadata, if any. Used by the
 * Layers panel to decide between the Bind and Unbind actions.
 *
 * @param layer - A store layer.
 * @returns The binding, or `undefined` when the layer is not time-bound.
 */
export function getLayerTimeBinding(layer: {
  metadata?: Record<string, unknown>;
}): TimeBinding | undefined {
  const binding = layer.metadata?.timeBinding as TimeBinding | undefined;
  return binding && typeof binding.property === "string" ? binding : undefined;
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
