// The Gaussian splatting control.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type {
  GaussianSplatAssetPlacement,
  GaussianSplatControl,
  GaussianSplatLayerAdapter,
  GaussianSplatLoadOptions,
} from "maplibre-gl-splat";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import {
  type GaussianSplatControlConstructor,
  type GaussianSplatLayerAdapterConstructor,
  getComponentsConstructors,
} from "./constructors";
import { layerNameFromUrl } from "./shared";

type SplattingAssetType = "model" | "splat";

/** Where an asset sits on the map, as the control's load options take it. */
type SplattingPlacement = Pick<
  GaussianSplatLoadOptions,
  "longitude" | "latitude" | "altitude" | "rotation" | "scale"
>;

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
  // A hidden mount comes from a restore that is already running.
  if (reveal) void restoreSplattingLayers(app);
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
export async function restoreSplattingLayers(app: GeoLibreAppAPI): Promise<void> {
  if (splattingRestorePromise) {
    // A running restore took its snapshot of the store when it started; wait
    // for it, then look again for layers added since.
    await splattingRestorePromise.catch(() => {});
    return restoreSplattingLayers(app);
  }
  if (!hasPendingSplattingLayers()) return;
  splattingRestorePromise = runSplattingRestore(app).finally(() => {
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
  const control = splattingControl;
  if (!control) return;

  const pending = useAppStore
    .getState()
    .layers.filter((layer) => isSplattingControlLayer(layer) && !isSplattingLayerLoaded(layer.id));
  for (const layer of pending) {
    // Re-check against the live store: the layer may have been removed, or
    // loaded by the user, while an earlier restore was loading.
    if (!useAppStore.getState().layers.some((item) => item.id === layer.id)) continue;
    if (isSplattingLayerLoaded(layer.id)) continue;
    const assetType = splattingAssetType(layer);
    const url = splattingLayerUrl(layer);
    if (!assetType || !url) {
      console.warn("[splatting] cannot restore saved layer", layer.id);
      continue;
    }
    const options = { ...savedSplattingPlacement(layer), id: layer.id, flyTo: false };
    try {
      // The control rejects an id another load has taken meanwhile.
      if (assetType === "splat") await control.loadSplat(url, options);
      else await control.loadModel(url, options);
    } catch (error) {
      console.warn("[splatting] failed to restore saved layer", layer.id, error);
    }
  }
}

/** Whether a saved layer is a splat or a 3D model, from its source or its id. */
function splattingAssetType(layer: GeoLibreLayer): SplattingAssetType | null {
  const saved = (layer.source as { assetType?: unknown }).assetType;
  if (saved === "splat" || saved === "model") return saved;
  const prefix = /^(splat|model)-/.exec(layer.id)?.[1];
  return prefix === "splat" || prefix === "model" ? prefix : null;
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

function createSplattingControl(
  GaussianSplatControlClass: GaussianSplatControlConstructor,
  GaussianSplatLayerAdapterClass: GaussianSplatLayerAdapterConstructor,
): GaussianSplatControl {
  const control = new GaussianSplatControlClass({
    ...SPLATTING_OPTIONS,
    // maplibre-gl-splat restarts its `splat-N` / `model-N` counters at 0 for
    // each new control, so after a project is reopened (or the Components
    // plugin is toggled) a fresh load would otherwise take a saved layer's id.
    isIdReserved: (id) => useAppStore.getState().layers.some((layer) => layer.id === id),
  });
  splattingLayerAdapter = new GaussianSplatLayerAdapterClass(control);
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
  splattingControlRevealed = false;
}

function createSplattingLoadHandler(
  assetType: SplattingAssetType,
): Parameters<GaussianSplatControl["on"]>[1] {
  return (event) => {
    const id = assetType === "splat" ? event.splatId : event.modelId;
    if (!id || !event.url) return;

    const store = useAppStore.getState();
    const layer = createSplattingStoreLayer(id, event.url, assetType, event.placement);
    const existing = store.layers.find((item) => item.id === layer.id);
    if (existing) {
      // A restored layer: keep its saved placement, visibility and opacity, and
      // push the latter two onto the freshly loaded asset.
      store.updateLayer(layer.id, {
        metadata: { ...existing.metadata, ...layer.metadata },
        source: { ...layer.source, ...existing.source, ...sourceIdentity(layer) },
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

/** The source fields that identify a loaded asset, which always follow the load. */
function sourceIdentity(layer: GeoLibreLayer): Record<string, unknown> {
  const { assetType, sourceId, type, url } = layer.source as Record<string, unknown>;
  return { assetType, sourceId, type, url };
}

/**
 * The store layer for a loaded asset. Its source carries the placement
 * (position, rotation, scale) the control reports, which is what a saved
 * project needs to put the asset back where it was.
 */
function createSplattingStoreLayer(
  id: string,
  url: string,
  assetType: SplattingAssetType,
  placement?: GaussianSplatAssetPlacement,
): GeoLibreLayer {
  return {
    id,
    name: layerNameFromUrl(url, id),
    type: "gaussian-splat",
    source: {
      ...(placement && {
        longitude: placement.longitude,
        latitude: placement.latitude,
        altitude: placement.altitude,
        rotation: [...placement.rotation],
        scale: placement.scale,
      }),
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
  control?.hide();
}

function showSplattingControl(control: GaussianSplatControl | null): void {
  control?.show();
}
