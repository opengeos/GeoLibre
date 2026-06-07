import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import {
  DEFAULT_TILESET_URL,
  ThreeDTilesControl,
  ThreeDTilesLayer,
  type LoadedTilesetMetadata,
  type ThreeDTilesControlEventHandler,
  type ThreeDTilesControlOptions,
  type ThreeDTilesItemState,
} from "maplibre-gl-3d-tiles";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";

const threeDTilesControlPosition: GeoLibreMapControlPosition = "top-left";
const THREE_D_TILES_LAYER_ID = "geolibre-3d-tiles";
// Keep in sync with the three.js version maplibre-gl-3d-tiles is built
// against. Only used as a fallback when the control does not expose its own
// decoder paths (see getThreeDTilesDecoderOptions).
const THREE_VERSION = "0.184.0";
const DEFAULT_DRACO_DECODER_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/draco/`;
const DEFAULT_KTX2_TRANSCODER_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/basis/`;

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
let threeDTilesStoreSyncSuspended = 0;

type ThreeDTilesLayerInstance = InstanceType<typeof ThreeDTilesLayer>;

interface ThreeDTilesControlInternals {
  _layers?: Map<string, ThreeDTilesLayerInstance>;
  _options?: {
    dracoDecoderPath?: string;
    ktx2TranscoderPath?: string;
  };
}

export function openThreeDTilesLayerPanel(app: GeoLibreAppAPI): void {
  openStandaloneThreeDTilesControl(app);
}

export function closeThreeDTilesLayerPanel(app: GeoLibreAppAPI): void {
  if (threeDTilesControl && threeDTilesControlMounted) {
    app.removeMapControl(threeDTilesControl);
    return;
  }
  resetThreeDTilesControl(threeDTilesControl);
}

export function restoreThreeDTilesLayers(app: GeoLibreAppAPI): void {
  const layers = useAppStore
    .getState()
    .layers.filter(isThreeDTilesControlLayer);
  if (layers.length === 0) return;

  const control = runWithThreeDTilesStoreSyncSuspended(() =>
    ensureThreeDTilesControl(app),
  );
  if (!control) return;

  const panelCollapsed = threeDTilesPanelCollapsedFromLayers(layers);
  runWithThreeDTilesStoreSyncSuspended(() => {
    showThreeDTilesControl(control);
    threeDTilesPanelPinned = !panelCollapsed;
    if (panelCollapsed) {
      control.collapse();
    } else {
      control.expand();
    }
  });
  try {
    hydrateThreeDTilesControlFromStore(control, { replaceExisting: true });
    syncThreeDTilesStoreFromControl(control);
  } catch (error) {
    console.error("[GeoLibre] Failed to restore 3D Tiles layers", error);
  }
}

function openStandaloneThreeDTilesControl(app: GeoLibreAppAPI): boolean {
  const control = ensureThreeDTilesControl(app);
  if (!control) return false;

  window.setTimeout(() => {
    threeDTilesPanelPinned = true;
    showThreeDTilesControl(control);
    control.expand();
    try {
      hydrateThreeDTilesControlFromStore(control);
      syncThreeDTilesStoreFromControl(control);
    } catch (error) {
      console.error("[GeoLibre] Failed to open 3D Tiles layer panel", error);
    }
  }, 0);

  return true;
}

function ensureThreeDTilesControl(
  app: GeoLibreAppAPI,
): ThreeDTilesControl | null {
  threeDTilesControl ??= createThreeDTilesControl();

  if (!threeDTilesControlMounted) {
    const added = app.addMapControl(
      threeDTilesControl,
      threeDTilesControlPosition,
    );
    if (!added) {
      resetThreeDTilesControl(threeDTilesControl);
      return null;
    }
    threeDTilesControlMounted = true;
  }

  return threeDTilesControl;
}

function createThreeDTilesControl(): ThreeDTilesControl {
  const control = new ThreeDTilesControl(THREE_D_TILES_OPTIONS);
  const syncHandler: ThreeDTilesControlEventHandler = () => {
    if (!isThreeDTilesStoreSyncSuspended()) {
      syncThreeDTilesStoreFromControl(control);
    }
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
    const layer = createThreeDTilesStoreLayer(
      tileset,
      tileset.opacity,
      state.collapsed,
    );

    if (existingLayer) {
      const update = createThreeDTilesLayerUpdate(existingLayer, layer);
      if (update) store.updateLayer(layer.id, update);
      continue;
    }

    store.addLayer(layer);
  }
}

function hydrateThreeDTilesControlFromStore(
  control: ThreeDTilesControl,
  options: { replaceExisting?: boolean } = {},
): void {
  const layers = useAppStore
    .getState()
    .layers.filter(isThreeDTilesControlLayer);
  if (layers.length === 0) return;

  const tilesets = control.getState().tilesets;
  if (tilesets.length > 0) {
    if (!options.replaceExisting) return;

    runWithThreeDTilesStoreSyncSuspended(() => {
      for (const tileset of tilesets) {
        control.removeTileset(tileset.id);
      }
    });
  }

  for (const layer of layers) {
    const url = stringValue(layer.source.url) ?? layer.sourcePath;
    if (!url) continue;

    restoreThreeDTilesMapLayer(control, layer, url);
  }
}

function restoreThreeDTilesMapLayer(
  control: ThreeDTilesControl,
  layer: GeoLibreLayer,
  url: string,
): void {
  const map = control.getMap();
  const controlLayers = getThreeDTilesControlLayers(control);
  if (!map || !controlLayers) return;

  const id = layer.id;
  const layerId = restoredThreeDTilesLayerId(layer);
  const layerName = layer.name || layerNameFromUrl(url, id);
  const beforeId = validThreeDTilesBeforeId(control, layer.beforeId);
  const altitudeOffset = numberValue(layer.source.altitudeOffset, 0);
  const existingTilesets = control
    .getState()
    .tilesets.filter((tileset) => tileset.id !== id);
  const savedCenter = lngLatPairValue(layer.metadata.center);
  const savedAltitude = optionalNumberValue(layer.metadata.altitude);
  const status = savedCenter ? "loaded" : "loading";

  const restoredTileset: ThreeDTilesItemState = {
    id,
    layerId,
    layerName,
    beforeId,
    tilesetUrl: url,
    altitudeOffset,
    opacity: layer.opacity,
    visible: layer.visible,
    status,
    center: savedCenter,
    altitude: savedAltitude,
  };

  runWithThreeDTilesStoreSyncSuspended(() => {
    control.setState({
      activeTilesetId: id,
      altitude: restoredTileset.altitude,
      altitudeOffset,
      beforeId,
      center: restoredTileset.center,
      error: undefined,
      layerName,
      opacity: layer.opacity,
      status,
      tilesetUrl: url,
      tilesets: [...existingTilesets, restoredTileset],
      visible: layer.visible,
    });
  });

  if (map.getLayer(layerId)) {
    moveThreeDTilesMapLayer(map, layerId, beforeId);
    return;
  }

  const restoredLayer = new ThreeDTilesLayer({
    id: layerId,
    tilesetUrl: url,
    altitudeOffset,
    opacity: layer.opacity,
    visible: layer.visible,
    ...getThreeDTilesDecoderOptions(control),
    onLoad: (metadata) => updateThreeDTilesLoaded(control, id, metadata),
    onError: (error) => updateThreeDTilesError(control, id, error),
  });
  // ThreeDTilesControl keys its internal `_layers` map by tileset id (see
  // loadTileset/removeTileset in the library), so removeTileset(id) reaches
  // this entry. The ThreeDTilesLayer itself carries the native map layer id.
  controlLayers.set(id, restoredLayer);
  map.addLayer(restoredLayer, beforeId);
}

function updateThreeDTilesLoaded(
  control: ThreeDTilesControl,
  id: string,
  metadata: LoadedTilesetMetadata,
): void {
  const state = control.getState();
  const tilesets = state.tilesets.map((tileset) =>
    tileset.id === id
      ? {
          ...tileset,
          altitude: metadata.altitude,
          center: metadata.center,
          error: undefined,
          status: "loaded" as const,
        }
      : tileset,
  );
  const activeTileset =
    tilesets.find((tileset) => tileset.id === state.activeTilesetId) ??
    tilesets.at(-1);

  control.setState({
    altitude: activeTileset?.altitude,
    center: activeTileset?.center,
    error: activeTileset?.error,
    status: activeTileset?.status ?? "idle",
    tilesets,
  });
}

function updateThreeDTilesError(
  control: ThreeDTilesControl,
  id: string,
  error: Error,
): void {
  const state = control.getState();
  const message = error.message || "Unable to load 3D Tiles layer.";
  const tilesets = state.tilesets.map((tileset) =>
    tileset.id === id
      ? {
          ...tileset,
          error: message,
          status: "error" as const,
        }
      : tileset,
  );
  const activeTileset =
    tilesets.find((tileset) => tileset.id === state.activeTilesetId) ??
    tilesets.at(-1);

  control.setState({
    error: activeTileset?.error,
    status: activeTileset?.status ?? "idle",
    tilesets,
  });
}

function createThreeDTilesStoreLayer(
  tileset: ThreeDTilesItemState,
  opacity = 1,
  panelCollapsed = true,
): GeoLibreLayer {
  const layerName =
    tileset.layerName || layerNameFromUrl(tileset.tilesetUrl, tileset.id);
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
      panelCollapsed,
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
  if (existingLayer.beforeId !== layer.beforeId)
    update.beforeId = layer.beforeId;
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
  // Clear the suspension counter so a control torn down mid-hydration cannot
  // leave its successor permanently suppressing store sync events.
  threeDTilesStoreSyncSuspended = 0;
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
  runWithThreeDTilesStoreSyncSuspended(() => {
    control.setOpacity(opacity, id, false);
  });
}

function runWithThreeDTilesStoreSyncSuspended<T>(callback: () => T): T {
  threeDTilesStoreSyncSuspended += 1;
  try {
    return callback();
  } finally {
    threeDTilesStoreSyncSuspended -= 1;
  }
}

function isThreeDTilesStoreSyncSuspended(): boolean {
  return threeDTilesStoreSyncSuspended > 0;
}

function threeDTilesPanelCollapsedFromLayers(layers: GeoLibreLayer[]): boolean {
  const panelCollapsed = layers.find(
    (layer) => typeof layer.metadata.panelCollapsed === "boolean",
  )?.metadata.panelCollapsed;
  // Default to collapsed to match the control's initial state, so projects
  // saved before panelCollapsed existed do not pop the panel open on load.
  return typeof panelCollapsed === "boolean" ? panelCollapsed : true;
}

function validThreeDTilesBeforeId(
  control: ThreeDTilesControl,
  beforeId: string | undefined,
): string | undefined {
  if (!beforeId) return undefined;
  return control.getMap()?.getLayer(beforeId) ? beforeId : undefined;
}

function restoredThreeDTilesLayerId(layer: GeoLibreLayer): string {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  if (Array.isArray(nativeLayerIds)) {
    const layerId = nativeLayerIds.find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    if (layerId) return layerId;
  }
  return `${THREE_D_TILES_LAYER_ID}-${layer.id}`;
}

function getThreeDTilesControlLayers(
  control: ThreeDTilesControl,
): Map<string, ThreeDTilesLayerInstance> | null {
  const layers = (control as unknown as ThreeDTilesControlInternals)._layers;
  if (!(layers instanceof Map)) {
    console.warn(
      "[GeoLibre] ThreeDTilesControl._layers unavailable; skipping 3D Tiles restore. The library internals may have changed.",
    );
    return null;
  }
  return layers;
}

function getThreeDTilesDecoderOptions(control: ThreeDTilesControl): {
  dracoDecoderPath: string;
  ktx2TranscoderPath: string;
} {
  const options = (control as unknown as ThreeDTilesControlInternals)._options;
  if (!options?.dracoDecoderPath || !options?.ktx2TranscoderPath) {
    // The control normally exposes its configured decoder paths via _options.
    // When it does not, fall back to a CDN build of three pinned to the
    // version maplibre-gl-3d-tiles depends on (THREE_VERSION). This is a
    // network-dependent supply-chain fallback, so surface it for diagnosis.
    console.warn(
      `[GeoLibre] ThreeDTilesControl decoder paths unavailable; falling back to unpkg three@${THREE_VERSION}. Compressed tilesets will fail offline.`,
    );
  }
  return {
    dracoDecoderPath: options?.dracoDecoderPath ?? DEFAULT_DRACO_DECODER_PATH,
    ktx2TranscoderPath:
      options?.ktx2TranscoderPath ?? DEFAULT_KTX2_TRANSCODER_PATH,
  };
}

function moveThreeDTilesMapLayer(
  map: ReturnType<ThreeDTilesControl["getMap"]>,
  layerId: string,
  beforeId: string | undefined,
): void {
  if (!map?.getLayer(layerId)) return;
  try {
    if (beforeId && beforeId !== layerId && map.getLayer(beforeId)) {
      map.moveLayer(layerId, beforeId);
      return;
    }
    map.moveLayer(layerId);
  } catch {
    // Style reloads can make ordering transiently unavailable. The next
    // restore/sync pass will retry with the same saved layer metadata.
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function lngLatPairValue(value: unknown): [number, number] | undefined {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  ) {
    return [value[0], value[1]];
  }
  return undefined;
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
