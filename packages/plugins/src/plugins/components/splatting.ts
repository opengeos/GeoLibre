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

export function openSplattingLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneSplattingControl(app);
}

async function openStandaloneSplattingControl(app: GeoLibreAppAPI): Promise<boolean> {
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

  setTimeout(() => {
    showSplattingControl(splattingControl);
    splattingControl?.expand();
  }, 0);
  return true;
}

function createSplattingControl(
  GaussianSplatControlClass: GaussianSplatControlConstructor,
  GaussianSplatLayerAdapterClass: GaussianSplatLayerAdapterConstructor,
): GaussianSplatControl {
  const control = new GaussianSplatControlClass(SPLATTING_OPTIONS);
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
}

function createSplattingLoadHandler(
  assetType: "model" | "splat",
): Parameters<GaussianSplatControl["on"]>[1] {
  return (event) => {
    const id = assetType === "splat" ? event.splatId : event.modelId;
    if (!id || !event.url) return;

    const store = useAppStore.getState();
    const layer = createSplattingStoreLayer(id, event.url, assetType);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        visible: layer.visible,
      });
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
  assetType: "model" | "splat",
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
