import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type {
  ActiveLayer,
  PlanetaryComputerControl,
  PlanetaryComputerEventData,
  PlanetaryComputerOptions,
  STACClient,
  STACCollection,
  STACItem,
  TiTilerClient,
  TileParams,
} from "maplibre-gl-planetary-computer";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";

type PlanetaryComputerControlConstructor =
  typeof import("maplibre-gl-planetary-computer")["PlanetaryComputerControl"];
type STACClientConstructor =
  typeof import("maplibre-gl-planetary-computer")["STACClient"];
type TiTilerClientConstructor =
  typeof import("maplibre-gl-planetary-computer")["TiTilerClient"];

const planetaryComputerControlPosition: GeoLibreMapControlPosition = "top-left";

const PLANETARY_COMPUTER_OPTIONS = {
  className: "geolibre-planetary-computer-control",
  collapsed: false,
  panelWidth: 380,
  title: "Planetary Computer",
} satisfies PlanetaryComputerOptions;

let planetaryComputerControl: PlanetaryComputerControl | null = null;
let planetaryComputerControlMounted = false;
let planetaryComputerConstructorsPromise: Promise<{
  PlanetaryComputerControl: PlanetaryComputerControlConstructor;
  STACClient: STACClientConstructor;
  TiTilerClient: TiTilerClientConstructor;
}> | null = null;
let planetaryComputerConstructors: {
  PlanetaryComputerControl: PlanetaryComputerControlConstructor;
  STACClient: STACClientConstructor;
  TiTilerClient: TiTilerClientConstructor;
} | null = null;
let planetaryComputerStacClient: STACClient | null = null;
let planetaryComputerTilerClient: TiTilerClient | null = null;
let planetaryComputerStoreUnsubscribe: (() => void) | null = null;
let planetaryComputerRestoreToken = 0;

export function openPlanetaryComputerPanel(app: GeoLibreAppAPI): void {
  void openStandalonePlanetaryComputerControl(app);
}

export function closePlanetaryComputerPanel(app: GeoLibreAppAPI): void {
  if (planetaryComputerControl && planetaryComputerControlMounted) {
    app.removeMapControl(planetaryComputerControl);
    return;
  }
  resetPlanetaryComputerControl(planetaryComputerControl);
}

async function openStandalonePlanetaryComputerControl(
  app: GeoLibreAppAPI
): Promise<boolean> {
  const control = await ensurePlanetaryComputerControl(app);
  if (!control) return false;

  setTimeout(() => {
    showPlanetaryComputerControl(control);
    control.expand();
    wirePlanetaryComputerCloseButton(control);
  }, 0);
  return true;
}

// The library fires the same "collapse" event for the toggle icon and the
// panel's X button, so the two cannot be told apart through events. Clicking
// the toggle icon keeps the library's default behavior (collapse the panel,
// leave the icon on the map); only a direct click on the X button hides the
// whole control until it is reopened from the Processing menu.
function wirePlanetaryComputerCloseButton(
  control: PlanetaryComputerControl | null
): void {
  const closeButton = control
    ?.getPanelElement()
    ?.querySelector<HTMLElement>(".pc-control-close");
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () =>
    hidePlanetaryComputerControl(control)
  );
}

function getPlanetaryComputerConstructors(): Promise<{
  PlanetaryComputerControl: PlanetaryComputerControlConstructor;
  STACClient: STACClientConstructor;
  TiTilerClient: TiTilerClientConstructor;
}> {
  planetaryComputerConstructorsPromise ??= import(
    "maplibre-gl-planetary-computer"
  ).then((module) => {
    const {
      PlanetaryComputerControl: PlanetaryComputerControlClass,
      STACClient: STACClientClass,
      TiTilerClient: TiTilerClientClass,
    } = module;
    planetaryComputerConstructors = {
      PlanetaryComputerControl: PlanetaryComputerControlClass,
      STACClient: STACClientClass,
      TiTilerClient: TiTilerClientClass,
    };
    return planetaryComputerConstructors;
  });
  return planetaryComputerConstructorsPromise;
}

async function ensurePlanetaryComputerControl(
  app: GeoLibreAppAPI
): Promise<PlanetaryComputerControl | null> {
  // Unlike the deck.gl-based plugins (GeoParquet, DuckDB), no
  // ensureMercatorProjection call is needed: the control adds native
  // MapLibre raster layers, which render correctly on the globe projection.
  const { PlanetaryComputerControl: PlanetaryComputerControlClass } =
    await getPlanetaryComputerConstructors();

  planetaryComputerControl ??= createPlanetaryComputerControl(
    PlanetaryComputerControlClass
  );

  if (!planetaryComputerControlMounted) {
    const added = app.addMapControl(
      planetaryComputerControl,
      planetaryComputerControlPosition
    );
    if (!added) {
      resetPlanetaryComputerControl(planetaryComputerControl);
      return null;
    }
    planetaryComputerControlMounted = true;
    hidePlanetaryComputerControl(planetaryComputerControl);
    wirePlanetaryComputerCloseButton(planetaryComputerControl);
  }

  return planetaryComputerControl;
}

function createPlanetaryComputerControl(
  PlanetaryComputerControlClass: PlanetaryComputerControlConstructor
): PlanetaryComputerControl {
  const control = new PlanetaryComputerControlClass(PLANETARY_COMPUTER_OPTIONS);
  patchPlanetaryComputerControlOnRemove(control);
  control.on("layer:add", syncPlanetaryComputerLayersToStore);
  control.on("layer:remove", syncPlanetaryComputerLayersToStore);
  control.on("layer:update", syncPlanetaryComputerLayersToStore);

  // updateLayer stores the passed visible/opacity values verbatim before
  // re-emitting "layer:update" (verified against
  // maplibre-gl-planetary-computer 0.3.0), so the equality checks here and
  // in syncPlanetaryComputerLayersToStore break the store <-> control
  // feedback cycle. When upgrading the library, re-verify that updateLayer
  // does not coerce or round these values; if it ever does, toggling
  // visibility/opacity in the layer list would loop updateLayer <->
  // layer:update indefinitely.
  planetaryComputerStoreUnsubscribe ??= useAppStore.subscribe(
    (state, previous) => {
      const currentById = new Map(
        state.layers.map((layer) => [layer.id, layer])
      );

      for (const layer of previous.layers) {
        if (!isPlanetaryComputerLayer(layer)) continue;

        const currentLayer = currentById.get(layer.id);
        if (!currentLayer) {
          planetaryComputerControl?.removeLayer(layer.id);
          continue;
        }

        if (!isPlanetaryComputerLayer(currentLayer)) continue;

        if (
          currentLayer.visible !== layer.visible ||
          currentLayer.opacity !== layer.opacity
        ) {
          planetaryComputerControl?.updateLayer(currentLayer.id, {
            opacity: currentLayer.opacity,
            visible: currentLayer.visible,
          });
        }
      }
    }
  );

  return control;
}

function syncPlanetaryComputerLayersToStore(
  event: PlanetaryComputerEventData
): void {
  const store = useAppStore.getState();
  const activeLayers = event.state.activeLayers;
  const activeLayerIds = new Set(activeLayers.map((layer) => layer.id));

  for (const storeLayer of store.layers) {
    if (!isPlanetaryComputerLayer(storeLayer)) continue;
    if (!activeLayerIds.has(storeLayer.id)) {
      store.removeLayer(storeLayer.id);
    }
  }

  for (const activeLayer of activeLayers) {
    const layer = createPlanetaryComputerStoreLayer(activeLayer);
    const existing = useAppStore
      .getState()
      .layers.find((current) => current.id === layer.id);

    if (existing) {
      // Only sync visible/opacity (the same fields the store -> control path
      // syncs). The name is derived from STAC metadata, so re-syncing it here
      // would clobber a user rename on every panel event.
      if (
        existing.visible !== layer.visible ||
        existing.opacity !== layer.opacity
      ) {
        useAppStore.getState().updateLayer(layer.id, {
          opacity: layer.opacity,
          visible: layer.visible,
        });
      }
      continue;
    }

    useAppStore.getState().addLayer(layer);
  }
}

function createPlanetaryComputerStoreLayer(
  activeLayer: ActiveLayer
): GeoLibreLayer {
  const bbox =
    activeLayer.item?.bbox ??
    activeLayer.collection?.extent?.spatial?.bbox?.[0];
  const collectionId =
    activeLayer.item?.collection ?? activeLayer.collection?.id ?? "";

  return {
    id: activeLayer.id,
    name: planetaryComputerLayerName(activeLayer),
    type: "raster",
    source: {
      collectionId,
      sourceId: activeLayer.sourceId,
      type: "raster",
    },
    visible: activeLayer.visible,
    opacity: activeLayer.opacity,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assets: activeLayer.assets,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [activeLayer.id],
      planetaryComputerLayerType: activeLayer.type,
      presetName: activeLayer.presetName,
      renderParams: activeLayer.renderParams,
      sourceId: activeLayer.sourceId,
      sourceIds: [activeLayer.sourceId],
      sourceKind: "planetary-computer-raster",
      stacCollectionId: collectionId,
      stacItemId: activeLayer.item?.id,
      tileType: "raster",
      ...(bbox ? { bounds: bbox } : {}),
    },
    sourcePath: collectionId || activeLayer.item?.id || activeLayer.id,
  };
}

/**
 * Replays saved Planetary Computer raster layers into the upstream control.
 * The upstream addItemLayer/addCollectionLayer methods generate fresh IDs, so
 * project restore has to recreate the native MapLibre layers with the saved
 * GeoLibre IDs and register them with the control's runtime layer manager.
 *
 * @param app - The GeoLibre app API.
 */
export function restorePlanetaryComputerLayers(app: GeoLibreAppAPI): void {
  const hasPlanetaryComputerLayers = useAppStore
    .getState()
    .layers.some(isPlanetaryComputerLayer);
  if (!hasPlanetaryComputerLayers && !planetaryComputerControl) return;

  const restoreToken = ++planetaryComputerRestoreToken;
  void (async () => {
    const control = await ensurePlanetaryComputerControl(app);
    if (!control || restoreToken !== planetaryComputerRestoreToken) return;

    const storeLayers = useAppStore
      .getState()
      .layers.filter(isPlanetaryComputerLayer);
    const storeLayerIds = new Set(storeLayers.map((layer) => layer.id));

    for (const activeLayer of [...control.getState().activeLayers]) {
      if (!storeLayerIds.has(activeLayer.id)) {
        control.removeLayer(activeLayer.id);
      }
    }

    const activeLayerIds = new Set(
      control.getState().activeLayers.map((layer) => layer.id)
    );

    const layersToRestore: GeoLibreLayer[] = [];
    for (const layer of storeLayers) {
      if (activeLayerIds.has(layer.id)) {
        control.updateLayer(layer.id, {
          opacity: layer.opacity,
          visible: layer.visible,
        });
        continue;
      }

      layersToRestore.push(layer);
    }

    const results = await Promise.allSettled(
      layersToRestore.map((layer) =>
        restorePlanetaryComputerLayer(control, layer, restoreToken)
      )
    );
    let restoredCount = 0;
    for (const [index, result] of results.entries()) {
      const layer = layersToRestore[index];
      if (result.status === "fulfilled") {
        if (result.value) restoredCount += 1;
      } else {
        console.error(
          `[GeoLibre] Failed to restore Planetary Computer layer "${
            layer?.name ?? "unknown"
          }"`,
          result.reason
        );
      }
    }

    if (restoredCount > 0) {
      emitPlanetaryComputerRestore(control);
    } else if (
      layersToRestore.length > 0 &&
      restoreToken === planetaryComputerRestoreToken
    ) {
      console.warn(
        "[GeoLibre] No Planetary Computer layers could be restored; " +
          "the saved layers will remain in the panel but will not render."
      );
    }
  })().catch((error) => {
    console.error(
      "[GeoLibre] Failed to restore Planetary Computer layers",
      error
    );
  });
}

async function restorePlanetaryComputerLayer(
  control: PlanetaryComputerControl,
  layer: GeoLibreLayer,
  restoreToken: number
): Promise<boolean> {
  const collectionId = stringMetadata(layer, "stacCollectionId");
  const layerType = stringMetadata(layer, "planetaryComputerLayerType");
  if (!collectionId) {
    throw new Error(
      "Saved Planetary Computer layer is missing a collection id."
    );
  }

  if (layerType === "collection" || layerType === "mosaic") {
    const collection = await getPlanetaryComputerStacClient().getCollection(
      collectionId
    );
    const currentLayer = currentRestorablePlanetaryComputerLayer(
      control,
      layer,
      restoreToken
    );
    if (!currentLayer) return false;
    registerRestoredPlanetaryComputerLayer(control, currentLayer, {
      collection,
      type: layerType,
    });
    return true;
  }

  const itemId = stringMetadata(layer, "stacItemId");
  if (!itemId) {
    throw new Error(
      "Saved Planetary Computer item layer is missing an item id."
    );
  }

  const item = await getPlanetaryComputerStacClient().getItem(
    collectionId,
    itemId
  );
  const currentLayer = currentRestorablePlanetaryComputerLayer(
    control,
    layer,
    restoreToken
  );
  if (!currentLayer) return false;
  registerRestoredPlanetaryComputerLayer(control, currentLayer, {
    item,
    type: "item",
  });
  return true;
}

function registerRestoredPlanetaryComputerLayer(
  control: PlanetaryComputerControl,
  layer: GeoLibreLayer,
  source:
    | { item: STACItem; type: "item" }
    | { collection: STACCollection; type: "collection" | "mosaic" }
): void {
  const map = control.getMap();
  if (!map) throw new Error("Planetary Computer control is not attached.");

  const sourceId = stringMetadata(layer, "sourceId") || `${layer.id}-source`;
  const renderParams = tileParamsMetadata(layer, "renderParams");
  const assets =
    stringArrayMetadata(layer, "assets") || renderParams.assets || [];
  const savedBounds = numberArrayMetadata(layer, "bounds");
  const tileParams = assets.length ? { ...renderParams, assets } : renderParams;

  if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  if (source.type === "item") {
    const collectionId = source.item.collection || "";
    map.addSource(sourceId, {
      type: "raster",
      url: getPlanetaryComputerTilerClient().getItemTileJSONUrl(
        collectionId,
        source.item.id,
        tileParams
      ),
      tileSize: tileParams.tile_size || 256,
      bounds: boundsTuple(source.item.bbox),
      attribution: "Microsoft Planetary Computer",
    });
  } else {
    map.addSource(sourceId, {
      type: "raster",
      tiles: [
        getPlanetaryComputerTilerClient().getCollectionTileUrl(
          source.collection.id,
          tileParams
        ),
      ],
      tileSize: tileParams.tile_size || 256,
      bounds:
        savedBounds ?? boundsTuple(source.collection.extent.spatial.bbox[0]),
      attribution: "Microsoft Planetary Computer",
    });
  }

  map.addLayer(
    {
      id: layer.id,
      type: "raster",
      source: sourceId,
      layout: {
        visibility: layer.visible ? "visible" : "none",
      },
      paint: {
        "raster-opacity": layer.opacity,
      },
    },
    nextRenderedStoreLayerId(map, layer.id)
  );

  const activeLayer: ActiveLayer = {
    id: layer.id,
    type: source.type,
    sourceId,
    ...(source.type === "item"
      ? { item: source.item, collection: undefined }
      : { collection: source.collection }),
    visible: layer.visible,
    opacity: layer.opacity,
    assets,
    renderParams: tileParams,
    presetName: stringMetadata(layer, "presetName"),
    showControls: false,
  };

  const internals = control as unknown as PlanetaryComputerControlInternals;
  internals._layerManager?.layers?.set(layer.id, activeLayer);
  if (
    internals._state?.activeLayers &&
    !internals._state.activeLayers.some((current) => current.id === layer.id)
  ) {
    internals._state.activeLayers.push(activeLayer);
  }
}

function currentRestorablePlanetaryComputerLayer(
  control: PlanetaryComputerControl,
  layer: GeoLibreLayer,
  restoreToken: number
): GeoLibreLayer | null {
  if (
    restoreToken !== planetaryComputerRestoreToken ||
    control !== planetaryComputerControl
  ) {
    return null;
  }

  const currentLayer = useAppStore
    .getState()
    .layers.find((candidate) => candidate.id === layer.id);
  if (!currentLayer || !isPlanetaryComputerLayer(currentLayer)) return null;
  if (
    stringMetadata(currentLayer, "stacCollectionId") !==
      stringMetadata(layer, "stacCollectionId") ||
    stringMetadata(currentLayer, "stacItemId") !==
      stringMetadata(layer, "stacItemId") ||
    stringMetadata(currentLayer, "planetaryComputerLayerType") !==
      stringMetadata(layer, "planetaryComputerLayerType")
  ) {
    return null;
  }

  return currentLayer;
}

function nextRenderedStoreLayerId(
  map: NonNullable<ReturnType<PlanetaryComputerControl["getMap"]>>,
  layerId: string
): string | undefined {
  const layers = useAppStore.getState().layers;
  const layerIndex = layers.findIndex((layer) => layer.id === layerId);
  if (layerIndex < 0) return undefined;

  for (const candidate of layers.slice(layerIndex + 1)) {
    for (const renderedId of renderedLayerIds(candidate)) {
      if (renderedId !== layerId && map.getLayer(renderedId)) {
        return renderedId;
      }
    }
  }
  return undefined;
}

function renderedLayerIds(layer: GeoLibreLayer): string[] {
  const nativeLayerIds = Array.isArray(layer.metadata.nativeLayerIds)
    ? layer.metadata.nativeLayerIds.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
  return [...nativeLayerIds, layer.id];
}

function emitPlanetaryComputerRestore(control: PlanetaryComputerControl): void {
  const internals = control as unknown as PlanetaryComputerControlInternals;
  internals._emit?.("layer:add");
  internals._emit?.("statechange");
  internals._renderContent?.();
}

function getPlanetaryComputerStacClient(): STACClient {
  if (!planetaryComputerStacClient) {
    const { STACClient: STACClientClass } =
      getResolvedPlanetaryComputerConstructors();
    planetaryComputerStacClient = new STACClientClass();
  }
  return planetaryComputerStacClient;
}

function getPlanetaryComputerTilerClient(): TiTilerClient {
  if (!planetaryComputerTilerClient) {
    const { TiTilerClient: TiTilerClientClass } =
      getResolvedPlanetaryComputerConstructors();
    planetaryComputerTilerClient = new TiTilerClientClass();
  }
  return planetaryComputerTilerClient;
}

function getResolvedPlanetaryComputerConstructors(): {
  STACClient: STACClientConstructor;
  TiTilerClient: TiTilerClientConstructor;
} {
  if (!planetaryComputerConstructors) {
    throw new Error("Planetary Computer constructors are not loaded.");
  }
  return planetaryComputerConstructors;
}

function planetaryComputerLayerName(activeLayer: ActiveLayer): string {
  if (activeLayer.item) return activeLayer.item.id;
  if (activeLayer.collection) {
    return activeLayer.collection.title || activeLayer.collection.id;
  }
  return activeLayer.id;
}

function patchPlanetaryComputerControlOnRemove(
  control: PlanetaryComputerControl
): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    resetPlanetaryComputerControl(control);
  };
}

function resetPlanetaryComputerControl(
  control: PlanetaryComputerControl | null
): void {
  if (planetaryComputerControl !== control) return;

  control?.off("layer:add", syncPlanetaryComputerLayersToStore);
  control?.off("layer:remove", syncPlanetaryComputerLayersToStore);
  control?.off("layer:update", syncPlanetaryComputerLayersToStore);
  planetaryComputerStoreUnsubscribe?.();
  planetaryComputerStoreUnsubscribe = null;
  planetaryComputerControlMounted = false;
  planetaryComputerControl = null;
}

function hidePlanetaryComputerControl(
  control: PlanetaryComputerControl | null
): void {
  const container = control?.getContainer();
  const panel = control?.getPanelElement();
  if (container) container.style.display = "none";
  if (panel) panel.style.display = "none";
}

function showPlanetaryComputerControl(
  control: PlanetaryComputerControl | null
): void {
  const container = control?.getContainer();
  const panel = control?.getPanelElement();
  if (container) container.style.display = "";
  if (panel) panel.style.display = "";
}

function isPlanetaryComputerLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "raster" &&
    layer.metadata.sourceKind === "planetary-computer-raster" &&
    layer.metadata.externalNativeLayer === true
  );
}

type PlanetaryComputerLayerManagerInternals = {
  layers?: Map<string, ActiveLayer>;
};

type PlanetaryComputerControlInternals = {
  _layerManager?: PlanetaryComputerLayerManagerInternals;
  _state?: { activeLayers: ActiveLayer[] };
  _emit?: (event: "layer:add" | "statechange") => void;
  _renderContent?: () => void;
};

function stringMetadata(layer: GeoLibreLayer, key: string): string | undefined {
  const value = layer.metadata[key];
  return typeof value === "string" && value ? value : undefined;
}

function stringArrayMetadata(
  layer: GeoLibreLayer,
  key: string
): string[] | undefined {
  const value = layer.metadata[key];
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function numberArrayMetadata(
  layer: GeoLibreLayer,
  key: string
): [number, number, number, number] | undefined {
  const value = layer.metadata[key];
  return boundsTuple(value);
}

function tileParamsMetadata(layer: GeoLibreLayer, key: string): TileParams {
  const value = layer.metadata[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as TileParams)
    : {};
}

function boundsTuple(
  value: unknown
): [number, number, number, number] | undefined {
  return Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry) => typeof entry === "number")
    ? (value as [number, number, number, number])
    : undefined;
}
