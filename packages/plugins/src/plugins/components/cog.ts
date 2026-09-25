// The Layer Swipe integration for rasters drawn by CogLayerControl.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).
//
// GeoLibre no longer adds COGs through the main-map CogLayerControl: the host's
// `addCogLayer` goes to maplibre-gl-raster (see raster-layer-sync). What stays
// here is the swipe provider, which lists both maplibre-gl-raster layers and
// legacy "cog-url" layers from older project files and mirrors them onto the
// comparison map through a hidden CogLayerControl.

import type * as maplibregl from "maplibre-gl";
import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { CogLayerControl, CogLayerControlOptions } from "maplibre-gl-components";
import { savedRasterState } from "../raster-layer-sync";
import type { SwipeRasterSnapshot } from "../swipe-raster-mirror";
import { getComponentsConstructors } from "./constructors";
import type { CogRasterLayerOptions } from "./shared";

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

// --- Layer Swipe COG integration -------------------------------------------
// COG rasters are deck.gl custom layers that Layer Swipe cannot see through
// getStyle(). These helpers let the swipe plugin's layerProvider list them and
// render each per its side assignment: mirror right/both onto the swipe
// comparison map. See #1240 and swipe-cog-mirror.ts.

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
  // diffing here. Swipe's own main-map hide goes through the raster control
  // directly, not the store, so it cannot loop back.
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
