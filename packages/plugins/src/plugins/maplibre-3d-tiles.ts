import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import {
  DEFAULT_TILESET_URL,
  ThreeDTilesControl,
  type ThreeDTilesControlEventHandler,
  type ThreeDTilesControlOptions,
  type ThreeDTilesItemState,
} from "maplibre-gl-3d-tiles";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
} from "../types";

const threeDTilesControlPosition: GeoLibreMapControlPosition = "top-left";
const THREE_D_TILES_LAYER_ID = "geolibre-3d-tiles";

const THREE_D_TILES_OPTIONS = {
  className: "geolibre-3d-tiles-control",
  collapsed: true,
  collapseOnClickOutside: false,
  layerId: THREE_D_TILES_LAYER_ID,
  panelWidth: 365,
  title: "Add 3D Tiles Layer",
  tilesetUrl: DEFAULT_TILESET_URL,
} satisfies ThreeDTilesControlOptions;

let threeDTilesControl: ThreeDTilesControl | null = null;
let threeDTilesControlMounted = false;
let threeDTilesPanelPinned = false;
let threeDTilesStoreUnsubscribe: (() => void) | null = null;

export function openThreeDTilesLayerPanel(app: GeoLibreAppAPI): void {
  openStandaloneThreeDTilesControl(app);
}

function openStandaloneThreeDTilesControl(app: GeoLibreAppAPI): boolean {
  threeDTilesControl ??= createThreeDTilesControl();

  if (!threeDTilesControlMounted) {
    const added = app.addMapControl(
      threeDTilesControl,
      threeDTilesControlPosition,
    );
    if (!added) {
      resetThreeDTilesControl(threeDTilesControl);
      return false;
    }
    threeDTilesControlMounted = true;
  }

  const control = threeDTilesControl;
  window.setTimeout(() => {
    threeDTilesPanelPinned = true;
    showThreeDTilesControl(control);
    control.expand();
    void hydrateThreeDTilesControlFromStore(control).then(() => {
      syncThreeDTilesStoreFromControl(control);
    });
  }, 0);

  return true;
}

function createThreeDTilesControl(): ThreeDTilesControl {
  const control = new ThreeDTilesControl(THREE_D_TILES_OPTIONS);
  const syncHandler: ThreeDTilesControlEventHandler = () => {
    syncThreeDTilesStoreFromControl(control);
    keepThreeDTilesPanelExpanded(control);
    // The panel may render after showThreeDTilesControl ran, so retry the
    // (idempotent) handler installation whenever the control state changes.
    installThreeDTilesPanelHandlers(control);
  };

  control.on("statechange", syncHandler);
  patchThreeDTilesControlOnRemove(control);
  threeDTilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isThreeDTilesControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        if (hasThreeDTilesTileset(control, layer.id)) {
          control.removeTileset(layer.id);
        }
        continue;
      }

      if (!isThreeDTilesControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        control.setVisible(currentLayer.visible, currentLayer.id);
      }

      if (currentLayer.opacity !== layer.opacity) {
        setThreeDTilesOpacity(control, currentLayer.id, currentLayer.opacity);
      }
    }
  });

  return control;
}

function syncThreeDTilesStoreFromControl(control: ThreeDTilesControl): void {
  const store = useAppStore.getState();
  const state = control.getState();
  const tilesetIds = new Set(state.tilesets.map((tileset) => tileset.id));

  for (const layer of store.layers) {
    if (isThreeDTilesControlLayer(layer) && !tilesetIds.has(layer.id)) {
      store.removeLayer(layer.id);
    }
  }

  // Re-read state: the removals above produce a new store snapshot, so the
  // captured `store.layers` would still include the just-removed layers.
  const layersById = new Map(
    useAppStore.getState().layers.map((layer) => [layer.id, layer]),
  );
  for (const tileset of state.tilesets) {
    const existingLayer = layersById.get(tileset.id);
    const layer = createThreeDTilesStoreLayer(tileset, tileset.opacity);

    if (existingLayer) {
      const update = createThreeDTilesLayerUpdate(existingLayer, layer);
      if (update) store.updateLayer(layer.id, update);
      continue;
    }

    store.addLayer(layer);
  }
}

async function hydrateThreeDTilesControlFromStore(
  control: ThreeDTilesControl,
): Promise<void> {
  if (control.getState().tilesets.length > 0) return;

  const layers = useAppStore
    .getState()
    .layers.filter(isThreeDTilesControlLayer);
  for (const layer of layers) {
    const url = stringValue(layer.source.url) ?? layer.sourcePath;
    if (!url) continue;

    const layerValues = {
      beforeId: layer.beforeId,
      layerName: layer.name,
    };
    const id = await control.loadTileset(url, {
      altitudeOffset: numberValue(layer.source.altitudeOffset, 0),
      beforeId: layerValues.beforeId,
      flyToOnLoad: false,
      layerName: layerValues.layerName,
      opacity: layer.opacity,
      visible: layer.visible,
    });
    if (id) setThreeDTilesOpacity(control, id, layer.opacity);
  }
}

function createThreeDTilesStoreLayer(
  tileset: ThreeDTilesItemState,
  opacity = 1,
): GeoLibreLayer {
  const layerName = tileset.layerName || layerNameFromUrl(tileset.tilesetUrl, tileset.id);
  const beforeId = tileset.beforeId;

  return {
    id: tileset.id,
    name: layerName,
    type: "3d-tiles",
    source: {
      altitudeOffset: tileset.altitudeOffset,
      sourceId: tileset.id,
      type: "3d-tiles",
      url: tileset.tilesetUrl,
    },
    visible: tileset.visible,
    opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    beforeId,
    metadata: {
      altitude: tileset.altitude,
      altitudeOffset: tileset.altitudeOffset,
      beforeId,
      center: tileset.center,
      customLayerType: "3d-tiles",
      error: tileset.error,
      externalNativeLayer: true,
      identifiable: false,
      layerName,
      nativeLayerIds: [tileset.layerId],
      sourceId: tileset.id,
      sourceKind: "3d-tiles-url",
      status: tileset.status,
    },
    sourcePath: tileset.tilesetUrl,
  };
}

function createThreeDTilesLayerUpdate(
  existingLayer: GeoLibreLayer,
  layer: GeoLibreLayer,
): Partial<GeoLibreLayer> | null {
  const update: Partial<GeoLibreLayer> = {};
  const name = existingLayer.name || layer.name;

  if (existingLayer.name !== name) update.name = name;
  if (existingLayer.beforeId !== layer.beforeId) update.beforeId = layer.beforeId;
  if (existingLayer.opacity !== layer.opacity) update.opacity = layer.opacity;
  if (existingLayer.visible !== layer.visible) update.visible = layer.visible;
  if (existingLayer.sourcePath !== layer.sourcePath) {
    update.sourcePath = layer.sourcePath;
  }
  if (!recordsEqual(existingLayer.source, layer.source)) {
    update.source = layer.source;
  }
  if (!recordsEqual(existingLayer.metadata, layer.metadata)) {
    update.metadata = layer.metadata;
  }

  return Object.keys(update).length > 0 ? update : null;
}

function patchThreeDTilesControlOnRemove(control: ThreeDTilesControl): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    resetThreeDTilesControl(control);
  };
}

function resetThreeDTilesControl(control: ThreeDTilesControl | null): void {
  if (threeDTilesControl !== control) return;

  threeDTilesStoreUnsubscribe?.();
  threeDTilesStoreUnsubscribe = null;
  threeDTilesPanelPinned = false;
  threeDTilesControlMounted = false;
  threeDTilesControl = null;
}

function isThreeDTilesControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "3d-tiles" &&
    layer.metadata.sourceKind === "3d-tiles-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function hasThreeDTilesTileset(
  control: ThreeDTilesControl,
  id: string,
): boolean {
  return control.getState().tilesets.some((tileset) => tileset.id === id);
}

function hideThreeDTilesControl(control: ThreeDTilesControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showThreeDTilesControl(control: ThreeDTilesControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";
  installThreeDTilesPanelHandlers(control);
}

function installThreeDTilesPanelHandlers(
  control: ThreeDTilesControl | null,
): void {
  const panel = getThreeDTilesPanel(control);
  if (panel) {
    panel.classList.add("geolibre-3d-tiles-panel");
    installThreeDTilesCloseHandler(control, panel);
  }
  installThreeDTilesToggleHandler(control);
}

function getThreeDTilesPanel(
  control: ThreeDTilesControl | null,
): HTMLElement | null {
  return (
    control
      ?.getMap()
      ?.getContainer()
      .querySelector<HTMLElement>(".three-d-tiles-control-panel") ?? null
  );
}

function installThreeDTilesToggleHandler(
  control: ThreeDTilesControl | null,
): void {
  if (!control) return;

  const toggleButton = control
    .getContainer()
    ?.querySelector<HTMLButtonElement>(".three-d-tiles-control-toggle");
  if (!toggleButton || toggleButton.dataset.geolibreToggleHandler === "true") {
    return;
  }

  toggleButton.dataset.geolibreToggleHandler = "true";
  toggleButton.addEventListener(
    "click",
    () => {
      threeDTilesPanelPinned = false;
      window.setTimeout(() => {
        threeDTilesPanelPinned = !control.getState().collapsed;
      }, 0);
    },
    { capture: true },
  );
}

function installThreeDTilesCloseHandler(
  control: ThreeDTilesControl | null,
  panel: HTMLElement | null,
): void {
  const closeButton = panel?.querySelector<HTMLButtonElement>(
    ".three-d-tiles-control-close",
  );
  if (!closeButton || closeButton.dataset.geolibreCloseHandler === "true") {
    return;
  }

  closeButton.dataset.geolibreCloseHandler = "true";
  closeButton.addEventListener("click", () => {
    threeDTilesPanelPinned = false;
    window.setTimeout(() => hideThreeDTilesControl(control), 0);
  });
}

function keepThreeDTilesPanelExpanded(control: ThreeDTilesControl): void {
  if (!threeDTilesPanelPinned || !control.getState().collapsed) return;

  window.setTimeout(() => {
    if (threeDTilesPanelPinned && control.getState().collapsed) {
      control.expand();
    }
  }, 0);
}

function setThreeDTilesOpacity(
  control: ThreeDTilesControl,
  id: string,
  opacity: number,
): void {
  control.setOpacity(opacity, id, false);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!valuesEqual(left[key], right[key])) return false;
  }
  return true;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }

  if (isRecord(left) || isRecord(right)) {
    return isRecord(left) && isRecord(right) && recordsEqual(left, right);
  }

  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function layerNameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const fileName = segments.at(-1);
    const parentName = segments.at(-2);
    return parentName && fileName
      ? `${parentName}/${fileName}`
      : (fileName ?? parsed.hostname);
  } catch {
    return fallback;
  }
}
