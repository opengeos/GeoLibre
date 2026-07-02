import {
  DEFAULT_LAYER_STYLE,
  getGoogleMapsApiKey,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import {
  DEFAULT_TILESET_URL,
  ThreeDTilesControl,
  ThreeDTilesLayer,
  type LoadedTilesetMetadata,
  type ThreeDTilesControlEventHandler,
  type ThreeDTilesControlOptions,
  type ThreeDTilesItemState,
} from "maplibre-gl-3d-tiles";
import type {
  GeoLibreAppAPI,
  GeoLibreDeckGL,
  GeoLibreMapControlPosition,
} from "../types";
import { ensureMercatorProjection } from "./map-projection-utils";

const threeDTilesControlPosition: GeoLibreMapControlPosition = "top-left";
const THREE_D_TILES_LAYER_ID = "geolibre-3d-tiles";
// Keep in sync with the three.js version maplibre-gl-3d-tiles is built
// against. Only used as a fallback when the control does not expose its own
// decoder paths (see getThreeDTilesDecoderOptions).
const THREE_VERSION = "0.184.0";
const DEFAULT_DRACO_DECODER_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/draco/`;
const DEFAULT_KTX2_TRANSCODER_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/basis/`;
const GOOGLE_PHOTOREALISTIC_TILES_URL =
  "https://tile.googleapis.com/v1/3dtiles/root.json";
const GOOGLE_PHOTOREALISTIC_TILES_LABEL =
  "Google Photorealistic 3D Tiles";
const GOOGLE_MAPS_API_KEY_HEADER = "X-GOOG-API-KEY";
const GOOGLE_MAPS_API_KEY_MASK = "********";
const GOOGLE_PHOTOREALISTIC_SOURCE_KIND =
  "google-photorealistic-3d-tiles";
const GOOGLE_PHOTOREALISTIC_LAYER_ID_PREFIX =
  "geolibre-google-photorealistic-3d-tiles";
const GOOGLE_PHOTOREALISTIC_INITIAL_VIEW = {
  center: [14.42, 50.089] as [number, number],
  zoom: 16,
  bearing: 90,
  pitch: 60,
};

const THREE_D_TILES_OPTIONS = {
  className: "geolibre-3d-tiles-control",
  collapsed: true,
  collapseOnClickOutside: false,
  layerId: THREE_D_TILES_LAYER_ID,
  panelWidth: 365,
  title: "Add 3D Tiles Layer",
  // Empty input; the sample tileset is the explicit, opt-in way to load one.
  tilesetUrl: "",
  sampleData: [
    { label: "AGI HQ", url: DEFAULT_TILESET_URL },
    {
      label: GOOGLE_PHOTOREALISTIC_TILES_LABEL,
      url: GOOGLE_PHOTOREALISTIC_TILES_URL,
    },
  ],
} satisfies ThreeDTilesControlOptions;

let threeDTilesControl: ThreeDTilesControl | null = null;
let threeDTilesControlMounted = false;
let threeDTilesPanelPinned = false;
let threeDTilesStoreUnsubscribe: (() => void) | null = null;
let threeDTilesStoreSyncSuspended = 0;
let threeDTilesRuntimeEnvUnsubscribe: (() => void) | null = null;
let activeThreeDTilesApp: GeoLibreAppAPI | null = null;

let googleTilesOverlay: MapboxOverlay | null = null;
let googleTilesOverlayMounted = false;
let googleTilesStoreUnsubscribe: (() => void) | null = null;
let googleTilesDeckGL: GeoLibreDeckGL | null = null;
let googleTilesApp: GeoLibreAppAPI | null = null;
let googleTilesBoundMap: unknown;
let ensureGoogleTilesOverlayInFlight: Promise<void> | null = null;

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
  restoreGooglePhotorealisticTilesLayers(app);

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
  activeThreeDTilesApp = app;
  threeDTilesControl ??= createThreeDTilesControl();

  if (!threeDTilesControlMounted) {
    const added = app.addMapControl(
      threeDTilesControl,
      threeDTilesControlPosition,
    );
    if (!added) {
      resetThreeDTilesControl(threeDTilesControl);
      if (activeThreeDTilesApp === app) activeThreeDTilesApp = null;
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
  addThreeDTilesRuntimeEnvListener(control);
  threeDTilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) {
      updateGooglePhotorealisticTilesPanelList(control);
    }

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
  const requestHeaders = resolveThreeDTilesRequestHeaders(
    url,
    stringRecordValue(layer.source.requestHeaders),
  );
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
    requestHeaders,
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
      requestHeaders,
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
    requestHeaders,
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
      // Non-Google authenticated tilesets still persist their headers. Google
      // Photorealistic 3D Tiles resolves its API key from runtime env instead,
      // so shared projects do not carry the key in plain text.
      requestHeaders: persistedThreeDTilesRequestHeaders(
        tileset.tilesetUrl,
        tileset.requestHeaders,
      ),
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
  threeDTilesRuntimeEnvUnsubscribe?.();
  threeDTilesRuntimeEnvUnsubscribe = null;
  threeDTilesPanelPinned = false;
  threeDTilesControlMounted = false;
  threeDTilesControl = null;
  activeThreeDTilesApp = null;
  // Clear the suspension counter so a control torn down mid-hydration cannot
  // leave its successor permanently suppressing store sync events.
  threeDTilesStoreSyncSuspended = 0;
}

function isThreeDTilesControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "3d-tiles" &&
    layer.metadata.sourceKind === "3d-tiles-url" &&
    layer.metadata.externalNativeLayer === true &&
    !isGooglePhotorealisticTilesetLayerUrl(layer)
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
    if (control) {
      installGooglePhotorealisticTilesPanelHandlers(control, panel);
      updateGooglePhotorealisticTilesPanelList(control);
    }
  }
  installThreeDTilesToggleHandler(control);
}

function addThreeDTilesRuntimeEnvListener(control: ThreeDTilesControl): void {
  if (threeDTilesRuntimeEnvUnsubscribe || typeof window === "undefined") return;

  const handleRuntimeEnvChange = () => {
    applyGooglePhotorealisticTilesPanelDefaults(control);
    renderGooglePhotorealisticTilesLayers();
  };

  window.addEventListener(
    "geolibre:runtime-env-change",
    handleRuntimeEnvChange,
  );
  threeDTilesRuntimeEnvUnsubscribe = () => {
    window.removeEventListener(
      "geolibre:runtime-env-change",
      handleRuntimeEnvChange,
    );
  };
}

function installGooglePhotorealisticTilesPanelHandlers(
  control: ThreeDTilesControl,
  panel: HTMLElement,
): void {
  if (panel.dataset.geolibreGoogleTilesHandler === "true") return;
  panel.dataset.geolibreGoogleTilesHandler = "true";

  const applyDefaults = () =>
    applyGooglePhotorealisticTilesPanelDefaults(control);
  const deferApplyDefaults = () => window.setTimeout(applyDefaults, 0);
  const urlInput = getThreeDTilesUrlInput(panel);
  urlInput?.addEventListener("input", applyDefaults);
  urlInput?.addEventListener("change", applyDefaults);
  panel
    .querySelector<HTMLFormElement>(".three-d-tiles-form")
    ?.addEventListener(
      "submit",
      (event) => {
        applyDefaults();
        if (!isGooglePhotorealisticTilesetUrl(urlInput?.value ?? "")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void addGooglePhotorealisticTilesFromPanel(control, panel);
      },
      { capture: true },
    );
  panel.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const option = target.closest<HTMLButtonElement>(
      ".three-d-tiles-sample-option",
    );
    if (option?.title === GOOGLE_PHOTOREALISTIC_TILES_URL) {
      deferApplyDefaults();
    }
  });

  applyDefaults();
}

function applyGooglePhotorealisticTilesPanelDefaults(
  control: ThreeDTilesControl,
): void {
  const panel = getThreeDTilesPanel(control);
  if (!panel) return;

  const urlInput = getThreeDTilesUrlInput(panel);
  if (!urlInput || !isGooglePhotorealisticTilesetUrl(urlInput.value)) {
    setGooglePhotorealisticHeadersToggleVisible(panel, false);
    return;
  }

  const layerNameInput = panel.querySelector<HTMLInputElement>(
    'input[aria-label="Layer name"]',
  );
  if (
    layerNameInput &&
    (!layerNameInput.value.trim() ||
      layerNameInput.value.trim() === "3D Tiles" ||
      layerNameInput.value.trim() ===
        layerNameFromUrl(GOOGLE_PHOTOREALISTIC_TILES_URL, "3D Tiles"))
  ) {
    layerNameInput.value = GOOGLE_PHOTOREALISTIC_TILES_LABEL;
  }

  const altitudeInput = panel.querySelector<HTMLInputElement>(
    'input[aria-label="Altitude offset"]',
  );
  if (
    altitudeInput &&
    (!altitudeInput.value.trim() || Number(altitudeInput.value) === -300)
  ) {
    altitudeInput.value = "0";
  }

  const headersInput = panel.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Request headers"]',
  );
  if (!headersInput) return;

  const headers = resolveThreeDTilesRequestHeaders(
    GOOGLE_PHOTOREALISTIC_TILES_URL,
    parseThreeDTilesRequestHeaders(headersInput.value),
  );
  installGooglePhotorealisticHeadersToggle(panel, headersInput);
  headersInput.value = serializeGooglePhotorealisticPanelRequestHeaders(
    headers,
    panel.dataset.geolibreGoogleMapsApiKeyVisible === "true",
  );
  setGooglePhotorealisticHeadersToggleVisible(
    panel,
    Boolean(headers?.[GOOGLE_MAPS_API_KEY_HEADER]),
  );
}

function getThreeDTilesUrlInput(panel: HTMLElement): HTMLInputElement | null {
  return panel.querySelector<HTMLInputElement>('input[aria-label="Tileset URL"]');
}

function installGooglePhotorealisticHeadersToggle(
  panel: HTMLElement,
  headersInput: HTMLTextAreaElement,
): void {
  if (panel.querySelector(".geolibre-google-tiles-key-toggle")) return;

  panel.dataset.geolibreGoogleMapsApiKeyVisible = "false";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className =
    "geolibre-google-tiles-key-toggle three-d-tiles-small-button";
  toggle.textContent = "Show key";
  toggle.setAttribute("aria-label", "Show Google Maps API key");
  toggle.setAttribute("aria-pressed", "false");
  toggle.hidden = true;

  toggle.addEventListener("click", () => {
    const visible =
      panel.dataset.geolibreGoogleMapsApiKeyVisible !== "true";
    panel.dataset.geolibreGoogleMapsApiKeyVisible = visible
      ? "true"
      : "false";
    updateGooglePhotorealisticHeadersToggle(toggle, visible);

    const headers = resolveThreeDTilesRequestHeaders(
      GOOGLE_PHOTOREALISTIC_TILES_URL,
      parseThreeDTilesRequestHeaders(headersInput.value),
    );
    headersInput.value = serializeGooglePhotorealisticPanelRequestHeaders(
      headers,
      visible,
    );
  });

  headersInput.insertAdjacentElement("afterend", toggle);
}

function setGooglePhotorealisticHeadersToggleVisible(
  panel: HTMLElement,
  visible: boolean,
): void {
  const toggle = panel.querySelector<HTMLButtonElement>(
    ".geolibre-google-tiles-key-toggle",
  );
  if (toggle) toggle.hidden = !visible;
}

function updateGooglePhotorealisticHeadersToggle(
  toggle: HTMLButtonElement,
  visible: boolean,
): void {
  toggle.textContent = visible ? "Hide key" : "Show key";
  toggle.setAttribute(
    "aria-label",
    visible ? "Hide Google Maps API key" : "Show Google Maps API key",
  );
  toggle.setAttribute("aria-pressed", visible ? "true" : "false");
}

async function addGooglePhotorealisticTilesFromPanel(
  control: ThreeDTilesControl,
  panel: HTMLElement,
): Promise<void> {
  const app = activeThreeDTilesApp;
  if (!app) return;

  const name =
    panel
      .querySelector<HTMLInputElement>('input[aria-label="Layer name"]')
      ?.value.trim() || GOOGLE_PHOTOREALISTIC_TILES_LABEL;
  const headers = resolveThreeDTilesRequestHeaders(
    GOOGLE_PHOTOREALISTIC_TILES_URL,
    parseThreeDTilesRequestHeaders(
      panel.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Request headers"]',
      )?.value ?? "",
    ),
  );
  const flyToOnLoad =
    panel.querySelector<HTMLInputElement>(
      'input[aria-label="Fly to tileset after load"]',
    )?.checked ?? true;
  const visible =
    panel.querySelector<HTMLInputElement>('input[aria-label="Visible on load"]')
      ?.checked ?? true;
  const opacity = numberValue(control.getState().opacity, 1);

  addGooglePhotorealisticTilesLayer(app, {
    name,
    opacity,
    visible,
    requestHeaders: headers,
    flyTo: flyToOnLoad,
  });
  control.collapse();
  updateGooglePhotorealisticTilesPanelList(control);
}

function restoreGooglePhotorealisticTilesLayers(app: GeoLibreAppAPI): void {
  if (
    useAppStore.getState().layers.some(isGooglePhotorealisticTilesLayer)
  ) {
    void ensureGooglePhotorealisticTilesOverlay(app);
  }
}

function addGooglePhotorealisticTilesLayer(
  app: GeoLibreAppAPI,
  options: {
    name: string;
    opacity: number;
    visible: boolean;
    requestHeaders?: Record<string, string>;
    flyTo: boolean;
  },
): string {
  const id = `${GOOGLE_PHOTOREALISTIC_LAYER_ID_PREFIX}-${crypto.randomUUID()}`;
  const deckLayerId = `${id}-deck`;

  useAppStore.getState().addLayer({
    id,
    name: options.name,
    type: "3d-tiles",
    source: {
      sourceId: id,
      type: GOOGLE_PHOTOREALISTIC_SOURCE_KIND,
      url: GOOGLE_PHOTOREALISTIC_TILES_URL,
      // Keep non-Google custom headers, but never persist the API key header.
      requestHeaders: persistedThreeDTilesRequestHeaders(
        GOOGLE_PHOTOREALISTIC_TILES_URL,
        options.requestHeaders,
      ),
    },
    visible: options.visible,
    opacity: options.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: GOOGLE_PHOTOREALISTIC_SOURCE_KIND,
      externalDeckLayer: true,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [deckLayerId],
      sourceId: id,
      sourceKind: GOOGLE_PHOTOREALISTIC_SOURCE_KIND,
      bounds: [-180, -85, 180, 85],
    },
    sourcePath: GOOGLE_PHOTOREALISTIC_TILES_URL,
  });

  void ensureGooglePhotorealisticTilesOverlay(app);
  if (options.flyTo) flyToGooglePhotorealisticTiles(app);
  return id;
}

function updateGooglePhotorealisticTilesPanelList(
  control: ThreeDTilesControl | null,
): void {
  const panel = getThreeDTilesPanel(control);
  if (!panel) return;

  const nativeTilesetCount = control?.getState().tilesets.length ?? 0;
  const googleLayers = useAppStore
    .getState()
    .layers.filter(isGooglePhotorealisticTilesLayer);
  const nativeStatus = panel.querySelector<HTMLElement>(
    ".three-d-tiles-status",
  );
  if (nativeStatus) {
    nativeStatus.hidden =
      nativeTilesetCount === 0 && googleLayers.length > 0;
  }

  const googleList = ensureGooglePhotorealisticTilesPanelList(panel);
  googleList.replaceChildren();
  googleList.hidden = googleLayers.length === 0;
  if (googleLayers.length === 0) return;

  for (const layer of googleLayers) {
    googleList.appendChild(createGooglePhotorealisticTilesPanelListItem(layer));
  }
}

function ensureGooglePhotorealisticTilesPanelList(
  panel: HTMLElement,
): HTMLElement {
  const existing = panel.querySelector<HTMLElement>(
    ".geolibre-google-tiles-list",
  );
  if (existing) return existing;

  const googleList = document.createElement("div");
  googleList.className = "geolibre-google-tiles-list three-d-tiles-list";
  googleList.hidden = true;

  const nativeList = panel.querySelector<HTMLElement>(".three-d-tiles-list");
  if (nativeList) {
    nativeList.insertAdjacentElement("afterend", googleList);
  } else {
    panel.appendChild(googleList);
  }

  return googleList;
}

function createGooglePhotorealisticTilesPanelListItem(
  layer: GeoLibreLayer,
): HTMLElement {
  const item = document.createElement("div");
  item.className =
    "geolibre-google-tiles-list-item three-d-tiles-list-item active";

  const meta = document.createElement("div");
  meta.className = "three-d-tiles-list-meta";

  const title = document.createElement("button");
  title.className = "three-d-tiles-list-title";
  title.type = "button";
  title.textContent = layer.name || GOOGLE_PHOTOREALISTIC_TILES_LABEL;
  title.addEventListener("click", () => {
    if (googleTilesApp) flyToGooglePhotorealisticTiles(googleTilesApp);
  });

  const url = document.createElement("span");
  url.className = "three-d-tiles-list-url";
  url.textContent = GOOGLE_PHOTOREALISTIC_TILES_URL;

  const status = document.createElement("span");
  status.className = "three-d-tiles-list-status";
  status.dataset.status = "loaded";
  status.textContent = "loaded";

  meta.appendChild(title);
  meta.appendChild(url);
  meta.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "three-d-tiles-list-actions";

  const visible = document.createElement("input");
  visible.type = "checkbox";
  visible.checked = layer.visible;
  visible.setAttribute(
    "aria-label",
    `Toggle ${layer.name || GOOGLE_PHOTOREALISTIC_TILES_LABEL}`,
  );
  visible.addEventListener("change", () => {
    useAppStore.getState().updateLayer(layer.id, { visible: visible.checked });
  });

  const opacity = document.createElement("input");
  opacity.className = "three-d-tiles-opacity";
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "1";
  opacity.step = "0.05";
  opacity.value = String(layer.opacity);
  opacity.setAttribute(
    "aria-label",
    `Opacity for ${layer.name || GOOGLE_PHOTOREALISTIC_TILES_LABEL}`,
  );
  opacity.addEventListener("input", () => {
    const nextOpacity = Number(opacity.value);
    if (Number.isFinite(nextOpacity)) {
      useAppStore.getState().updateLayer(layer.id, { opacity: nextOpacity });
    }
  });

  const flyTo = createGooglePhotorealisticTilesPanelSmallButton("Fly");
  flyTo.addEventListener("click", () => {
    if (googleTilesApp) flyToGooglePhotorealisticTiles(googleTilesApp);
  });

  const remove = createGooglePhotorealisticTilesPanelSmallButton("Remove");
  remove.addEventListener("click", () => {
    useAppStore.getState().removeLayer(layer.id);
  });

  actions.appendChild(visible);
  actions.appendChild(opacity);
  actions.appendChild(flyTo);
  actions.appendChild(remove);

  item.appendChild(meta);
  item.appendChild(actions);
  return item;
}

function createGooglePhotorealisticTilesPanelSmallButton(
  label: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "three-d-tiles-small-button";
  button.type = "button";
  button.textContent = label;
  return button;
}

function flyToGooglePhotorealisticTiles(app: GeoLibreAppAPI): void {
  const map = app.getMap?.();
  if (!map) return;
  ensureMercatorProjection(map);
  map.flyTo({
    ...GOOGLE_PHOTOREALISTIC_INITIAL_VIEW,
    essential: true,
  });
}

function isGooglePhotorealisticTilesLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "3d-tiles" &&
    (layer.metadata.sourceKind === GOOGLE_PHOTOREALISTIC_SOURCE_KIND ||
      isGooglePhotorealisticTilesetLayerUrl(layer))
  );
}

function ensureGooglePhotorealisticTilesOverlay(
  app: GeoLibreAppAPI,
): Promise<void> {
  if (ensureGoogleTilesOverlayInFlight) return ensureGoogleTilesOverlayInFlight;
  ensureGoogleTilesOverlayInFlight = runEnsureGooglePhotorealisticTilesOverlay(
    app,
  ).finally(() => {
    ensureGoogleTilesOverlayInFlight = null;
  });
  return ensureGoogleTilesOverlayInFlight;
}

async function runEnsureGooglePhotorealisticTilesOverlay(
  app: GeoLibreAppAPI,
): Promise<void> {
  googleTilesApp = app;
  if (!app.getDeckGL) return;
  googleTilesDeckGL ??= await app.getDeckGL();

  const map = app.getMap?.() ?? null;
  if (googleTilesOverlay && googleTilesBoundMap === map) {
    renderGooglePhotorealisticTilesLayers();
    return;
  }

  if (googleTilesOverlay && googleTilesOverlayMounted) {
    app.removeMapControl(googleTilesOverlay);
  }
  googleTilesBoundMap = map;
  googleTilesOverlay = new googleTilesDeckGL.mapbox.MapboxOverlay({
    interleaved: false,
    layers: [],
  });
  googleTilesOverlayMounted = false;
  googleTilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) {
      renderGooglePhotorealisticTilesLayers();
    }
  });
  renderGooglePhotorealisticTilesLayers();
}

function renderGooglePhotorealisticTilesLayers(): void {
  if (!googleTilesOverlay || !googleTilesDeckGL || !googleTilesApp) return;

  const layers = useAppStore
    .getState()
    .layers.filter(isGooglePhotorealisticTilesLayer);
  if (layers.length > 0) {
    ensureMercatorProjection(googleTilesApp.getMap?.());
  }

  if (!googleTilesOverlayMounted) {
    if (layers.length === 0) return;
    if (!googleTilesApp.addMapControl(googleTilesOverlay, "top-left")) return;
    googleTilesOverlayMounted = true;
  }

  const deckLayers = layers
    .filter((layer) => layer.visible)
    .map((layer) => buildGooglePhotorealisticTilesDeckLayer(layer))
    .filter((layer): layer is Layer => layer !== null)
    .reverse();

  googleTilesOverlay.setProps({ layers: deckLayers });
}

function buildGooglePhotorealisticTilesDeckLayer(
  layer: GeoLibreLayer,
): Layer | null {
  if (!googleTilesDeckGL) return null;
  const requestHeaders = resolveThreeDTilesRequestHeaders(
    GOOGLE_PHOTOREALISTIC_TILES_URL,
    stringRecordValue(layer.source.requestHeaders),
  );

  return new googleTilesDeckGL.geoLayers.Tile3DLayer({
    id: googlePhotorealisticTilesDeckLayerId(layer),
    data: GOOGLE_PHOTOREALISTIC_TILES_URL,
    loadOptions: {
      fetch: requestHeaders ? { headers: requestHeaders } : undefined,
      tileset: {
        maximumScreenSpaceError: 20,
        maximumMemoryUsage: 512,
        memoryAdjustedScreenSpaceError: true,
      },
    },
    opacity: layer.opacity,
    pickable: false,
    operation: "terrain+draw",
  }) as Layer;
}

function googlePhotorealisticTilesDeckLayerId(layer: GeoLibreLayer): string {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  if (Array.isArray(nativeLayerIds)) {
    const deckLayerId = nativeLayerIds.find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    if (deckLayerId) return deckLayerId;
  }
  return `${layer.id}-deck`;
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

function stringRecordValue(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  // Keep only valid string-valued headers with a non-empty name (an empty
  // header name is invalid per RFC 7230); drop malformed entries from a
  // hand-edited project file rather than discarding the whole set.
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      entry[0].trim() !== "" && typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveThreeDTilesRequestHeaders(
  url: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!isGooglePhotorealisticTilesetUrl(url)) return headers;

  const nonGoogleHeaders = stripGoogleMapsApiKeyHeader(headers);
  const apiKey = getGoogleMapsApiKey();
  if (!apiKey) return nonEmptyRecord(nonGoogleHeaders);
  return {
    ...(nonGoogleHeaders ?? {}),
    [GOOGLE_MAPS_API_KEY_HEADER]: apiKey,
  };
}

function persistedThreeDTilesRequestHeaders(
  url: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!isGooglePhotorealisticTilesetUrl(url)) return headers;
  return nonEmptyRecord(stripGoogleMapsApiKeyHeader(headers));
}

function stripGoogleMapsApiKeyHeader(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() !== GOOGLE_MAPS_API_KEY_HEADER.toLowerCase(),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isGooglePhotorealisticTilesetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "tile.googleapis.com" &&
      parsed.pathname === "/v1/3dtiles/root.json"
    );
  } catch {
    return false;
  }
}

function isGooglePhotorealisticTilesetLayerUrl(layer: GeoLibreLayer): boolean {
  const url = stringValue(layer.source.url) ?? layer.sourcePath;
  return url ? isGooglePhotorealisticTilesetUrl(url) : false;
}

function parseThreeDTilesRequestHeaders(
  text: string,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    if (!name) continue;
    headers[name] = line.slice(separator + 1).trim();
  }
  return nonEmptyRecord(headers);
}

function serializeThreeDTilesRequestHeaders(
  headers: Record<string, string> | undefined,
): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function serializeGooglePhotorealisticPanelRequestHeaders(
  headers: Record<string, string> | undefined,
  showApiKey: boolean,
): string {
  if (!headers) return "";
  if (showApiKey) return serializeThreeDTilesRequestHeaders(headers);

  return serializeThreeDTilesRequestHeaders(
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        name.toLowerCase() === GOOGLE_MAPS_API_KEY_HEADER.toLowerCase()
          ? GOOGLE_MAPS_API_KEY_MASK
          : value,
      ]),
    ),
  );
}

function nonEmptyRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
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
