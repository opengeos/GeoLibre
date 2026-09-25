// The Gaussian splatting control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { GaussianSplatControl, GaussianSplatLayerAdapter } from "maplibre-gl-splat";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import {
  type GaussianSplatControlConstructor,
  type GaussianSplatLayerAdapterConstructor,
  getComponentsConstructors,
} from "./constructors";
import { layerNameFromUrl } from "./shared";

interface SplattingControlVisibilityState {
  _container?: HTMLElement | null;
}

type SplattingAssetType = "model" | "splat";

/** Where an asset sits on the map, as the control's load options take it. */
interface SplattingPlacement {
  longitude?: number;
  latitude?: number;
  altitude?: number;
  rotation?: [number, number, number];
  scale?: number;
}

type SplattingLoad = (url: string, options?: SplattingPlacement) => Promise<string>;

// The control internals GeoLibre reads or patches. maplibre-gl-splat keeps its
// id counters and loaded-asset maps private, and exposes no way to choose an id.
interface MutableSplattingControl {
  _layerCounter?: number;
  _modelCounter?: number;
  _modelLayers?: Map<string, SplattingPlacement>;
  _options?: { defaultModelRotation?: [number, number, number]; flyTo?: boolean };
  _splatLayers?: Map<string, SplattingPlacement>;
  _state?: { rotation?: [number, number, number]; scale?: number };
  loadModel: SplattingLoad;
  loadSplat: SplattingLoad;
}

const SPLATTING_ID_PATTERN = /^(splat|model)-(\d+)$/;

// Upstream names each loaded asset `splat-N` / `model-N` from a per-control
// counter. The counters live on the control instance, so the id a restore
// needs is forced through this state (see reserveSplattingIds).
interface SplattingIdState {
  forced: Partial<Record<SplattingAssetType, number>>;
}

const splattingControlPosition: GeoLibreMapControlPosition = "top-left";

const SPLATTING_SAMPLE_URL = "https://maplibre.org/maplibre-gl-js/docs/assets/34M_17/34M_17.gltf";

const SPLATTING_OPTIONS = {
  className: "geolibre-splatting-control",
  collapsed: false,
  defaultAltitude: 0,
  defaultLatitude: -35.39847,
  defaultLongitude: 148.9819,
  defaultRotation: [-90, 90, 0],
  defaultScale: 0.03,
  // Empty input; the sample asset is the explicit, opt-in way to load one.
  sampleData: [{ label: "Bicycle", url: SPLATTING_SAMPLE_URL }],
  flyTo: true,
  // No maxHeight: the panel (maplibre-gl-splat >= 0.2.5) sizes to its content
  // and grows up to the available vertical space, so a fixed cap is neither
  // needed nor honored.
  panelWidth: 365,
  title: "Gaussian Splats",
} satisfies ConstructorParameters<GaussianSplatControlConstructor>[0];

let splattingControl: GaussianSplatControl | null = null;
let splattingLayerAdapter: GaussianSplatLayerAdapter | null = null;
let splattingControlMounted = false;
let splattingStoreUnsubscribe: (() => void) | null = null;
let splattingIdState: SplattingIdState | null = null;
let splattingRestorePromise: Promise<void> | null = null;
let splattingControlRevealed = false;

export function openSplattingLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneSplattingControl(app);
}

async function openStandaloneSplattingControl(
  app: GeoLibreAppAPI,
  { reveal = true }: { reveal?: boolean } = {},
): Promise<boolean> {
  const {
    GaussianSplatControl: GaussianSplatControlClass,
    GaussianSplatLayerAdapter: GaussianSplatLayerAdapterClass,
  } = await getComponentsConstructors();

  splattingControl ??= createSplattingControl(
    GaussianSplatControlClass,
    GaussianSplatLayerAdapterClass,
  );

  if (!splattingControlMounted) {
    const added = app.addMapControl(splattingControl, splattingControlPosition);
    if (!added) {
      splattingControl = null;
      return false;
    }
    splattingControlMounted = true;
  }

  if (reveal) {
    setTimeout(() => {
      showSplattingControl(splattingControl);
      splattingControl?.expand();
    }, 0);
  } else if (!splattingControlRevealed) {
    // Mounted only to draw restored layers: keep the panel out of the way
    // until the user opens it.
    hideSplattingControl(splattingControl);
  }
  if (reveal) splattingControlRevealed = true;
  void restoreSplattingLayers(app);
  return true;
}

/**
 * Reloads the saved Gaussian splat and 3D model layers the control has not
 * loaded yet. A `splatting-url` layer restores into the store as inert
 * metadata; the asset itself is drawn by the control, so without this a
 * reopened project lists the layer but renders nothing.
 *
 * Each asset is reloaded under its saved id (so the store layer, the Layers
 * panel, and any project references keep pointing at it), at its saved
 * placement, one at a time and without the per-load fly-to.
 *
 * Mounts the control (hidden) when there is something to restore, so a
 * reopened project draws its splats without the user opening the panel.
 *
 * @param app - The GeoLibre app API.
 * @returns Resolves once every pending layer has been attempted.
 */
export function restoreSplattingLayers(app: GeoLibreAppAPI): Promise<void> {
  if (!hasPendingSplattingLayers()) return splattingRestorePromise ?? Promise.resolve();
  splattingRestorePromise ??= runSplattingRestore(app).finally(() => {
    splattingRestorePromise = null;
  });
  return splattingRestorePromise;
}

function hasPendingSplattingLayers(): boolean {
  return useAppStore
    .getState()
    .layers.some((layer) => isSplattingControlLayer(layer) && !isSplattingLayerLoaded(layer.id));
}

async function runSplattingRestore(app: GeoLibreAppAPI): Promise<void> {
  if (!splattingControlMounted) {
    const opened = await openStandaloneSplattingControl(app, { reveal: false });
    if (!opened) return;
  }
  const control = splattingControl as unknown as MutableSplattingControl | null;
  const idState = splattingIdState;
  if (!control || !idState) return;

  const pending = useAppStore
    .getState()
    .layers.filter((layer) => isSplattingControlLayer(layer) && !isSplattingLayerLoaded(layer.id));
  if (pending.length === 0) return;

  const options = control._options;
  const flyTo = options?.flyTo;
  if (options) options.flyTo = false;
  try {
    for (const layer of pending) {
      // Re-check against the live store: the layer may have been removed, or
      // loaded by the user, while an earlier restore was loading.
      if (!useAppStore.getState().layers.some((item) => item.id === layer.id)) continue;
      if (isSplattingLayerLoaded(layer.id)) continue;
      const match = SPLATTING_ID_PATTERN.exec(layer.id);
      const url = splattingLayerUrl(layer);
      if (!match || !url) {
        console.warn("[splatting] cannot restore saved layer", layer.id);
        continue;
      }
      const assetType = match[1] as SplattingAssetType;
      const load = assetType === "splat" ? control.loadSplat : control.loadModel;
      idState.forced[assetType] = Number(match[2]);
      try {
        const loadedId = await load.call(control, url, savedSplattingPlacement(layer));
        if (loadedId !== layer.id) {
          // Another load took the forced id first. Drop the duplicate rather
          // than leave a second store layer for the same asset.
          console.warn("[splatting] restored layer got a different id", layer.id, loadedId);
          if (assetType === "splat") splattingControl?.removeSplat(loadedId);
          else splattingControl?.removeModel(loadedId);
        }
      } catch (error) {
        console.warn("[splatting] failed to restore saved layer", layer.id, error);
      } finally {
        delete idState.forced[assetType];
      }
    }
  } finally {
    if (options) options.flyTo = flyTo;
  }
}

function isSplattingLayerLoaded(id: string): boolean {
  return splattingLayerAdapter?.getLayerIds().includes(id) ?? false;
}

function splattingLayerUrl(layer: GeoLibreLayer): string | null {
  const url = (layer.source as { url?: unknown }).url;
  if (typeof url === "string" && url) return url;
  return layer.sourcePath || null;
}

function savedSplattingPlacement(layer: GeoLibreLayer): SplattingPlacement {
  const source = layer.source as Record<string, unknown>;
  const placement: SplattingPlacement = {};
  for (const key of ["longitude", "latitude", "altitude", "scale"] as const) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) placement[key] = value;
  }
  const rotation = source.rotation;
  if (
    Array.isArray(rotation) &&
    rotation.length === 3 &&
    rotation.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    placement.rotation = rotation as [number, number, number];
  }
  return placement;
}

/**
 * Makes the control's `splat-N` / `model-N` ids skip every id already in the
 * store. maplibre-gl-splat restarts its counters at 0 for each new control, so
 * after a project is reopened (or the Components plugin is toggled) a fresh
 * load would otherwise take a saved layer's id and overwrite that layer.
 *
 * The counters are private upstream fields read as `this._layerCounter++` at
 * the moment an id is assigned, so they are replaced with accessors: a read
 * returns the forced id of a restore, or else the lowest free index at or above
 * the counter; a write moves the counter past the id just taken.
 *
 * @param control - The splat control to patch.
 * @returns The state a restore uses to force a saved id.
 */
function reserveSplattingIds(control: GaussianSplatControl): SplattingIdState {
  const state: SplattingIdState = { forced: {} };
  const fields = { model: "_modelCounter", splat: "_layerCounter" } as const;
  for (const assetType of ["splat", "model"] as const) {
    const field = fields[assetType];
    let next = Number((control as unknown as MutableSplattingControl)[field]) || 0;
    Object.defineProperty(control, field, {
      configurable: true,
      enumerable: true,
      get: () => {
        const forced = state.forced[assetType];
        if (forced !== undefined) return forced;
        const taken = new Set(useAppStore.getState().layers.map((layer) => layer.id));
        for (const id of splattingLayerAdapter?.getLayerIds() ?? []) taken.add(id);
        let index = next;
        while (taken.has(`${assetType}-${index}`)) index += 1;
        return index;
      },
      set: (value: number) => {
        // A forced id is used once; clearing it here (as the id is taken)
        // rather than after the load keeps a concurrent load off it.
        delete state.forced[assetType];
        if (Number.isFinite(value)) next = Math.max(next, value);
      },
    });
  }
  return state;
}

/**
 * Wraps the control's loaders so each loaded asset's placement (position,
 * rotation, scale) is written onto its store layer. Upstream keeps no record of
 * rotation or scale, and the store layer is what a saved project carries, so
 * without this a restore could not put the asset back where it was.
 *
 * @param control - The splat control to patch.
 */
function recordSplattingPlacements(control: GaussianSplatControl): void {
  const mutable = control as unknown as MutableSplattingControl;
  for (const assetType of ["splat", "model"] as const) {
    const key = assetType === "splat" ? "loadSplat" : "loadModel";
    const original = mutable[key];
    if (typeof original !== "function") continue;
    mutable[key] = async (url, options) => {
      // Resolved the way upstream resolves them, before its first await.
      const rotation =
        options?.rotation ??
        (assetType === "splat" ? mutable._state?.rotation : mutable._options?.defaultModelRotation);
      const scale = options?.scale ?? mutable._state?.scale;
      const id = await original.call(control, url, options);
      const loaded = (assetType === "splat" ? mutable._splatLayers : mutable._modelLayers)?.get(id);
      const placement: SplattingPlacement = {
        altitude: loaded?.altitude ?? options?.altitude,
        latitude: loaded?.latitude ?? options?.latitude,
        longitude: loaded?.longitude ?? options?.longitude,
        rotation: rotation ? [rotation[0], rotation[1], rotation[2]] : undefined,
        scale,
      };
      const store = useAppStore.getState();
      const layer = store.layers.find((item) => item.id === id);
      if (layer && isSplattingControlLayer(layer)) {
        const defined = Object.fromEntries(
          Object.entries(placement).filter(([, value]) => value !== undefined),
        );
        store.updateLayer(id, { source: { ...layer.source, ...defined } });
      }
      return id;
    };
  }
}

function createSplattingControl(
  GaussianSplatControlClass: GaussianSplatControlConstructor,
  GaussianSplatLayerAdapterClass: GaussianSplatLayerAdapterConstructor,
): GaussianSplatControl {
  const control = new GaussianSplatControlClass(SPLATTING_OPTIONS);
  splattingLayerAdapter = new GaussianSplatLayerAdapterClass(control);
  splattingIdState = reserveSplattingIds(control);
  recordSplattingPlacements(control);
  control.on("collapse", () => hideSplattingControl(control));
  control.on("splatload", createSplattingLoadHandler("splat"));
  control.on("modelload", createSplattingLoadHandler("model"));
  control.on("splatremove", createSplattingRemoveHandler());
  control.on("modelremove", createSplattingRemoveHandler());
  splattingStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isSplattingControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        splattingLayerAdapter?.removeLayer(layer.id);
        continue;
      }

      if (!isSplattingControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        splattingLayerAdapter?.setVisibility(currentLayer.id, currentLayer.visible);
      }

      if (currentLayer.opacity !== layer.opacity) {
        splattingLayerAdapter?.setOpacity(currentLayer.id, currentLayer.opacity);
      }
    }
  });
  return control;
}

export function teardownSplattingControl(app: GeoLibreAppAPI): void {
  splattingStoreUnsubscribe?.();
  splattingStoreUnsubscribe = null;
  splattingLayerAdapter?.destroy();
  splattingLayerAdapter = null;
  if (splattingControl && splattingControlMounted) {
    app.removeMapControl(splattingControl);
  }
  splattingControl = null;
  splattingControlMounted = false;
  splattingIdState = null;
  splattingControlRevealed = false;
}

function createSplattingLoadHandler(
  assetType: SplattingAssetType,
): Parameters<GaussianSplatControl["on"]>[1] {
  return (event) => {
    const id = assetType === "splat" ? event.splatId : event.modelId;
    if (!id || !event.url) return;

    const store = useAppStore.getState();
    const layer = createSplattingStoreLayer(id, event.url, assetType);
    const existing = store.layers.find((item) => item.id === layer.id);
    if (existing) {
      // A restored layer: keep its saved placement, visibility and opacity, and
      // push the latter two onto the freshly loaded asset.
      store.updateLayer(layer.id, {
        metadata: { ...existing.metadata, ...layer.metadata },
        source: { ...existing.source, ...layer.source },
      });
      if (!existing.visible) splattingLayerAdapter?.setVisibility(id, false);
      if (existing.opacity !== 1) splattingLayerAdapter?.setOpacity(id, existing.opacity);
      return;
    }
    store.addLayer(layer);
  };
}

function createSplattingRemoveHandler(): Parameters<GaussianSplatControl["on"]>[1] {
  return (event) => {
    const id = event.splatId ?? event.modelId;
    if (!id) return;

    const store = useAppStore.getState();
    const layer = store.layers.find((item) => item.id === id);
    if (layer && isSplattingControlLayer(layer)) {
      store.removeLayer(id);
    }
  };
}

function createSplattingStoreLayer(
  id: string,
  url: string,
  assetType: SplattingAssetType,
): GeoLibreLayer {
  return {
    id,
    name: layerNameFromUrl(url, id),
    type: "gaussian-splat",
    source: {
      assetType,
      sourceId: id,
      type: "gaussian-splat",
      url,
    },
    visible: true,
    opacity: splattingLayerAdapter?.getLayerState(id)?.opacity ?? 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assetType,
      customLayerType: "gaussian-splat",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      sourceKind: "splatting-url",
    },
    sourcePath: url,
  };
}

function isSplattingControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "gaussian-splat" &&
    layer.metadata.sourceKind === "splatting-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function hideSplattingControl(control: GaussianSplatControl | null): void {
  const container = getSplattingControlContainer(control);
  if (container) container.style.display = "none";
}

function showSplattingControl(control: GaussianSplatControl | null): void {
  const container = getSplattingControlContainer(control);
  if (container) container.style.display = "";
}

function getSplattingControlContainer(control: GaussianSplatControl | null): HTMLElement | null {
  return (control as SplattingControlVisibilityState | null)?._container ?? null;
}
