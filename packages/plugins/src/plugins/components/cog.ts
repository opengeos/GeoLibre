// The COG raster control (CogLayerControl) and its Layer Swipe integration.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type * as maplibregl from "maplibre-gl";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type {
  CogLayerControl,
  CogLayerControlOptions,
  CogLayerEventHandler,
  CogLayerInfo,
} from "maplibre-gl-components";
import type { GeoLibreAppAPI } from "../../types";
import { ensureMercatorProjection } from "../map-projection-utils";
import { savedRasterState } from "../raster-layer-sync";
import type { SwipeRasterSnapshot } from "../swipe-raster-mirror";
import { type CogLayerControlConstructor, getComponentsConstructors } from "./constructors";
import { addGeoTiffRasterLayer, shouldUseGenericGeoTiffRenderer } from "./geotiff";
import {
  cogRasterControlPosition,
  type CogRasterLayerOptions,
  isRemoteHttpUrl,
  layerNameFromUrl,
} from "./shared";

const COG_RASTER_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-cog-raster-control",
  collapsed: true,
  defaultBands: "1",
  defaultColormap: "none",
  defaultOpacity: 1,
  defaultPickable: false,
  defaultRescaleMax: 255,
  defaultRescaleMin: 0,
  fontColor: "hsl(var(--popover-foreground))",
  visible: false,
} satisfies CogLayerControlOptions;

let cogRasterControl: CogLayerControl | null = null;
let cogRasterControlMounted = false;
let cogRasterStoreUnsubscribe: (() => void) | null = null;

type MutableCogLayerControl = {
  _options?: CogLayerControlOptions;
  _render?: () => void;
  _state?: {
    bands: string;
    colormap: CogLayerControlOptions["defaultColormap"];
    layerName: string;
    layerOpacity: number;
    nodata: number | undefined;
    pickable: boolean;
    rescaleMax: number;
    rescaleMin: number;
    url: string;
  };
};

const pendingCogRasterLayerOptions: CogRasterLayerOptions[] = [];
const ignoredCogRasterLayerUrls = new Set<string>();

export async function addCogRasterLayer(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
): Promise<string> {
  if (options.data || shouldUseGenericGeoTiffRenderer(options.url)) {
    return addGeoTiffRasterLayer(app, options);
  }

  // The Components plugin itself is MapLibre-only (no `engines`); this read is
  // reached from the STAC plugin's audit closure. The COG control is
  // maplibre-gl-raster, whose tile protocol only registers with MapLibre, and
  // on Mapbox the STAC plugin draws COGs through the engine instead.
  // engine-audit-allow: getMap-mapbox
  ensureMercatorProjection(app.getMap?.());
  const control = await ensureCogRasterControl(app);
  if (!control) {
    throw new Error("The COG raster layer control could not be added to the map.");
  }

  try {
    return await addLayerWithCogRasterControl(control, options);
  } catch (error) {
    if (isRemoteHttpUrl(options.url)) throw error;
    return addGeoTiffRasterLayer(app, options, error);
  }
}

async function ensureCogRasterControl(app: GeoLibreAppAPI): Promise<CogLayerControl | null> {
  const { CogLayerControl: CogLayerControlClass } = await getComponentsConstructors();

  cogRasterControl ??= createCogRasterControl(CogLayerControlClass);

  if (!cogRasterControlMounted) {
    const added = app.addMapControl(cogRasterControl, cogRasterControlPosition);
    if (!added) {
      cogRasterControl = null;
      return null;
    }
    cogRasterControlMounted = true;
  }

  setTimeout(() => {
    cogRasterControl?.hide();
    cogRasterControl?.collapse();
  }, 0);
  return cogRasterControl;
}

function createCogRasterControl(CogLayerControlClass: CogLayerControlConstructor): CogLayerControl {
  const control = new CogLayerControlClass(COG_RASTER_OPTIONS);
  control.on("layeradd", createCogRasterLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isCogRasterControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  cogRasterStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isCogRasterControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        cogRasterControl?.removeLayer(layer.id);
        continue;
      }

      if (!isCogRasterControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        cogRasterControl?.setLayerVisibility(
          currentLayer.id,
          currentLayer.visible,
          currentLayer.opacity,
        );
      }

      if (currentLayer.opacity !== layer.opacity) {
        if (currentLayer.visible) {
          cogRasterControl?.setLayerOpacity(currentLayer.id, currentLayer.opacity);
        } else {
          cogRasterControl?.setLayerVisibility(currentLayer.id, false, currentLayer.opacity);
        }
      }
    }
  });
  return control;
}

// --- Layer Swipe COG integration -------------------------------------------
// GeoLibre renders COG rasters (Vantor Open Data, STAC "Visualize", etc.)
// through the CogLayerControl deck.gl overlay, so they are MapLibre custom
// layers that Layer Swipe cannot see through getStyle(). These helpers let the
// swipe plugin's layerProvider list them and render each per its side
// assignment: mirror right/both onto the swipe comparison map, hide right-only
// on the main map. See #1240 and swipe-cog-mirror.ts.

/**
 * A COG raster snapshot for the Layer Swipe provider, read from the app store
 * (the user's intent) rather than the live control, so swipe's transient
 * main-map visibility toggles do not perturb its decisions.
 */
export interface SwipeCogRasterSnapshot {
  /** The CogLayerControl layer id (also the store layer id). */
  id: string;
  /** Display name. */
  name: string;
  /** COG URL. */
  url: string;
  /** User-facing visibility from the store (not swipe's transient state). */
  visible: boolean;
  /** Layer opacity. */
  opacity: number;
  /** Band selection string (e.g. "1" or "1,2,3"). */
  bands?: string;
  /** Colormap name. */
  colormap?: CogLayerControlOptions["defaultColormap"];
  /** Rescale minimum. */
  rescaleMin?: number;
  /** Rescale maximum. */
  rescaleMax?: number;
  /** Nodata value. */
  nodata?: number;
}

// The snapshot getSwipeMaplibreRasters produces is exactly what SwipeRasterMirror
// consumes, so the mirror owns the shape and this is an alias rather than a
// second copy to keep in sync by hand.
export type SwipeMaplibreRasterSnapshot = SwipeRasterSnapshot;

// Notified when the set/state of CogLayerControl rasters changes, so the swipe
// provider can refresh its list and re-mirror. Backed by a single store
// subscription while at least one listener is registered.
const swipeCogChangeListeners = new Set<() => void>();
let swipeCogStoreUnsubscribe: (() => void) | null = null;

function notifySwipeCogChange(): void {
  for (const listener of swipeCogChangeListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[GeoLibre] swipe COG change listener", error);
    }
  }
}

/**
 * A lightweight fingerprint of the store's COG rasters (id/name/visibility/
 * opacity/visualization), so the swipe subscription can skip notifying when an
 * unrelated layer changed. Cheaper than the refreshLayers()/reconcile pass it
 * guards.
 */
function swipeCogFingerprint(layers: GeoLibreLayer[]): string {
  const parts: unknown[][] = [];
  for (const layer of layers) {
    if (!isCogRasterControlLayer(layer) && !isMaplibreRasterControlLayer(layer)) continue;
    const source = layer.source as {
      url?: unknown;
      bands?: unknown;
      colormap?: unknown;
      rescaleMin?: unknown;
      rescaleMax?: unknown;
      nodata?: unknown;
    };
    // JSON.stringify (not a delimiter join) so a "|"/";" in a layer name or URL
    // cannot make two genuinely-different states collide and skip a refresh.
    parts.push([
      layer.id,
      layer.name,
      layer.visible,
      layer.opacity,
      source.url,
      source.bands,
      source.colormap,
      source.rescaleMin,
      source.rescaleMax,
      source.nodata,
      // maplibre-gl-raster layers keep their visualization (mode/bands/
      // colormap/rescale/nodata/...) in metadata.rasterState, not on `source`;
      // without it a restyle of a mirrored raster would not notify. Always
      // undefined for cog-url layers, so this is a no-op there.
      layer.metadata.rasterState,
    ]);
  }
  return JSON.stringify(parts);
}

/**
 * Subscribes to COG raster set/state changes (add/remove/visibility/opacity),
 * so the Layer Swipe plugin can keep its panel list and comparison-map mirror
 * in sync while a swipe is active.
 *
 * @param listener - Called after any relevant layer change.
 * @returns An unsubscribe function.
 */
export function subscribeSwipeCogChanges(listener: () => void): () => void {
  swipeCogChangeListeners.add(listener);
  // A change to any COG raster surfaces as a store `layers` array change; the
  // provider recompute is cheap, so notify on any layers change rather than
  // diffing here. Swipe's own main-map hide goes through the control directly
  // (setCogRasterMainVisibility), not the store, so it cannot loop back.
  swipeCogStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    // Cheap reference gate first; then only notify when the COG-raster subset
    // actually changed, so unrelated layer edits during a swipe don't trigger a
    // needless refreshLayers()/reconcile pass. Swipe's own main-map hide goes
    // through the control directly, not the store, so it cannot loop back.
    if (state.layers === previous.layers) return;
    if (swipeCogFingerprint(state.layers) !== swipeCogFingerprint(previous.layers)) {
      notifySwipeCogChange();
    }
  });
  return () => {
    swipeCogChangeListeners.delete(listener);
    if (swipeCogChangeListeners.size === 0) {
      swipeCogStoreUnsubscribe?.();
      swipeCogStoreUnsubscribe = null;
    }
  };
}

/**
 * Snapshots the store's CogLayerControl COG rasters for the Layer Swipe
 * provider, in store (paint) order.
 *
 * Scope: only `cog-url` rasters (Vantor / STAC, rendered by the shared
 * CogLayerControl) are surfaced. Locally-added GeoTIFFs (`geotiff-url`,
 * rendered on the separate geoTiffRasterOverlay) are also deck.gl custom layers
 * with the same #1240 root cause, but they use a different renderer and are out
 * of scope here; extend this and the mirror to cover them in a follow-up.
 *
 * @returns One snapshot per "cog-url" store layer with a URL source.
 */
export function getSwipeCogRasters(): SwipeCogRasterSnapshot[] {
  const snapshots: SwipeCogRasterSnapshot[] = [];
  for (const layer of useAppStore.getState().layers) {
    if (!isCogRasterControlLayer(layer)) continue;
    const source = layer.source as {
      url?: unknown;
      bands?: unknown;
      colormap?: unknown;
      rescaleMin?: unknown;
      rescaleMax?: unknown;
      nodata?: unknown;
    };
    if (typeof source.url !== "string") continue;
    snapshots.push({
      id: layer.id,
      name: layer.name,
      url: source.url,
      visible: layer.visible,
      opacity: layer.opacity,
      bands: typeof source.bands === "string" ? source.bands : undefined,
      colormap:
        typeof source.colormap === "string"
          ? (source.colormap as CogLayerControlOptions["defaultColormap"])
          : undefined,
      rescaleMin: typeof source.rescaleMin === "number" ? source.rescaleMin : undefined,
      rescaleMax: typeof source.rescaleMax === "number" ? source.rescaleMax : undefined,
      nodata: typeof source.nodata === "number" ? source.nodata : undefined,
    });
  }
  return snapshots;
}

/** Snapshot the newer maplibre-gl-raster layers, including project restores. */
export function getSwipeMaplibreRasters(): SwipeMaplibreRasterSnapshot[] {
  return useAppStore
    .getState()
    .layers.filter(isMaplibreRasterControlLayer)
    .flatMap((layer) => {
      const url = (layer.source as { url?: unknown }).url;
      if (typeof url !== "string") return [];
      return [
        {
          id: layer.id,
          name: layer.name,
          url,
          visible: layer.visible,
          opacity: layer.opacity,
          // Sanitized the same way the normal restore path does, so a
          // hand-edited project file cannot push malformed fields straight
          // into the mirror control's addRaster.
          state: savedRasterState(layer),
        },
      ];
    });
}

/**
 * Shows or hides a COG raster on the main map without writing the change back
 * to the store, so Layer Swipe can hide a right-only raster on the main map
 * while the Layers panel still lists it as visible. Visibility is opacity-based
 * in CogLayerControl, so the stored opacity is restored when showing it again.
 * A no-op when the control is not mounted.
 *
 * @param id - The raster layer id.
 * @param visible - Whether it should render on the main map.
 * @param opacity - The opacity to restore when making it visible.
 */
export function setCogRasterMainVisibility(id: string, visible: boolean, opacity: number): void {
  cogRasterControl?.setLayerVisibility(id, visible, opacity);
}

/**
 * Reads a COG raster's current visibility on the main map from the control
 * itself, so Layer Swipe can compare against the live state rather than its own
 * cached intent. The control's visibility is also driven independently by the
 * store-diff subscription (a Layers-panel visibility toggle), so a cached value
 * can drift; reading live avoids leaving a right-only raster shown after such a
 * toggle. Defaults to visible when the control or layer is absent.
 *
 * @param id - The raster layer id.
 * @returns Whether the raster currently renders on the main map.
 */
export function getCogRasterMainVisibility(id: string): boolean {
  return cogRasterControl?.getLayerVisibility(id) ?? true;
}

/**
 * Creates a hidden CogLayerControl bound to a given map (the Layer Swipe
 * comparison map) so the swipe plugin can render COG mirrors on the swipe's
 * clipped comparison view. The control's own UI is hidden; only its deck
 * overlay renders.
 *
 * @param map - The map to mount the mirror control on.
 * @returns The mirror control, or null if the components module fails to load.
 */
export async function createSwipeCogMirrorControl(
  map: maplibregl.Map,
): Promise<CogLayerControl | null> {
  const { CogLayerControl: CogLayerControlClass } = await getComponentsConstructors();
  const control = new CogLayerControlClass(COG_RASTER_OPTIONS);
  map.addControl(control);
  // Hide the panel/button: the mirror only contributes its deck overlay, which
  // the swipe control already clips to the comparison region.
  control.hide();
  control.collapse();
  return control;
}

/**
 * Renders one COG snapshot on a mirror control, matching the main map's
 * visualization (bands/colormap/rescale/nodata/opacity), and returns the
 * control-assigned layer id so the caller can later update or remove just that
 * layer.
 *
 * @param control - A mirror control from {@link createSwipeCogMirrorControl}.
 * @param snapshot - The COG raster to render.
 * @returns The new mirror layer id, or null if the add produced no layer.
 */
export async function mirrorAddCogLayer(
  control: CogLayerControl,
  snapshot: SwipeCogRasterSnapshot,
): Promise<string | null> {
  configureCogRasterControl(control, {
    url: snapshot.url,
    name: snapshot.name,
    bands: snapshot.bands,
    colormap: snapshot.colormap,
    rescaleMin: snapshot.rescaleMin,
    rescaleMax: snapshot.rescaleMax,
    nodata: snapshot.nodata,
    opacity: snapshot.opacity,
  });
  // addLayer generates the id internally; diff the control's layer-id set
  // around the call to find it, rather than relying on 'layeradd' firing before
  // the promise settles. Deterministic and independent of event/promise
  // ordering. Assumes addLayer adds exactly one new id; if a future
  // CogLayerControl dedupes/reuses an id and the diff is empty, log it so the
  // caller's "retry as a fresh add" fallback is visible rather than silent.
  const before = new Set(control.getLayerIds());
  await control.addLayer(snapshot.url);
  const newId = control.getLayerIds().find((id) => !before.has(id)) ?? null;
  if (!newId) {
    console.debug("[GeoLibre] swipe COG mirror: no new layer id after addLayer", snapshot.url);
  }
  return newId;
}

/**
 * Sets the opacity of a single mirrored raster without a reload.
 *
 * @param control - A mirror control from {@link createSwipeCogMirrorControl}.
 * @param mirrorLayerId - The mirror layer id from {@link mirrorAddCogLayer}.
 * @param opacity - The opacity (0-1).
 */
export function mirrorSetCogOpacity(
  control: CogLayerControl,
  mirrorLayerId: string,
  opacity: number,
): void {
  control.setLayerOpacity(mirrorLayerId, opacity);
}

/**
 * Removes a single mirrored raster by its mirror layer id.
 *
 * @param control - A mirror control from {@link createSwipeCogMirrorControl}.
 * @param mirrorLayerId - The mirror layer id from {@link mirrorAddCogLayer}.
 */
export function mirrorRemoveCogLayer(control: CogLayerControl, mirrorLayerId: string): void {
  control.removeLayer(mirrorLayerId);
}

/**
 * Removes every mirrored raster from a mirror control.
 *
 * @param control - A mirror control from {@link createSwipeCogMirrorControl}.
 */
export function clearMirrorCogLayers(control: CogLayerControl): void {
  control.removeLayer();
}

export function teardownCogRasterControl(app: GeoLibreAppAPI): void {
  cogRasterStoreUnsubscribe?.();
  cogRasterStoreUnsubscribe = null;
  if (cogRasterControl && cogRasterControlMounted) {
    app.removeMapControl(cogRasterControl);
  }
  cogRasterControl = null;
  cogRasterControlMounted = false;
}

function createCogRasterLayerAddHandler(): CogLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find((layer) => layer.id === event.layerId);
    if (!layerInfo) return;

    const pendingOptions = pendingCogRasterLayerOptions.shift();
    if (!pendingOptions && ignoredCogRasterLayerUrls.delete(layerInfo.url || event.url || "")) {
      cogRasterControl?.removeLayer(event.layerId);
      return;
    }

    const store = useAppStore.getState();
    const layer = createCogRasterStoreLayer(event.layerId, layerInfo, pendingOptions);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer, pendingOptions?.beforeLayerId);
  };
}

function addLayerWithCogRasterControl(
  control: CogLayerControl,
  options: CogRasterLayerOptions,
): Promise<string> {
  configureCogRasterControl(control, options);
  pendingCogRasterLayerOptions.push(options);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      ignoredCogRasterLayerUrls.add(options.url);
      settle(() =>
        reject(
          new Error(
            "The COG raster layer did not finish loading. Trying generic GeoTIFF rendering.",
          ),
        ),
      );
    }, 30000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      control.off("layeradd", handleLayerAdd);
      control.off("error", handleError);
      const pendingIndex = pendingCogRasterLayerOptions.indexOf(options);
      if (pendingIndex >= 0) {
        pendingCogRasterLayerOptions.splice(pendingIndex, 1);
      }
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleLayerAdd: CogLayerEventHandler = (event) => {
      if (!event.layerId || event.url !== options.url) return;
      settle(() => resolve(event.layerId!));
    };
    const handleError: CogLayerEventHandler = (event) => {
      settle(() => reject(new Error(event.error || "Failed to load the COG raster layer.")));
    };

    control.on("layeradd", handleLayerAdd);
    control.on("error", handleError);

    void control.addLayer(options.url).then(() => {
      const state = control.getState();
      if (!settled && state.error) {
        settle(() => reject(new Error(state.error || "Failed to load COG.")));
      }
    });
  });
}

function configureCogRasterControl(control: CogLayerControl, options: CogRasterLayerOptions): void {
  const mutableControl = control as unknown as MutableCogLayerControl;
  const state = mutableControl._state;
  if (state) {
    state.url = options.url;
    state.bands = options.bands?.trim() || "1";
    state.colormap = options.colormap ?? "none";
    state.rescaleMin = options.rescaleMin ?? 0;
    state.rescaleMax = options.rescaleMax ?? 255;
    state.nodata = options.nodata;
    state.layerName = options.name?.trim() || "";
    state.layerOpacity = options.opacity ?? 1;
    state.pickable = false;
  }
  if (mutableControl._options) {
    mutableControl._options.beforeId = options.beforeLayerId || "";
  }
  mutableControl._render?.();
}

function createCogRasterStoreLayer(
  id: string,
  layerInfo: CogLayerInfo,
  options?: CogRasterLayerOptions,
): GeoLibreLayer {
  const url = options?.url ?? layerInfo.url;
  const bands = options?.bands?.trim() || layerInfo.bands || "1";
  const colormap = options?.colormap ?? layerInfo.colormap;
  const rescaleMin = options?.rescaleMin ?? layerInfo.rescaleMin;
  const rescaleMax = options?.rescaleMax ?? layerInfo.rescaleMax;
  const nodata = options?.nodata ?? layerInfo.nodata;

  return {
    id,
    name: options?.name?.trim() || layerInfo.name || layerNameFromUrl(url, id),
    type: "cog",
    source: {
      bands,
      colormap,
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: id,
      type: "raster",
      url,
    },
    visible: true,
    opacity: options?.opacity ?? layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      bands,
      colormap,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [id],
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: id,
      sourceKind: "cog-url",
      tileType: "raster",
    },
    sourcePath: url,
  };
}

function isCogRasterControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "cog-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isMaplibreRasterControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "maplibre-gl-raster" &&
    layer.metadata.externalNativeLayer === true
  );
}
