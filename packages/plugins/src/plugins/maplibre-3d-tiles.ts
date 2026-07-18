import {
  DEFAULT_LAYER_STYLE,
  GOOGLE_MAPS_API_KEY_HEADER,
  googleMapsApiKeyHeaderValue,
  isGooglePhotorealisticTilesetUrl,
  nonEmptyRecord,
  persistedThreeDTilesRequestHeaders,
  resolveThreeDTilesRequestHeaders,
  stripGoogleMapsApiKeyHeader,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import {
  DEFAULT_TILESET_URL,
  ThreeDTilesControl,
  ThreeDTilesLayer,
  type LoadedTilesetMetadata,
  type ThreeDTilesControlEventHandler,
  type ThreeDTilesControlOptions,
  type ThreeDTilesItemState,
} from "maplibre-gl-3d-tiles";
import type { GeoLibreAppAPI, GeoLibreDeckGL, GeoLibreMapControlPosition } from "../types";
import {
  acquireMercatorProjectionLock,
  releaseMercatorProjectionLock,
} from "./map-projection-utils";
import { ensureSharedDeckOverlay, setSharedDeckLayers } from "./shared-deck-overlay";
import {
  addArcgisI3sTilesLayer,
  arcgisI3sSceneLayerName,
  isArcgisI3sSceneLayerUrl,
  restoreArcgisI3sTilesLayers,
  THREE_D_TILES_DECK_LOAD_OPTIONS,
} from "./arcgis-i3s-tiles";

const threeDTilesControlPosition: GeoLibreMapControlPosition = "top-left";
const THREE_D_TILES_LAYER_ID = "geolibre-3d-tiles";
// Keep in sync with the three.js version maplibre-gl-3d-tiles is built
// against. Only used as a fallback when the control does not expose its own
// decoder paths (see getThreeDTilesDecoderOptions).
const THREE_VERSION = "0.184.0";
const DEFAULT_DRACO_DECODER_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/draco/`;
const DEFAULT_KTX2_TRANSCODER_PATH = `https://unpkg.com/three@${THREE_VERSION}/examples/jsm/libs/basis/`;
const GOOGLE_PHOTOREALISTIC_TILES_URL = "https://tile.googleapis.com/v1/3dtiles/root.json";
const GOOGLE_PHOTOREALISTIC_TILES_LABEL = "Google Photorealistic 3D Tiles";
const ARCGIS_I3S_SAMPLE_TILES_URL =
  "https://tiles.arcgis.com/tiles/z2tnIkrLQ2BRzr6P/arcgis/rest/services/SanFrancisco_Bldgs/SceneServer/layers/0";
const ARCGIS_I3S_SAMPLE_TILES_LABEL = "San Francisco Buildings (ArcGIS I3S)";
const GOOGLE_MAPS_API_KEY_MASK = "********";
const GOOGLE_PHOTOREALISTIC_SOURCE_KIND = "google-photorealistic-3d-tiles";
const GOOGLE_PHOTOREALISTIC_LAYER_ID_PREFIX = "geolibre-google-photorealistic-3d-tiles";
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
    {
      label: ARCGIS_I3S_SAMPLE_TILES_LABEL,
      url: ARCGIS_I3S_SAMPLE_TILES_URL,
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

// The Google tiles render through the shared interleaved deck overlay
// (./shared-deck-overlay.ts) under the "google-3d-tiles" source, so they coexist
// with the deckgl-viz overlay and the COG raster overlay instead of clobbering
// deck.gl's per-map Deck (see #1149). This module only builds the layer list;
// the shared overlay owns the MapboxOverlay and its map binding.
let googleTilesStoreUnsubscribe: (() => void) | null = null;
let googleTilesDeckGL: GeoLibreDeckGL | null = null;
let googleTilesApp: GeoLibreAppAPI | null = null;
let ensureGoogleTilesOverlayInFlight: Promise<void> | null = null;
/** Ref-counted mercator lock key for this overlay (see map-projection-utils). */
const GOOGLE_PROJECTION_LOCK_KEY = "google-photorealistic";
let googleAltitudeOffsetTile3DLayerClass: DeckTile3DLayerClass | null = null;
// Runtime-env listener owned by the Google overlay lifecycle, so a project with
// only Google layers (which never creates the native ThreeDTilesControl) still
// picks up an API-key change without reopening the project.
let googleTilesRuntimeEnvUnsubscribe: (() => void) | null = null;
// The last rendered Google-layer signature, used to skip rebuilding deck layers
// when an unrelated layer mutation fires the store subscription. Non-null means
// Google layers are currently contributed to the shared overlay.
let lastGoogleTilesLayerSignature: string | null = null;
const googleTilesApiKeysByLayerId = new Map<string, string>();
const googleTilesApiKeysByPanel = new WeakMap<HTMLElement, string>();

type ThreeDTilesLayerInstance = InstanceType<typeof ThreeDTilesLayer>;

// Structural shape of the deck.gl Tile3DLayer instances we subclass. It is
// intentionally NOT `Layer & …`: the abstract `Layer` base declares abstract
// members (e.g. initializeState) that a class expression extending this
// constructor would otherwise be required to implement, even though the real
// runtime base (deck.gl's Tile3DLayer) already provides them.
type RenderableDeckLayer = {
  props: Record<string, unknown>;
  renderLayers(): unknown;
};
type DeckTile3DLayerClass = new (props: Record<string, unknown>) => RenderableDeckLayer;

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
  restoreArcgisI3sTilesLayers(app);

  const layers = useAppStore.getState().layers.filter(isThreeDTilesControlLayer);
  if (layers.length === 0) return;

  const control = runWithThreeDTilesStoreSyncSuspended(() => ensureThreeDTilesControl(app));
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

function ensureThreeDTilesControl(app: GeoLibreAppAPI): ThreeDTilesControl | null {
  activeThreeDTilesApp = app;
  threeDTilesControl ??= createThreeDTilesControl();

  if (!threeDTilesControlMounted) {
    const added = app.addMapControl(threeDTilesControl, threeDTilesControlPosition);
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
  const layersById = new Map(useAppStore.getState().layers.map((layer) => [layer.id, layer]));
  for (const tileset of state.tilesets) {
    const existingLayer = layersById.get(tileset.id);
    const layer = createThreeDTilesStoreLayer(tileset, tileset.opacity, state.collapsed);

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
  const layers = useAppStore.getState().layers.filter(isThreeDTilesControlLayer);
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
  const existingTilesets = control.getState().tilesets.filter((tileset) => tileset.id !== id);
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
    tilesets.find((tileset) => tileset.id === state.activeTilesetId) ?? tilesets.at(-1);

  control.setState({
    altitude: activeTileset?.altitude,
    center: activeTileset?.center,
    error: activeTileset?.error,
    status: activeTileset?.status ?? "idle",
    tilesets,
  });
}

function updateThreeDTilesError(control: ThreeDTilesControl, id: string, error: Error): void {
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
    tilesets.find((tileset) => tileset.id === state.activeTilesetId) ?? tilesets.at(-1);

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

function hasThreeDTilesTileset(control: ThreeDTilesControl, id: string): boolean {
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

function installThreeDTilesPanelHandlers(control: ThreeDTilesControl | null): void {
  const panel = getThreeDTilesPanel(control);
  if (panel) {
    panel.classList.add("geolibre-3d-tiles-panel");
    installThreeDTilesCloseHandler(control, panel);
    if (control) {
      installGooglePhotorealisticTilesPanelHandlers(control, panel);
      updateGooglePhotorealisticTilesPanelList(control);
      installArcgisI3sTilesPanelHandlers(control, panel);
    }
  }
  installThreeDTilesToggleHandler(control);
}

function addThreeDTilesRuntimeEnvListener(control: ThreeDTilesControl): void {
  if (threeDTilesRuntimeEnvUnsubscribe || typeof window === "undefined") return;

  const handleRuntimeEnvChange = () => {
    applyGooglePhotorealisticTilesPanelDefaults(control);
    // The resolved API key may have changed, but the persisted layer records
    // (which never carry the key) have not, so the render signature would be
    // unchanged. Force a rebuild so the new key reaches the deck.gl layer.
    lastGoogleTilesLayerSignature = null;
    renderGooglePhotorealisticTilesLayers();
  };

  window.addEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  threeDTilesRuntimeEnvUnsubscribe = () => {
    window.removeEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  };
}

function installGooglePhotorealisticTilesPanelHandlers(
  control: ThreeDTilesControl,
  panel: HTMLElement,
): void {
  if (panel.dataset.geolibreGoogleTilesHandler === "true") return;
  panel.dataset.geolibreGoogleTilesHandler = "true";

  const applyDefaults = () => applyGooglePhotorealisticTilesPanelDefaults(control);
  const deferApplyDefaults = () => window.setTimeout(applyDefaults, 0);
  const urlInput = getThreeDTilesUrlInput(panel);
  urlInput?.addEventListener("input", applyDefaults);
  urlInput?.addEventListener("change", applyDefaults);
  // Intercept the submit on the panel (an ancestor of the form) during the
  // capture phase so this runs before maplibre-gl-3d-tiles' own form-level
  // submit listener. A capture listener on the form target itself would not:
  // per the DOM spec, listeners on the same target fire in registration order
  // regardless of the capture flag, and the library registers its submit
  // listener first (at panel construction, before this lazy install). Capturing
  // on the ancestor also covers both Load-button clicks and Enter submission.
  panel.addEventListener(
    "submit",
    (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.classList.contains("three-d-tiles-form")
      ) {
        return;
      }
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
    const option = target.closest<HTMLButtonElement>(".three-d-tiles-sample-option");
    if (option?.title === GOOGLE_PHOTOREALISTIC_TILES_URL) {
      deferApplyDefaults();
    }
  });

  applyDefaults();
}

function applyGooglePhotorealisticTilesPanelDefaults(control: ThreeDTilesControl): void {
  const panel = getThreeDTilesPanel(control);
  if (!panel) return;

  const urlInput = getThreeDTilesUrlInput(panel);
  if (!urlInput || !isGooglePhotorealisticTilesetUrl(urlInput.value)) {
    // Switched away from the Google tileset: drop the masked X-GOOG-API-KEY the
    // Google flow injected so the native 3D Tiles submit path does not send or
    // persist a bogus custom header (which would cause avoidable CORS/preflight
    // failures on the non-Google source).
    const headersInput = panel.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Request headers"]',
    );
    if (headersInput) {
      headersInput.value = serializeThreeDTilesRequestHeaders(
        stripGoogleMapsApiKeyHeader(parseThreeDTilesRequestHeaders(headersInput.value)),
      );
      headersInput.placeholder = "";
    }
    googleTilesApiKeysByPanel.delete(panel);
    panel.dataset.geolibreGoogleMapsApiKeyVisible = "false";
    // Re-arm the one-shot altitude default so it applies again if the user
    // returns to a Google URL.
    delete panel.dataset.geolibreGoogleAltitudeApplied;
    setGooglePhotorealisticHeadersToggleVisible(panel, false);
    return;
  }

  const layerNameInput = panel.querySelector<HTMLInputElement>('input[aria-label="Layer name"]');
  if (
    layerNameInput &&
    (!layerNameInput.value.trim() ||
      layerNameInput.value.trim() === "3D Tiles" ||
      layerNameInput.value.trim() === layerNameFromUrl(GOOGLE_PHOTOREALISTIC_TILES_URL, "3D Tiles"))
  ) {
    layerNameInput.value = GOOGLE_PHOTOREALISTIC_TILES_LABEL;
  }

  const altitudeInput = panel.querySelector<HTMLInputElement>(
    'input[aria-label="Altitude offset"]',
  );
  // Google photorealistic tiles are anchored to the WGS84 ellipsoid, so the
  // native control's -300 default offset is wrong for them. Apply a 0 default
  // once, the first time the URL becomes a Google tileset, then leave the field
  // alone. This defaults pass runs on every URL input/change, so overwriting
  // unconditionally would silently reset a value the user deliberately typed
  // (including -300, which is indistinguishable from the native default).
  if (
    altitudeInput &&
    panel.dataset.geolibreGoogleAltitudeApplied !== "true" &&
    (!altitudeInput.value.trim() || Number(altitudeInput.value) === -300)
  ) {
    altitudeInput.value = "0";
    panel.dataset.geolibreGoogleAltitudeApplied = "true";
  }

  const headersInput = panel.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Request headers"]',
  );
  if (!headersInput) return;

  headersInput.placeholder = `${GOOGLE_MAPS_API_KEY_HEADER}: <your Google Maps API key>`;
  const rawHeaders = parseThreeDTilesRequestHeaders(headersInput.value);
  const panelApiKey = rememberGoogleMapsApiKeyFromHeaders(panel, rawHeaders);
  const headers = resolveThreeDTilesRequestHeaders(
    GOOGLE_PHOTOREALISTIC_TILES_URL,
    rawHeaders,
    panelApiKey,
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
  toggle.className = "geolibre-google-tiles-key-toggle three-d-tiles-small-button";
  toggle.textContent = "Show key";
  toggle.setAttribute("aria-label", "Show Google Maps API key");
  toggle.setAttribute("aria-pressed", "false");
  toggle.hidden = true;

  toggle.addEventListener("click", () => {
    const visible = panel.dataset.geolibreGoogleMapsApiKeyVisible !== "true";
    panel.dataset.geolibreGoogleMapsApiKeyVisible = visible ? "true" : "false";
    updateGooglePhotorealisticHeadersToggle(toggle, visible);

    const rawHeaders = parseThreeDTilesRequestHeaders(headersInput.value);
    const panelApiKey = rememberGoogleMapsApiKeyFromHeaders(panel, rawHeaders);
    const headers = resolveThreeDTilesRequestHeaders(
      GOOGLE_PHOTOREALISTIC_TILES_URL,
      rawHeaders,
      panelApiKey,
    );
    headersInput.value = serializeGooglePhotorealisticPanelRequestHeaders(headers, visible);
  });

  headersInput.closest(".three-d-tiles-field")?.insertAdjacentElement("afterend", toggle) ??
    headersInput.insertAdjacentElement("afterend", toggle);
}

function setGooglePhotorealisticHeadersToggleVisible(panel: HTMLElement, visible: boolean): void {
  const toggle = panel.querySelector<HTMLButtonElement>(".geolibre-google-tiles-key-toggle");
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

  // The submitted URL is only used to detect that this is the Google tileset;
  // the layer always loads the canonical root URL and takes its key from the
  // env / X-GOOG-API-KEY header. Warn if the user embedded a `key=` query
  // parameter (as Google's docs often show), which is silently ignored here.
  const submittedUrl = getThreeDTilesUrlInput(panel)?.value.trim();
  if (submittedUrl && urlHasKeyQueryParam(submittedUrl)) {
    console.warn(
      "[GeoLibre] Ignoring the `key` query parameter in the Google Photorealistic 3D Tiles URL; the API key is taken from VITE_GOOGLE_MAPS_API_KEY (or the X-GOOG-API-KEY request header) instead.",
    );
  }

  const name =
    panel.querySelector<HTMLInputElement>('input[aria-label="Layer name"]')?.value.trim() ||
    GOOGLE_PHOTOREALISTIC_TILES_LABEL;
  const rawHeaders = parseThreeDTilesRequestHeaders(
    panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Request headers"]')?.value ?? "",
  );
  const manualGoogleMapsApiKey = rememberGoogleMapsApiKeyFromHeaders(panel, rawHeaders);
  const headers = resolveThreeDTilesRequestHeaders(
    GOOGLE_PHOTOREALISTIC_TILES_URL,
    rawHeaders,
    manualGoogleMapsApiKey,
  );
  const flyToOnLoad =
    panel.querySelector<HTMLInputElement>('input[aria-label="Fly to tileset after load"]')
      ?.checked ?? true;
  const visible =
    panel.querySelector<HTMLInputElement>('input[aria-label="Visible on load"]')?.checked ?? true;
  const opacity = numberValue(control.getState().opacity, 1);
  const altitudeOffset = numberInputValue(
    panel.querySelector<HTMLInputElement>('input[aria-label="Altitude offset"]')?.value,
    numberValue(control.getState().altitudeOffset, 0),
  );

  addGooglePhotorealisticTilesLayer(app, {
    name,
    altitudeOffset,
    opacity,
    visible,
    requestHeaders: headers,
    googleMapsApiKey: manualGoogleMapsApiKey,
    flyTo: flyToOnLoad,
    map: control.getMap(),
  });
  control.collapse();
  updateGooglePhotorealisticTilesPanelList(control);
}

/**
 * Intercept the 3D Tiles panel submit for ArcGIS I3S Scene Layer URLs and route
 * them to the deck.gl I3S overlay, since maplibre-gl-3d-tiles' three.js renderer
 * only handles OGC 3D Tiles. Mirrors the Google Photorealistic interception.
 */
function installArcgisI3sTilesPanelHandlers(control: ThreeDTilesControl, panel: HTMLElement): void {
  if (panel.dataset.geolibreI3sTilesHandler === "true") return;
  panel.dataset.geolibreI3sTilesHandler = "true";

  const urlInput = getThreeDTilesUrlInput(panel);
  // Capture on the panel (an ancestor of the form) so this runs before
  // maplibre-gl-3d-tiles' own submit listener — see the Google handler above.
  panel.addEventListener(
    "submit",
    (event) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.classList.contains("three-d-tiles-form")
      ) {
        return;
      }
      if (!isArcgisI3sSceneLayerUrl(urlInput?.value ?? "")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      addArcgisI3sTilesFromPanel(control, panel);
    },
    { capture: true },
  );
}

function addArcgisI3sTilesFromPanel(control: ThreeDTilesControl, panel: HTMLElement): void {
  const app = activeThreeDTilesApp;
  if (!app) {
    console.warn("[GeoLibre] ArcGIS I3S submit ignored: no active 3D Tiles app");
    return;
  }
  const url = getThreeDTilesUrlInput(panel)?.value.trim();
  if (!url) {
    console.warn("[GeoLibre] ArcGIS I3S submit ignored: empty URL");
    return;
  }

  const name =
    panel.querySelector<HTMLInputElement>('input[aria-label="Layer name"]')?.value.trim() ||
    arcgisI3sSceneLayerName(url) ||
    layerNameFromUrl(url, "ArcGIS I3S Scene Layer");
  const flyTo =
    panel.querySelector<HTMLInputElement>('input[aria-label="Fly to tileset after load"]')
      ?.checked ?? true;
  const visible =
    panel.querySelector<HTMLInputElement>('input[aria-label="Visible on load"]')?.checked ?? true;
  const opacity = numberValue(control.getState().opacity, 1);

  addArcgisI3sTilesLayer(app, { url, name, opacity, visible, flyTo });
  control.collapse();
}

function restoreGooglePhotorealisticTilesLayers(app: GeoLibreAppAPI): void {
  if (useAppStore.getState().layers.some(isGooglePhotorealisticTilesLayer)) {
    void ensureGooglePhotorealisticTilesOverlay(app);
  }
}

function addGooglePhotorealisticTilesLayer(
  app: GeoLibreAppAPI,
  options: {
    name: string;
    altitudeOffset: number;
    opacity: number;
    visible: boolean;
    requestHeaders?: Record<string, string>;
    googleMapsApiKey?: string;
    flyTo: boolean;
    map?: ReturnType<ThreeDTilesControl["getMap"]>;
  },
): string {
  const id = `${GOOGLE_PHOTOREALISTIC_LAYER_ID_PREFIX}-${crypto.randomUUID()}`;
  const deckLayerId = `${id}-deck`;
  if (options.googleMapsApiKey) {
    googleTilesApiKeysByLayerId.set(id, options.googleMapsApiKey);
  }

  useAppStore.getState().addLayer({
    id,
    name: options.name,
    type: "3d-tiles",
    source: {
      sourceId: id,
      type: GOOGLE_PHOTOREALISTIC_SOURCE_KIND,
      url: GOOGLE_PHOTOREALISTIC_TILES_URL,
      altitudeOffset: options.altitudeOffset,
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
      altitudeOffset: options.altitudeOffset,
    },
    sourcePath: GOOGLE_PHOTOREALISTIC_TILES_URL,
  });

  void ensureGooglePhotorealisticTilesOverlay(app);
  if (options.flyTo) flyToGooglePhotorealisticTiles(app, options.map);
  return id;
}

function updateGooglePhotorealisticTilesPanelList(control: ThreeDTilesControl | null): void {
  const panel = getThreeDTilesPanel(control);
  if (!panel) return;

  const nativeTilesetCount = control?.getState().tilesets.length ?? 0;
  const googleLayers = useAppStore.getState().layers.filter(isGooglePhotorealisticTilesLayer);
  const nativeStatus = panel.querySelector<HTMLElement>(".three-d-tiles-status");
  if (nativeStatus) {
    nativeStatus.hidden = nativeTilesetCount === 0 && googleLayers.length > 0;
  }

  const googleList = ensureGooglePhotorealisticTilesPanelList(panel);
  googleList.hidden = googleLayers.length === 0;

  // Only rebuild the DOM when the SET of Google layers changes. This runs on
  // every store mutation anywhere in the app, and an unconditional
  // replaceChildren() would detach and recreate the per-layer opacity <input>
  // mid-drag (dropping pointer capture and truncating the gesture). The slider
  // and visibility checkbox already reflect their own live state, and the map
  // is updated by renderGooglePhotorealisticTilesLayers, so skipping the
  // rebuild when the ids are unchanged is safe.
  const idSignature = googleLayers.map((layer) => layer.id).join("|");
  if (googleList.dataset.geolibreGoogleListIds === idSignature) return;
  googleList.dataset.geolibreGoogleListIds = idSignature;

  googleList.replaceChildren();
  if (googleLayers.length === 0) return;

  for (const layer of googleLayers) {
    googleList.appendChild(createGooglePhotorealisticTilesPanelListItem(layer));
  }
}

function ensureGooglePhotorealisticTilesPanelList(panel: HTMLElement): HTMLElement {
  const existing = panel.querySelector<HTMLElement>(".geolibre-google-tiles-list");
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

function createGooglePhotorealisticTilesPanelListItem(layer: GeoLibreLayer): HTMLElement {
  const item = document.createElement("div");
  item.className = "geolibre-google-tiles-list-item three-d-tiles-list-item active";

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
  visible.setAttribute("aria-label", `Toggle ${layer.name || GOOGLE_PHOTOREALISTIC_TILES_LABEL}`);
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

function createGooglePhotorealisticTilesPanelSmallButton(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "three-d-tiles-small-button";
  button.type = "button";
  button.textContent = label;
  return button;
}

function flyToGooglePhotorealisticTiles(
  app: GeoLibreAppAPI,
  mapOverride?: ReturnType<ThreeDTilesControl["getMap"]>,
): void {
  forceGooglePhotorealisticMercatorProjection(app, mapOverride);
  useAppStore.getState().setMapView(
    {
      ...GOOGLE_PHOTOREALISTIC_INITIAL_VIEW,
      bbox: undefined,
    },
    false,
  );
  const map = mapOverride ?? app.getMap?.();
  if (!map) {
    app.fitBounds?.([14.35, 50.05, 14.49, 50.12]);
    return;
  }
  map.flyTo({
    ...GOOGLE_PHOTOREALISTIC_INITIAL_VIEW,
    essential: true,
  });
}

function forceGooglePhotorealisticMercatorProjection(
  app: GeoLibreAppAPI,
  mapOverride?: ReturnType<ThreeDTilesControl["getMap"]>,
): void {
  acquireMercatorProjectionLock(GOOGLE_PROJECTION_LOCK_KEY, app, mapOverride ?? app.getMap?.());
}

function restoreGooglePhotorealisticPreviousProjection(): void {
  if (!googleTilesApp) return;
  releaseMercatorProjectionLock(GOOGLE_PROJECTION_LOCK_KEY, googleTilesApp);
}

function isGooglePhotorealisticTilesLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "3d-tiles" &&
    (layer.metadata.sourceKind === GOOGLE_PHOTOREALISTIC_SOURCE_KIND ||
      isGooglePhotorealisticTilesetLayerUrl(layer))
  );
}

function ensureGooglePhotorealisticTilesOverlay(app: GeoLibreAppAPI): Promise<void> {
  if (ensureGoogleTilesOverlayInFlight) return ensureGoogleTilesOverlayInFlight;
  ensureGoogleTilesOverlayInFlight = runEnsureGooglePhotorealisticTilesOverlay(app).finally(() => {
    ensureGoogleTilesOverlayInFlight = null;
  });
  return ensureGoogleTilesOverlayInFlight;
}

async function runEnsureGooglePhotorealisticTilesOverlay(app: GeoLibreAppAPI): Promise<void> {
  googleTilesApp = app;
  if (!app.getDeckGL) return;
  googleTilesDeckGL ??= await app.getDeckGL();

  // The shared overlay owns the single interleaved MapboxOverlay and its map
  // binding (including rebind on a globe/projection toggle); this module only
  // supplies the "google-3d-tiles" layer list. Clearing the signature forces the
  // next render to rebuild the layers into the (possibly fresh) shared overlay.
  await ensureSharedDeckOverlay(app);
  lastGoogleTilesLayerSignature = null;
  addGoogleTilesRuntimeEnvListener();
  googleTilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) {
      const currentGoogleLayerIds = new Set(
        state.layers.filter(isGooglePhotorealisticTilesLayer).map(({ id }) => id),
      );
      for (const layer of previous.layers) {
        if (isGooglePhotorealisticTilesLayer(layer) && !currentGoogleLayerIds.has(layer.id)) {
          googleTilesApiKeysByLayerId.delete(layer.id);
        }
      }
      renderGooglePhotorealisticTilesLayers();
    }
  });
  renderGooglePhotorealisticTilesLayers();
}

function addGoogleTilesRuntimeEnvListener(): void {
  if (googleTilesRuntimeEnvUnsubscribe || typeof window === "undefined") return;

  // A newly entered API key does not change any persisted layer record, so the
  // render signature would be unchanged; reset it to force a rebuild that
  // threads the new key into the deck.gl Tile3DLayer. Registered here (not only
  // in createThreeDTilesControl) so Google-only projects, which never open the
  // native 3D Tiles panel, still react to a key change.
  const handleRuntimeEnvChange = () => {
    lastGoogleTilesLayerSignature = null;
    renderGooglePhotorealisticTilesLayers();
  };
  window.addEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  googleTilesRuntimeEnvUnsubscribe = () => {
    window.removeEventListener("geolibre:runtime-env-change", handleRuntimeEnvChange);
  };
}

function renderGooglePhotorealisticTilesLayers(): void {
  if (!googleTilesDeckGL || !googleTilesApp) return;

  const layers = useAppStore.getState().layers.filter(isGooglePhotorealisticTilesLayer);

  // Drop our contribution and release the mercator lock once the last Google
  // tileset is gone. A non-null signature means we currently hold layers, so
  // this clears exactly once on the transition to empty (the store subscription
  // fires on ANY layer change).
  if (layers.length === 0) {
    if (lastGoogleTilesLayerSignature !== null) {
      setSharedDeckLayers("google-3d-tiles", []);
      lastGoogleTilesLayerSignature = null;
      restoreGooglePhotorealisticPreviousProjection();
    }
    return;
  }

  forceGooglePhotorealisticMercatorProjection(googleTilesApp);

  // The store subscription fires on ANY layer-set change, not just Google ones.
  // Rebuilding hands deck.gl new loadOptions/fetch object references each time,
  // which can trigger a needless tileset re-fetch, so skip when nothing about
  // the Google layers themselves changed.
  const signature = googleTilesLayerSignature(layers);
  if (signature === lastGoogleTilesLayerSignature) return;
  lastGoogleTilesLayerSignature = signature;

  const deckLayers = layers
    .filter((layer) => layer.visible)
    .map((layer) => buildGooglePhotorealisticTilesDeckLayer(layer))
    .filter((layer): layer is Layer => layer !== null)
    .reverse();

  setSharedDeckLayers("google-3d-tiles", deckLayers);
}

function googleTilesLayerSignature(layers: GeoLibreLayer[]): string {
  return layers
    .map((layer) => {
      const headers = stringRecordValue(layer.source.requestHeaders);
      const altitudeOffset = numberValue(layer.source.altitudeOffset, 0);
      // Sign both header names AND values: a changed custom header value must
      // produce a new signature so the Tile3DLayer rebuilds rather than reusing
      // stale request headers.
      const headerEntries = headers
        ? JSON.stringify(
            Object.entries(headers).sort(([left], [right]) => left.localeCompare(right)),
          )
        : "";
      return `${layer.id}:${layer.visible ? 1 : 0}:${layer.opacity}:${altitudeOffset}:${headerEntries}`;
    })
    .join("|");
}

function buildGooglePhotorealisticTilesDeckLayer(layer: GeoLibreLayer): Layer | null {
  if (!googleTilesDeckGL) return null;
  const altitudeOffset = numberValue(layer.source.altitudeOffset, 0);
  const requestHeaders = resolveThreeDTilesRequestHeaders(
    GOOGLE_PHOTOREALISTIC_TILES_URL,
    stringRecordValue(layer.source.requestHeaders),
    googleTilesApiKeysByLayerId.get(layer.id),
  );

  const Tile3DLayer = getGoogleAltitudeOffsetTile3DLayerClass();
  return new Tile3DLayer({
    id: googlePhotorealisticTilesDeckLayerId(layer),
    data: GOOGLE_PHOTOREALISTIC_TILES_URL,
    altitudeOffset,
    // Tileset caps + main-thread parsing shared with the I3S overlay (see
    // THREE_D_TILES_DECK_LOAD_OPTIONS for why workers are disabled), plus this
    // layer's per-request auth headers.
    loadOptions: {
      ...THREE_D_TILES_DECK_LOAD_OPTIONS,
      fetch: requestHeaders ? { headers: requestHeaders } : undefined,
    },
    opacity: layer.opacity,
    pickable: false,
    operation: "draw",
  }) as unknown as Layer;
}

function getGoogleAltitudeOffsetTile3DLayerClass(): DeckTile3DLayerClass {
  if (googleAltitudeOffsetTile3DLayerClass) {
    return googleAltitudeOffsetTile3DLayerClass;
  }
  if (!googleTilesDeckGL) {
    throw new Error("deck.gl modules are not loaded");
  }

  const BaseLayer = googleTilesDeckGL.geoLayers.Tile3DLayer as unknown as DeckTile3DLayerClass;
  googleAltitudeOffsetTile3DLayerClass = class extends BaseLayer {
    static componentName = "GoogleAltitudeOffsetTile3DLayer";

    renderLayers(): unknown {
      const altitudeOffset = numberValue(this.props.altitudeOffset, 0);
      return offsetGooglePhotorealisticTileLayers(super.renderLayers(), altitudeOffset);
    }
  };
  return googleAltitudeOffsetTile3DLayerClass;
}

function offsetGooglePhotorealisticTileLayers(layers: unknown, altitudeOffset: number): unknown {
  if (!Number.isFinite(altitudeOffset) || altitudeOffset === 0) {
    return layers;
  }
  if (Array.isArray(layers)) {
    return layers.map((layer) => offsetGooglePhotorealisticTileLayers(layer, altitudeOffset));
  }
  if (!isDeckLayerInstance(layers)) return layers;

  return layers.clone({
    modelMatrix: translatedModelMatrix(matrix16Value(layers.props.modelMatrix), altitudeOffset),
  });
}

function translatedModelMatrix(modelMatrix: number[] | null, altitudeOffset: number): number[] {
  const source = modelMatrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const translated = [...source];
  translated[12] = source[12] + source[8] * altitudeOffset;
  translated[13] = source[13] + source[9] * altitudeOffset;
  translated[14] = source[14] + source[10] * altitudeOffset;
  translated[15] = source[15] + source[11] * altitudeOffset;
  return translated;
}

function matrix16Value(value: unknown): number[] | null {
  if (!isArrayLike(value)) return null;
  const values = Array.from(value);
  if (values.length === 16 && values.every((entry): entry is number => typeof entry === "number")) {
    return values;
  }
  return null;
}

function isDeckLayerInstance(value: unknown): value is Layer & {
  props: Record<string, unknown>;
  clone(props: Record<string, unknown>): Layer;
} {
  return isRecord(value) && isRecord(value.props) && typeof value.clone === "function";
}

function googlePhotorealisticTilesDeckLayerId(layer: GeoLibreLayer): string {
  const nativeLayerIds = layer.metadata.nativeLayerIds;
  if (Array.isArray(nativeLayerIds)) {
    const deckLayerId = nativeLayerIds.find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (deckLayerId) return deckLayerId;
  }
  return `${layer.id}-deck`;
}

function getThreeDTilesPanel(control: ThreeDTilesControl | null): HTMLElement | null {
  return (
    control?.getMap()?.getContainer().querySelector<HTMLElement>(".three-d-tiles-control-panel") ??
    null
  );
}

function installThreeDTilesToggleHandler(control: ThreeDTilesControl | null): void {
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
  const closeButton = panel?.querySelector<HTMLButtonElement>(".three-d-tiles-control-close");
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

function setThreeDTilesOpacity(control: ThreeDTilesControl, id: string, opacity: number): void {
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
  const panelCollapsed = layers.find((layer) => typeof layer.metadata.panelCollapsed === "boolean")
    ?.metadata.panelCollapsed;
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
      (value): value is string => typeof value === "string" && value.trim().length > 0,
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
    ktx2TranscoderPath: options?.ktx2TranscoderPath ?? DEFAULT_KTX2_TRANSCODER_PATH,
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

function numberInputValue(value: unknown, fallback: number): number {
  // Number("") is 0 (finite), so guard the empty/whitespace case explicitly:
  // a blank field must fall back, not silently resolve to 0.
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  // Keep only valid string-valued headers with a non-empty name (an empty
  // header name is invalid per RFC 7230); drop malformed entries from a
  // hand-edited project file rather than discarding the whole set.
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => entry[0].trim() !== "" && typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function rememberGoogleMapsApiKeyFromHeaders(
  panel: HTMLElement,
  headers: Record<string, string> | undefined,
): string | undefined {
  const apiKey = googleMapsApiKeyHeaderValue(headers);
  if (apiKey) {
    googleTilesApiKeysByPanel.set(panel, apiKey);
    return apiKey;
  }
  return googleTilesApiKeysByPanel.get(panel);
}

function isGooglePhotorealisticTilesetLayerUrl(layer: GeoLibreLayer): boolean {
  const url = stringValue(layer.source.url) ?? layer.sourcePath;
  return url ? isGooglePhotorealisticTilesetUrl(url) : false;
}

function urlHasKeyQueryParam(url: string): boolean {
  try {
    return new URL(url).searchParams.has("key");
  } catch {
    return false;
  }
}

function parseThreeDTilesRequestHeaders(text: string): Record<string, string> | undefined {
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

function serializeThreeDTilesRequestHeaders(headers: Record<string, string> | undefined): string {
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

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
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

function isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "length" in value &&
    typeof value.length === "number"
  );
}

function layerNameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const fileName = segments.at(-1);
    const parentName = segments.at(-2);
    return parentName && fileName ? `${parentName}/${fileName}` : (fileName ?? parsed.hostname);
  } catch {
    return fallback;
  }
}
