import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  PluginControl,
  type PluginControlOptions,
  type VisualizeOptions,
} from "maplibre-gl-earth-engine";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import {
  authenticateEarthEngine,
  clearEarthEngineFunctionInfo,
  closeTauriOauthPopups,
  importMetaEnv,
  oauthClientIdValue,
  preloadEarthEngineAuthLibrary,
  projectValue,
  shouldUseTauriEarthEngineOAuth,
  type TauriEarthEngineOAuthToken,
} from "./earth-engine-auth";

const STORAGE_PREFIX = "geolibre.earthEngine";
const EARTH_ENGINE_CONTROL_POSITION: GeoLibreMapControlPosition = "top-left";
const EARTH_ENGINE_PANEL_CLASS = "geolibre-earth-engine-panel";

// These types mirror undocumented private members of PluginControl from
// maplibre-gl-earth-engine (verified against v0.4.0). All access is optional
// (?.) so a rename in a future release degrades to a no-op rather than a
// crash, but the store<->control layer sync would silently stop working --
// re-verify these names when bumping the dependency.
type EarthEngineControlInternals = {
  _authOAuthClientInput?: HTMLInputElement;
  _container?: HTMLElement;
  _layers?: EarthEngineLoadedLayer[];
  _oauthClientId?: string;
  _options?: PluginControlOptions;
  _panel?: HTMLElement;
};

type EarthEngineLoadedLayer = {
  id: string;
  sourceId: string;
  layerId: string;
  name: string;
  input: string | object;
  assetId?: string;
  opacity: number;
  visible: boolean;
  tileUrl: string;
};

type EarthEngineControlMethods = EarthEngineControlInternals & {
  _applyLayerOpacity?: (layer: EarthEngineLoadedLayer) => void;
  _applyLayerVisibility?: (layer: EarthEngineLoadedLayer) => void;
  _removeManagedLayer?: (layerId: string) => void;
  _renderLayersList?: () => void;
};

function earthEngineOptions(): Omit<PluginControlOptions, "position"> {
  return {
    className: "geolibre-earth-engine-control",
    collapsed: false,
    oauthClientId: oauthClientIdValue(importMetaEnv().VITE_GEE_OAUTH_CLIENT_ID),
    panelWidth: 420,
    // Evaluated when the control is first created (not at module load) so a
    // deep link or storage value present at open time is picked up.
    projectId: projectValue(importMetaEnv().VITE_GEE_PROJECT_ID, STORAGE_PREFIX),
    storagePrefix: STORAGE_PREFIX,
    title: "Earth Engine",
  };
}

let earthEngineControl: PluginControl | null = null;
let earthEngineControlMounted = false;
let earthEngineControlVisible = false;
let earthEngineStoreUnsubscribe: (() => void) | null = null;
let syncingEarthEngineControlToStore = false;
let syncingEarthEngineStoreToControl = false;
const earthEnginePanelListeners = new Set<() => void>();
const syncedEarthEngineControls = new WeakSet<PluginControl>();

export function openEarthEnginePanel(app: GeoLibreAppAPI): void {
  void openStandaloneEarthEngineControl(app);
}

export function toggleEarthEnginePanel(app: GeoLibreAppAPI): void {
  if (earthEngineControlVisible) {
    hideEarthEngineControl(earthEngineControl);
    return;
  }
  openEarthEnginePanel(app);
}

export function closeEarthEnginePanel(app: GeoLibreAppAPI): void {
  earthEngineStoreUnsubscribe?.();
  earthEngineStoreUnsubscribe = null;
  if (earthEngineControl && earthEngineControlMounted) {
    app.removeMapControl(earthEngineControl);
  }
  earthEngineControl = null;
  earthEngineControlMounted = false;
  setEarthEngineControlVisible(false);
}

export function isEarthEnginePanelVisible(): boolean {
  return earthEngineControlVisible;
}

export function subscribeEarthEnginePanel(listener: () => void): () => void {
  earthEnginePanelListeners.add(listener);
  return () => earthEnginePanelListeners.delete(listener);
}

async function openStandaloneEarthEngineControl(app: GeoLibreAppAPI): Promise<boolean> {
  earthEngineControl ??= new GeoLibreEarthEngineControl(earthEngineOptions());
  wireEarthEngineLayerSync(earthEngineControl);

  if (!earthEngineControlMounted) {
    const added = app.addMapControl(earthEngineControl, EARTH_ENGINE_CONTROL_POSITION);
    if (!added) {
      earthEngineControl = null;
      earthEngineControlMounted = false;
      setEarthEngineControlVisible(false);
      return false;
    }
    earthEngineControlMounted = true;
  }

  setTimeout(() => {
    showEarthEngineControl(earthEngineControl);
    earthEngineControl?.expand();
    wireEarthEngineCloseButton(earthEngineControl);
    if (earthEngineControl) syncEarthEngineControlLayersToStore(earthEngineControl);
  }, 0);
  preloadEarthEngineAuthLibrary();
  return true;
}

class GeoLibreEarthEngineControl extends PluginControl {
  async authenticate(projectId?: string, oauthClientId?: string): Promise<void> {
    const isTauriAuth = shouldUseTauriEarthEngineOAuth();
    if (isTauriAuth) {
      const activeOAuthClientId = oauthClientIdValue(
        oauthClientId || activeOAuthClientIdFromControl(this),
      );
      const existingToken = tokenFromControlOptions(this);
      if (existingToken?.accessToken) {
        try {
          clearEarthEngineFunctionInfo();
          await super.authenticate(projectId, activeOAuthClientId);
        } finally {
          await closeTauriOauthPopups();
        }
        return;
      }

      const token = await authenticateEarthEngine(activeOAuthClientId);
      if (token?.accessToken) {
        await closeTauriOauthPopups();
        applyTokenToControlOptions(this, token);
        try {
          clearEarthEngineFunctionInfo();
          await super.authenticate(projectId, activeOAuthClientId);
        } finally {
          await closeTauriOauthPopups();
        }
        return;
      }
    }

    // The base implementation consumes options.accessToken when present
    // (no second OAuth prompt) and still handles project ID persistence,
    // ee.initialize, and status updates.
    try {
      clearEarthEngineFunctionInfo();
      await super.authenticate(projectId, oauthClientId);
    } finally {
      if (isTauriAuth) await closeTauriOauthPopups();
    }
  }

  async loadAsset(assetId: string, vis: VisualizeOptions): Promise<void> {
    clearEarthEngineFunctionInfo();
    await super.loadAsset(assetId, vis);
  }

  async runScript(script: string, vis: VisualizeOptions): Promise<void> {
    clearEarthEngineFunctionInfo();
    await super.runScript(script, vis);
  }
}

function activeOAuthClientIdFromControl(control: PluginControl): string {
  const internals = control as unknown as EarthEngineControlInternals;
  return (
    internals._authOAuthClientInput?.value ||
    internals._oauthClientId ||
    internals._options?.oauthClientId ||
    ""
  );
}

function tokenFromControlOptions(control: PluginControl): TauriEarthEngineOAuthToken | null {
  const options = (control as unknown as EarthEngineControlInternals)._options;
  if (!options?.accessToken) return null;

  return {
    accessToken: options.accessToken,
    tokenType: options.tokenType || "Bearer",
    expiresIn: options.tokenExpiresIn || 3600,
  };
}

function applyTokenToControlOptions(
  control: PluginControl,
  token: TauriEarthEngineOAuthToken,
): void {
  const internals = control as unknown as EarthEngineControlInternals;
  const options = internals._options;
  if (!options || !token.accessToken) return;

  options.accessToken = token.accessToken.replace(/^Bearer\s+/i, "").trim();
  options.tokenType = token.tokenType || "Bearer";
  options.tokenExpiresIn = token.expiresIn || 3600;
}

function wireEarthEngineLayerSync(control: PluginControl): void {
  if (syncedEarthEngineControls.has(control)) return;
  syncedEarthEngineControls.add(control);

  const methods = control as unknown as EarthEngineControlMethods;
  const originalRenderLayersList = methods._renderLayersList?.bind(control);
  if (originalRenderLayersList) {
    methods._renderLayersList = () => {
      originalRenderLayersList();
      syncEarthEngineControlLayersToStore(control);
    };
  }

  const originalApplyLayerOpacity = methods._applyLayerOpacity?.bind(control);
  if (originalApplyLayerOpacity) {
    methods._applyLayerOpacity = (layer) => {
      originalApplyLayerOpacity(layer);
      syncEarthEngineControlLayersToStore(control);
    };
  }

  const originalApplyLayerVisibility = methods._applyLayerVisibility?.bind(control);
  if (originalApplyLayerVisibility) {
    methods._applyLayerVisibility = (layer) => {
      originalApplyLayerVisibility(layer);
      syncEarthEngineControlLayersToStore(control);
    };
  }

  const originalRemoveManagedLayer = methods._removeManagedLayer?.bind(control);
  if (originalRemoveManagedLayer) {
    methods._removeManagedLayer = (layerId) => {
      originalRemoveManagedLayer(layerId);
      syncEarthEngineControlLayersToStore(control);
    };
  }

  earthEngineStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (syncingEarthEngineControlToStore || !earthEngineControl) return;

    const previousEarthEngineLayerIds = new Set(
      previous.layers.filter(isEarthEngineStoreLayer).map((layer) => layer.id),
    );
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));
    const controlLayers = earthEngineControlLayers(earthEngineControl);
    let needsRender = false;

    const removedLayerIds = new Set<string>();

    syncingEarthEngineStoreToControl = true;
    try {
      for (const layer of controlLayers) {
        const storeLayer = currentById.get(layer.id);
        if (!storeLayer) {
          removeEarthEngineControlLayer(earthEngineControl, layer.id);
          removedLayerIds.add(layer.id);
          needsRender = true;
          continue;
        }
        if (!isEarthEngineStoreLayer(storeLayer)) continue;

        if (layer.visible !== storeLayer.visible) {
          layer.visible = storeLayer.visible;
          applyEarthEngineLayerVisibility(earthEngineControl, layer);
          needsRender = true;
        }
        if (layer.opacity !== storeLayer.opacity) {
          layer.opacity = storeLayer.opacity;
          applyEarthEngineLayerOpacity(earthEngineControl, layer);
          needsRender = true;
        }
      }

      for (const previousId of previousEarthEngineLayerIds) {
        if (currentById.has(previousId)) continue;
        if (removedLayerIds.has(previousId)) continue;
        removeEarthEngineControlLayer(earthEngineControl, previousId);
        needsRender = true;
      }
    } finally {
      syncingEarthEngineStoreToControl = false;
    }

    if (needsRender) {
      renderEarthEngineLayersList(earthEngineControl);
    }
  });
}

function syncEarthEngineControlLayersToStore(control: PluginControl): void {
  if (syncingEarthEngineStoreToControl) return;

  const controlLayers = earthEngineControlLayers(control);
  const controlLayerIds = new Set(controlLayers.map((layer) => layer.id));
  const store = useAppStore.getState();

  syncingEarthEngineControlToStore = true;
  try {
    for (const storeLayer of store.layers) {
      if (!isEarthEngineStoreLayer(storeLayer)) continue;
      if (!controlLayerIds.has(storeLayer.id)) {
        store.removeLayer(storeLayer.id);
      }
    }

    for (const controlLayer of controlLayers) {
      const layer = createEarthEngineStoreLayer(controlLayer);
      const existing = useAppStore.getState().layers.find((current) => current.id === layer.id);

      if (existing) {
        if (
          existing.name !== layer.name ||
          existing.visible !== layer.visible ||
          existing.opacity !== layer.opacity ||
          JSON.stringify(existing.metadata) !== JSON.stringify(layer.metadata)
        ) {
          useAppStore.getState().updateLayer(layer.id, {
            metadata: layer.metadata,
            name: layer.name,
            opacity: layer.opacity,
            source: layer.source,
            sourcePath: layer.sourcePath,
            visible: layer.visible,
          });
        }
        continue;
      }

      useAppStore.getState().addLayer(layer);
    }
  } finally {
    syncingEarthEngineControlToStore = false;
  }
}

function createEarthEngineStoreLayer(controlLayer: EarthEngineLoadedLayer): GeoLibreLayer {
  return {
    id: controlLayer.id,
    name: controlLayer.name,
    type: "raster",
    source: {
      sourceId: controlLayer.sourceId,
      tiles: [controlLayer.tileUrl],
      type: "raster",
    },
    visible: controlLayer.visible,
    opacity: controlLayer.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assetId: controlLayer.assetId,
      earthEngineLayerId: controlLayer.id,
      earthEngineLayerName: controlLayer.name,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [controlLayer.layerId],
      sourceId: controlLayer.sourceId,
      sourceIds: [controlLayer.sourceId],
      sourceKind: "earth-engine-raster",
      tileType: "raster",
      tileUrl: controlLayer.tileUrl,
    },
    sourcePath: controlLayer.assetId ?? controlLayer.name,
  };
}

function isEarthEngineStoreLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    layer.metadata.sourceKind === "earth-engine-raster" &&
    layer.metadata.externalNativeLayer === true
  );
}

function earthEngineControlLayers(control: PluginControl): EarthEngineLoadedLayer[] {
  const layers = (control as unknown as EarthEngineControlInternals)._layers;
  return Array.isArray(layers) ? layers : [];
}

function removeEarthEngineControlLayer(control: PluginControl, layerId: string): void {
  (control as unknown as EarthEngineControlMethods)._removeManagedLayer?.(layerId);
}

function applyEarthEngineLayerOpacity(control: PluginControl, layer: EarthEngineLoadedLayer): void {
  (control as unknown as EarthEngineControlMethods)._applyLayerOpacity?.(layer);
}

function applyEarthEngineLayerVisibility(
  control: PluginControl,
  layer: EarthEngineLoadedLayer,
): void {
  (control as unknown as EarthEngineControlMethods)._applyLayerVisibility?.(layer);
}

function renderEarthEngineLayersList(control: PluginControl): void {
  (control as unknown as EarthEngineControlMethods)._renderLayersList?.();
}

function wireEarthEngineCloseButton(control: PluginControl | null): void {
  const panel = earthEnginePanelElement(control);
  applyEarthEnginePanelClass(panel);
  const closeButton = panel?.querySelector<HTMLElement>(".plugin-control-close");
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () => hideEarthEngineControl(control));
}

function hideEarthEngineControl(control: PluginControl | null): void {
  const container = earthEngineContainerElement(control);
  const panel = earthEnginePanelElement(control);
  applyEarthEnginePanelClass(panel);
  if (container) container.style.display = "none";
  if (panel) panel.style.display = "none";
  setEarthEngineControlVisible(false);
}

function showEarthEngineControl(control: PluginControl | null): void {
  const container = earthEngineContainerElement(control);
  const panel = earthEnginePanelElement(control);
  applyEarthEnginePanelClass(panel);
  if (container) container.style.display = "";
  if (panel) panel.style.display = "";
  setEarthEngineControlVisible(true);
}

function applyEarthEnginePanelClass(panel: HTMLElement | undefined): void {
  panel?.classList.add(EARTH_ENGINE_PANEL_CLASS);
}

function earthEngineContainerElement(control: PluginControl | null): HTMLElement | undefined {
  return (control as unknown as EarthEngineControlInternals | null)?._container;
}

function earthEnginePanelElement(control: PluginControl | null): HTMLElement | undefined {
  return (control as unknown as EarthEngineControlInternals | null)?._panel;
}

function setEarthEngineControlVisible(visible: boolean): void {
  if (earthEngineControlVisible === visible) return;
  earthEngineControlVisible = visible;
  for (const listener of earthEnginePanelListeners) listener();
}
