import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  isPlanetaryComputerLayer,
  PLANETARY_COMPUTER_SOURCE_KIND,
  useAppStore,
} from "@geolibre/core";
import type {
  ActiveLayer,
  PlanetaryComputerControl,
  PlanetaryComputerCustomActions,
  PlanetaryComputerEventData,
  PlanetaryComputerOptions,
  PlanetaryComputerState,
  STACClient,
  STACCollection,
  STACItem,
  STACSearchParams,
  TiTilerClient,
  TileParams,
} from "maplibre-gl-planetary-computer";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";
import {
  PLANETARY_COMPUTER_STAC_URL,
  planetaryComputerStacClientOptions,
} from "./planetary-computer-stac";

/**
 * `metadata.sourceKind` marking the Planetary Computer raster layers this plugin adds. Re-exported so the
 * Layer Library's restore dispatch keys off the same value this plugin writes
 * rather than a hand-typed copy (issue #1520).
 */
export { isPlanetaryComputerLayer, PLANETARY_COMPUTER_SOURCE_KIND };

type PlanetaryComputerModule = typeof import("maplibre-gl-planetary-computer");

const planetaryComputerControlPosition: GeoLibreMapControlPosition = "top-left";

const PLANETARY_COMPUTER_OPTIONS = {
  className: "geolibre-planetary-computer-control",
  collapsed: false,
  panelWidth: 380,
  title: "Planetary Computer",
} satisfies PlanetaryComputerOptions;

let planetaryComputerControl: PlanetaryComputerControl | null = null;
let planetaryComputerControlMounted = false;
let planetaryComputerModulePromise: Promise<PlanetaryComputerModule> | null = null;
let planetaryComputerModule: PlanetaryComputerModule | null = null;
let planetaryComputerStacClient: STACClient | null = null;
let planetaryComputerTilerClient: TiTilerClient | null = null;
let planetaryComputerStoreUnsubscribe: (() => void) | null = null;
let planetaryComputerRestoreToken = 0;
let planetaryComputerRestorePreservedLayerIds = new Set<string>();
let planetaryComputerStoreSyncSuspended = 0;
let planetaryComputerCustomActions:
  | ((app: GeoLibreAppAPI) => PlanetaryComputerCustomActions)
  | null = null;

/**
 * Supplies the extra buttons GeoLibre adds to the panel (Time Slider, STAC
 * browser, colorbar, ...). Kept as a late-bound factory so this module does not
 * import the plugins those buttons hand off to.
 *
 * @param factory - Builds the custom actions for a host app, or null for none.
 */
export function setPlanetaryComputerCustomActions(
  factory: ((app: GeoLibreAppAPI) => PlanetaryComputerCustomActions) | null,
): void {
  planetaryComputerCustomActions = factory;
}

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

/**
 * Whether the panel can run on the active renderer.
 *
 * The control draws its layers through the MapLibre style API (raster sources
 * added to the map it is mounted on), so it needs a native MapLibre map. The
 * Mapbox, ArcGIS, and Cesium engines have none.
 *
 * @param app - The GeoLibre app API.
 * @returns True when the active renderer can host the panel.
 */
export function isPlanetaryComputerPanelSupported(app: GeoLibreAppAPI): boolean {
  return Boolean(app.getMap?.());
}

async function openStandalonePlanetaryComputerControl(app: GeoLibreAppAPI): Promise<boolean> {
  const control = await ensurePlanetaryComputerControl(app, {
    hiddenOnMount: false,
  });
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
function wirePlanetaryComputerCloseButton(control: PlanetaryComputerControl | null): void {
  const closeButton = control?.getPanelElement()?.querySelector<HTMLElement>(".pc-control-close");
  if (!closeButton || closeButton.dataset.geolibreCloseWired === "true") {
    return;
  }
  closeButton.dataset.geolibreCloseWired = "true";
  closeButton.addEventListener("click", () => hidePlanetaryComputerControl(control));
}

function loadPlanetaryComputerModule(): Promise<PlanetaryComputerModule> {
  planetaryComputerModulePromise ??= import("maplibre-gl-planetary-computer").then((module) => {
    planetaryComputerModule = module;
    return module;
  });
  return planetaryComputerModulePromise;
}

async function ensurePlanetaryComputerControl(
  app: GeoLibreAppAPI,
  options: { hiddenOnMount?: boolean } = {},
): Promise<PlanetaryComputerControl | null> {
  // The control adds native MapLibre raster layers to the map it is mounted on,
  // so there is nothing to mount it on without a MapLibre map (the Mapbox,
  // ArcGIS, and Cesium engines). Unlike the deck.gl-based plugins (GeoParquet,
  // DuckDB), no ensureMercatorProjection call is needed: raster layers render
  // correctly on the globe projection.
  if (!isPlanetaryComputerPanelSupported(app)) return null;

  const module = await loadPlanetaryComputerModule();
  planetaryComputerControl ??= createPlanetaryComputerControl(module, app);

  if (!planetaryComputerControlMounted) {
    const added = app.addMapControl(planetaryComputerControl, planetaryComputerControlPosition);
    if (!added) {
      resetPlanetaryComputerControl(planetaryComputerControl);
      return null;
    }
    planetaryComputerControlMounted = true;
    if (options.hiddenOnMount ?? true) {
      hidePlanetaryComputerControl(planetaryComputerControl);
    }
    wirePlanetaryComputerCloseButton(planetaryComputerControl);
  }

  return planetaryComputerControl;
}

function createPlanetaryComputerControl(
  module: PlanetaryComputerModule,
  app: GeoLibreAppAPI,
): PlanetaryComputerControl {
  const control = new module.PlanetaryComputerControl({
    ...PLANETARY_COMPUTER_OPTIONS,
    // The control and the restore/identify paths share one pair of clients, so
    // every request gets the same CORS-safe search and collection fallback.
    stacClient: getPlanetaryComputerStacClient(module),
    tilerClient: getPlanetaryComputerTilerClient(module),
    customActions: planetaryComputerCustomActions?.(app),
  });
  patchPlanetaryComputerControlOnRemove(control);
  control.on("layer:add", syncPlanetaryComputerLayersToStore);
  control.on("layer:remove", syncPlanetaryComputerLayersToStore);
  control.on("layer:update", syncPlanetaryComputerLayersToStore);

  // updateLayer stores the passed visible/opacity values verbatim before
  // re-emitting "layer:update" (covered by tests/upstream-contracts.test.ts),
  // so the equality checks here and in syncPlanetaryComputerLayersToStore break
  // the store <-> control feedback cycle. If the library ever coerced or
  // rounded these values, toggling visibility/opacity in the layer list would
  // loop updateLayer <-> layer:update indefinitely.
  planetaryComputerStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isPlanetaryComputerLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        planetaryComputerRestorePreservedLayerIds.delete(layer.id);
        runWithPlanetaryComputerStoreSyncSuspended(() => {
          planetaryComputerControl?.removeLayer(layer.id);
        });
        continue;
      }

      if (!isPlanetaryComputerLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible || currentLayer.opacity !== layer.opacity) {
        planetaryComputerControl?.updateLayer(currentLayer.id, {
          opacity: currentLayer.opacity,
          visible: currentLayer.visible,
        });
      }
    }
  });

  return control;
}

function syncPlanetaryComputerLayersToStore(
  event: Pick<PlanetaryComputerEventData, "state">,
): void {
  if (planetaryComputerStoreSyncSuspended > 0) return;

  const store = useAppStore.getState();
  const activeLayers = event.state.activeLayers;
  const activeLayerIds = new Set(activeLayers.map((layer) => layer.id));

  for (const storeLayer of store.layers) {
    if (!isPlanetaryComputerLayer(storeLayer)) continue;
    if (
      !activeLayerIds.has(storeLayer.id) &&
      !planetaryComputerRestorePreservedLayerIds.has(storeLayer.id)
    ) {
      planetaryComputerRestorePreservedLayerIds.delete(storeLayer.id);
      store.removeLayer(storeLayer.id);
    }
  }

  for (const activeLayer of activeLayers) {
    planetaryComputerRestorePreservedLayerIds.delete(activeLayer.id);
    const layer = createPlanetaryComputerStoreLayer(activeLayer);
    const existing = useAppStore.getState().layers.find((current) => current.id === layer.id);

    if (existing) {
      // Sync visible/opacity (the same fields the store -> control path syncs)
      // and the render state a restyle in the panel changed, so a saved project
      // reopens with the layer's current look. The name is derived from STAC
      // metadata, so re-syncing it here would clobber a user rename on every
      // panel event.
      const patch: Partial<GeoLibreLayer> = {};
      if (existing.visible !== layer.visible) patch.visible = layer.visible;
      if (existing.opacity !== layer.opacity) patch.opacity = layer.opacity;
      const metadata = planetaryComputerRenderMetadataPatch(existing, layer);
      if (metadata) patch.metadata = { ...existing.metadata, ...metadata };
      if (Object.keys(patch).length > 0) {
        useAppStore.getState().updateLayer(layer.id, patch);
      }
      continue;
    }

    useAppStore.getState().addLayer(layer);
  }
}

/** Metadata keys that describe how a layer is rendered and so follow a restyle. */
const PLANETARY_COMPUTER_RENDER_METADATA_KEYS = ["assets", "presetName", "renderParams"] as const;

/**
 * The render metadata of `next` that differs from `existing`.
 *
 * @param existing - The layer currently in the store.
 * @param next - The layer rebuilt from the control's state.
 * @returns The changed metadata fields, or null when nothing changed.
 */
function planetaryComputerRenderMetadataPatch(
  existing: GeoLibreLayer,
  next: GeoLibreLayer,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  for (const key of PLANETARY_COMPUTER_RENDER_METADATA_KEYS) {
    if (JSON.stringify(existing.metadata[key]) !== JSON.stringify(next.metadata[key])) {
      patch[key] = next.metadata[key];
    }
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Builds the GeoLibre store layer that mirrors a control layer.
 *
 * The metadata is everything {@link restorePlanetaryComputerLayers} needs to
 * rebuild the layer from a saved project: the collection, the item id (or, for
 * a mosaic, the search that selects its items), and the render state. The same
 * shape is authored by the Python API's `Map.add_planetary_computer` and the
 * MCP server's `add_planetary_computer_layer` (see `docs/project-format.md`).
 *
 * @param activeLayer - The control's layer.
 * @returns The mirroring store layer.
 */
export function createPlanetaryComputerStoreLayer(activeLayer: ActiveLayer): GeoLibreLayer {
  const bbox =
    activeLayer.bounds ??
    boundsTuple(activeLayer.item?.bbox) ??
    boundsTuple(activeLayer.collection?.extent?.spatial?.bbox?.[0]);
  const collectionId = activeLayer.item?.collection ?? activeLayer.collection?.id ?? "";
  const datetime = activeLayer.item ? planetaryComputerItemDate(activeLayer.item) : undefined;

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
      // Identify reads pixel values through the Data API (see
      // identifyPlanetaryComputerLayer), not through a vector feature query.
      identifiable: true,
      nativeLayerIds: [activeLayer.id],
      planetaryComputerLayerType: activeLayer.type,
      presetName: activeLayer.presetName,
      renderParams: activeLayer.renderParams,
      sourceId: activeLayer.sourceId,
      sourceIds: [activeLayer.sourceId],
      sourceKind: PLANETARY_COMPUTER_SOURCE_KIND,
      stacCollectionId: collectionId,
      stacItemId: activeLayer.item?.id,
      ...(datetime ? { stacDatetime: datetime } : {}),
      ...(activeLayer.searchParams ? { stacSearchParams: activeLayer.searchParams } : {}),
      tileType: "raster",
      ...(bbox ? { bounds: bbox } : {}),
    },
    sourcePath: collectionId || activeLayer.item?.id || activeLayer.id,
  };
}

/**
 * Replays saved Planetary Computer raster layers into the upstream control.
 * Each layer is re-created under its saved GeoLibre id through the control's
 * public add methods, so the panel lists it and can restyle it again.
 *
 * @param app - The GeoLibre app API.
 */
export function restorePlanetaryComputerLayers(app: GeoLibreAppAPI): void {
  const hasPlanetaryComputerLayers = useAppStore.getState().layers.some(isPlanetaryComputerLayer);
  if (!hasPlanetaryComputerLayers && !planetaryComputerControl) return;

  const restoreToken = ++planetaryComputerRestoreToken;
  void (async () => {
    const control = await ensurePlanetaryComputerControl(app);
    if (!control || restoreToken !== planetaryComputerRestoreToken) return;

    const storeLayers = useAppStore.getState().layers.filter(isPlanetaryComputerLayer);
    const storeLayerIds = new Set(storeLayers.map((layer) => layer.id));

    runWithPlanetaryComputerStoreSyncSuspended(() => {
      for (const activeLayer of [...control.getState().activeLayers]) {
        if (!storeLayerIds.has(activeLayer.id)) {
          control.removeLayer(activeLayer.id);
        }
      }
    });

    const activeLayerIds = new Set(control.getState().activeLayers.map((layer) => layer.id));

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
      layersToRestore.map((layer) => restorePlanetaryComputerLayer(control, layer, restoreToken)),
    );

    const restoredLayerIds = new Set<string>();
    const invalidLayers: PlanetaryComputerRestoreFailure[] = [];
    const transientFailures: PlanetaryComputerRestoreFailure[] = [];
    for (const [index, result] of results.entries()) {
      const layer = layersToRestore[index];
      if (result.status === "fulfilled") {
        if (result.value) restoredLayerIds.add(result.value);
      } else {
        const failure = {
          id: layer?.id ?? "",
          name: layer?.name ?? "unknown",
        };
        if (isInvalidPlanetaryComputerLayerMetadataError(result.reason)) {
          invalidLayers.push(failure);
        } else {
          transientFailures.push(failure);
        }
        console.error(
          `[GeoLibre] Failed to restore Planetary Computer layer "${layer?.name ?? "unknown"}"`,
          result.reason,
        );
      }
    }

    if (restoreToken !== planetaryComputerRestoreToken) {
      rollbackSupersededPlanetaryComputerRestore(control, layersToRestore, restoredLayerIds);
      return;
    }

    if (invalidLayers.length > 0) {
      removeInvalidPlanetaryComputerStoreLayers(control, invalidLayers);
      console.warn(
        "[GeoLibre] Some Planetary Computer layers had invalid saved " +
          `metadata and were removed from the layer list: ${invalidLayers
            .map((layer) => layer.name)
            .join(", ")}`,
      );
    }

    if (transientFailures.length > 0) {
      for (const transientFailure of transientFailures) {
        if (transientFailure.id) {
          planetaryComputerRestorePreservedLayerIds.add(transientFailure.id);
        }
      }
      console.warn(
        "[GeoLibre] Some Planetary Computer layers could not be restored " +
          `and were kept in the layer list: ${transientFailures
            .map((layer) => layer.name)
            .join(", ")}`,
      );
    }

    if (restoredLayerIds.size > 0) {
      // The adds above ran with the store sync suspended (each one would
      // otherwise drop the saved layers not yet restored). Reconcile once now.
      syncPlanetaryComputerLayersToStore({ state: control.getState() });
    }
  })().catch((error) => {
    console.error("[GeoLibre] Failed to restore Planetary Computer layers", error);
  });
}

async function restorePlanetaryComputerLayer(
  control: PlanetaryComputerControl,
  layer: GeoLibreLayer,
  restoreToken: number,
): Promise<string | null> {
  const module = await loadPlanetaryComputerModule();
  const collectionId = stringMetadata(layer, "stacCollectionId");
  const layerType = stringMetadata(layer, "planetaryComputerLayerType");
  if (!collectionId) {
    throw new InvalidPlanetaryComputerLayerMetadataError(
      "Saved Planetary Computer layer is missing a collection id.",
    );
  }

  const style = planetaryComputerSavedStyle(module, layer, collectionId);

  // "collection" is how releases before the mosaic rewrite spelled a mosaic of
  // a whole collection; it restores the same way, with an empty search.
  if (layerType === "collection" || layerType === "mosaic") {
    const searchParams: Partial<STACSearchParams> = {
      ...searchParamsMetadata(layer, "stacSearchParams"),
      collections: [collectionId],
    };
    // A search id is not permanent, so register the search again instead of
    // saving the id. Registration is idempotent.
    const [collection, { searchId }] = await Promise.all([
      getPlanetaryComputerStacClient(module).getCollection(collectionId),
      getPlanetaryComputerTilerClient(module).registerMosaic(searchParams),
    ]);
    const currentLayer = currentRestorablePlanetaryComputerLayer(control, layer, restoreToken);
    if (!currentLayer) return null;
    const map = control.getMap();
    // With `mosaicId` given the control skips registration, so the layer is
    // added (and its events fire) synchronously inside this call, while the
    // store sync is suspended. The promise is still awaited below: a failure
    // to build the source rejects it, and must fail this layer's restore.
    const added = runWithPlanetaryComputerStoreSyncSuspended(() =>
      control.addMosaicLayer(collection, {
        ...style,
        id: currentLayer.id,
        sourceId: stringMetadata(currentLayer, "sourceId"),
        visible: currentLayer.visible,
        opacity: currentLayer.opacity,
        beforeId: map ? nextRenderedStoreLayerId(map, currentLayer.id) : undefined,
        mosaicId: searchId,
        searchParams,
        bbox: numberArrayMetadata(currentLayer, "bounds"),
      }),
    );
    await added;
    return currentLayer.id;
  }

  const itemId = stringMetadata(layer, "stacItemId");
  if (!itemId) {
    throw new InvalidPlanetaryComputerLayerMetadataError(
      "Saved Planetary Computer item layer is missing an item id.",
    );
  }

  const item = await getPlanetaryComputerStacClient(module).getItem(collectionId, itemId);
  const currentLayer = currentRestorablePlanetaryComputerLayer(control, layer, restoreToken);
  if (!currentLayer) return null;
  const map = control.getMap();
  runWithPlanetaryComputerStoreSyncSuspended(() => {
    control.addItemLayer(
      { ...item, collection: item.collection || collectionId },
      {
        ...style,
        id: currentLayer.id,
        sourceId: stringMetadata(currentLayer, "sourceId"),
        visible: currentLayer.visible,
        opacity: currentLayer.opacity,
        beforeId: map ? nextRenderedStoreLayerId(map, currentLayer.id) : undefined,
      },
    );
  });
  return currentLayer.id;
}

/**
 * The render options saved on a layer, in the shape the control's add methods take.
 *
 * A layer saved by the app carries its full `renderParams`. One authored by the
 * Python API or the MCP server may carry only a `presetName` (or nothing), in
 * which case the preset's parameters are looked up here, and with neither the
 * control falls back to the collection's default preset.
 *
 * @param module - The loaded Planetary Computer library.
 * @param layer - The saved store layer.
 * @param collectionId - The layer's collection id.
 * @returns The `renderParams`/`assets`/`presetName` options to pass on.
 */
export function planetaryComputerSavedStyle(
  module: Pick<PlanetaryComputerModule, "getPreset">,
  layer: GeoLibreLayer,
  collectionId: string,
): { assets?: string[]; presetName?: string; renderParams?: TileParams } {
  const presetName = stringMetadata(layer, "presetName");
  const savedParams = tileParamsMetadata(layer, "renderParams");
  const savedAssets = stringArrayMetadata(layer, "assets");
  const preset = presetName ? module.getPreset(collectionId, presetName) : undefined;
  const hasSavedParams = Object.keys(savedParams).length > 0;

  if (!hasSavedParams && !savedAssets?.length) {
    return preset ? { presetName: preset.name, renderParams: { ...preset.params } } : {};
  }

  // Parameters that say what to draw (assets or band math) are a complete
  // render: every layer the app saves has them, and they are used as saved,
  // whatever preset name rides along. Without them the saved parameters are a
  // partial override from the Python API or the MCP server (a preset plus, say,
  // its own rescale), and are applied over the preset's.
  const selectsBands = Boolean(
    savedParams.expression || savedParams.assets?.length || savedAssets?.length,
  );
  const renderParams: TileParams = selectsBands
    ? savedParams
    : { ...preset?.params, ...savedParams };
  const assets = savedAssets?.length ? savedAssets : renderParams.assets;
  return {
    ...(presetName ? { presetName } : {}),
    renderParams,
    ...(assets?.length ? { assets } : {}),
  };
}

function removeInvalidPlanetaryComputerStoreLayers(
  control: PlanetaryComputerControl,
  invalidLayers: PlanetaryComputerRestoreFailure[],
): void {
  const activeLayerIds = new Set(control.getState().activeLayers.map((layer) => layer.id));
  for (const invalidLayer of invalidLayers) {
    if (!invalidLayer.id || activeLayerIds.has(invalidLayer.id)) continue;
    planetaryComputerRestorePreservedLayerIds.delete(invalidLayer.id);
    const storeLayer = useAppStore.getState().layers.find((layer) => layer.id === invalidLayer.id);
    if (storeLayer && isPlanetaryComputerLayer(storeLayer)) {
      useAppStore.getState().removeLayer(invalidLayer.id);
    }
  }
}

function rollbackSupersededPlanetaryComputerRestore(
  control: PlanetaryComputerControl,
  layersToRestore: GeoLibreLayer[],
  restoredLayerIds: Set<string>,
): void {
  if (restoredLayerIds.size === 0) return;

  const restoredLayersById = new Map(layersToRestore.map((layer) => [layer.id, layer]));
  let keptRestoredLayer = false;

  runWithPlanetaryComputerStoreSyncSuspended(() => {
    for (const restoredLayerId of restoredLayerIds) {
      const restoredLayer = restoredLayersById.get(restoredLayerId);
      if (restoredLayer && currentStoreLayerMatchesPlanetaryComputerRestore(restoredLayer)) {
        keptRestoredLayer = true;
        continue;
      }

      control.removeLayer(restoredLayerId);
    }
  });

  if (keptRestoredLayer) {
    syncPlanetaryComputerLayersToStore({ state: control.getState() });
  }
}

function currentRestorablePlanetaryComputerLayer(
  control: PlanetaryComputerControl,
  layer: GeoLibreLayer,
  restoreToken: number,
): GeoLibreLayer | null {
  if (restoreToken !== planetaryComputerRestoreToken || control !== planetaryComputerControl) {
    return null;
  }

  const currentLayer = useAppStore.getState().layers.find((candidate) => candidate.id === layer.id);
  if (!currentLayer || !isPlanetaryComputerLayer(currentLayer)) return null;
  if (!hasSamePlanetaryComputerRestoreSource(currentLayer, layer)) {
    return null;
  }

  return currentLayer;
}

function currentStoreLayerMatchesPlanetaryComputerRestore(restoredLayer: GeoLibreLayer): boolean {
  const currentLayer = useAppStore
    .getState()
    .layers.find((candidate) => candidate.id === restoredLayer.id);
  return (
    !!currentLayer &&
    isPlanetaryComputerLayer(currentLayer) &&
    hasSamePlanetaryComputerRestoreSource(currentLayer, restoredLayer)
  );
}

function hasSamePlanetaryComputerRestoreSource(
  currentLayer: GeoLibreLayer,
  restoredLayer: GeoLibreLayer,
): boolean {
  return (
    stringMetadata(currentLayer, "stacCollectionId") ===
      stringMetadata(restoredLayer, "stacCollectionId") &&
    stringMetadata(currentLayer, "stacItemId") === stringMetadata(restoredLayer, "stacItemId") &&
    stringMetadata(currentLayer, "planetaryComputerLayerType") ===
      stringMetadata(restoredLayer, "planetaryComputerLayerType") &&
    JSON.stringify(currentLayer.metadata.stacSearchParams) ===
      JSON.stringify(restoredLayer.metadata.stacSearchParams)
  );
}

function runWithPlanetaryComputerStoreSyncSuspended<T>(callback: () => T): T {
  planetaryComputerStoreSyncSuspended += 1;
  try {
    return callback();
  } finally {
    planetaryComputerStoreSyncSuspended -= 1;
  }
}

function nextRenderedStoreLayerId(
  map: NonNullable<ReturnType<PlanetaryComputerControl["getMap"]>>,
  layerId: string,
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
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  return [...nativeLayerIds, layer.id];
}

// ----- Programmatic entry points ---------------------------------------------
// Used by the AI Assistant's STAC tools and by the panel's own hand-offs, so a
// layer added from anywhere is the same control-owned layer the panel lists and
// can restyle, instead of a disconnected XYZ tile layer.

/** Search filters shared by the programmatic Planetary Computer entry points. */
export interface PlanetaryComputerSearchInput {
  /** STAC collection id, e.g. `sentinel-2-l2a`. */
  collection: string;
  /** `[west, south, east, north]` in WGS84 degrees. */
  bbox?: [number, number, number, number];
  /** RFC 3339 datetime or `start/end` range. */
  datetime?: string;
  /** Keep only items at or below this `eo:cloud_cover` percentage. */
  maxCloudCover?: number;
  /** Maximum number of items to return. */
  limit?: number;
  /** Sort order; defaults to newest first. */
  sortBy?: "newest" | "oldest" | "least-cloudy";
}

/**
 * Builds STAC search parameters from the simple filters the entry points take.
 *
 * @param input - The search filters.
 * @returns The STAC search parameters.
 */
export function planetaryComputerSearchParams(
  input: PlanetaryComputerSearchInput,
): STACSearchParams {
  const params: STACSearchParams = { collections: [input.collection] };
  if (input.bbox) params.bbox = input.bbox;
  if (input.datetime) params.datetime = input.datetime;
  if (input.limit !== undefined) params.limit = input.limit;
  if (input.maxCloudCover !== undefined && input.maxCloudCover < 100) {
    params.query = { "eo:cloud_cover": { lte: input.maxCloudCover } };
  }
  params.sortby =
    input.sortBy === "least-cloudy"
      ? [{ field: "properties.eo:cloud_cover", direction: "asc" }]
      : [{ field: "properties.datetime", direction: input.sortBy === "oldest" ? "asc" : "desc" }];
  return params;
}

/**
 * Searches the Planetary Computer STAC API.
 *
 * Each call uses a client of its own: the library's client aborts its previous
 * search when a new one starts, so a shared one would let the panel, or two
 * assistant tool calls running at once, cancel each other.
 *
 * @param input - The search filters.
 * @returns The matching STAC items.
 */
export async function searchPlanetaryComputerItems(
  input: PlanetaryComputerSearchInput,
): Promise<STACItem[]> {
  const module = await loadPlanetaryComputerModule();
  const client = new module.STACClient(
    PLANETARY_COMPUTER_STAC_URL,
    planetaryComputerStacClientOptions(),
  );
  return client.search(planetaryComputerSearchParams(input));
}

/** Render options accepted by the programmatic add entry points. */
export interface PlanetaryComputerStyleInput {
  /** Name of a built-in render preset for the collection, e.g. `ndvi`. */
  presetName?: string;
  /** Explicit Data API render parameters; wins over `presetName`. */
  renderParams?: TileParams;
  /** Layer name shown in the Layers panel; defaults to the item id or collection title. */
  name?: string;
}

/** What a programmatic add produced. */
export interface PlanetaryComputerAddResult {
  /** Id of the layer in the GeoLibre store. */
  layerId: string;
  /** `[west, south, east, north]` extent of the layer, when known. */
  bounds?: [number, number, number, number];
  /** The item drawn (item layers only). */
  item?: STACItem;
  /** True when the layer is a plain XYZ tile layer because the active renderer cannot host the panel. */
  tileLayerFallback?: boolean;
}

/**
 * Resolves the render options for a programmatic add.
 *
 * @param module - The loaded Planetary Computer library.
 * @param collectionId - The collection id.
 * @param style - The requested preset and/or render parameters.
 * @returns Options for the control's add methods; empty to use the default preset.
 * @throws When a named preset does not exist for the collection.
 */
function resolvePlanetaryComputerStyle(
  module: PlanetaryComputerModule,
  collectionId: string,
  style: PlanetaryComputerStyleInput,
): { presetName?: string; renderParams?: TileParams } {
  if (style.renderParams && Object.keys(style.renderParams).length > 0) {
    return { renderParams: style.renderParams, presetName: style.presetName };
  }
  if (!style.presetName) return {};
  const preset = module.getPreset(collectionId, style.presetName);
  if (!preset) {
    const available = module
      .getPresetsForCollection(collectionId)
      .map((candidate) => candidate.name);
    throw new Error(
      available.length
        ? `Unknown preset "${style.presetName}" for ${collectionId}. Available: ${available.join(", ")}.`
        : `${collectionId} has no render presets; pass render parameters instead.`,
    );
  }
  return { presetName: preset.name, renderParams: { ...preset.params } };
}

/**
 * Adds one Planetary Computer STAC item to the map as a panel-owned layer.
 *
 * The layer is created through the panel's control (mounted hidden when the
 * panel is closed), so it appears in the panel's Layers tab, can be restyled
 * there, and is restored when the project is reopened. On a renderer that
 * cannot host the panel the item is added as a plain XYZ tile layer instead.
 *
 * @param app - The GeoLibre app API.
 * @param input - The collection and item (an id to fetch, or the item itself) plus render options.
 * @returns The added layer.
 */
export async function addPlanetaryComputerItemLayer(
  app: GeoLibreAppAPI,
  input: PlanetaryComputerStyleInput & {
    collection: string;
    itemId?: string;
    item?: STACItem;
  },
): Promise<PlanetaryComputerAddResult> {
  const module = await loadPlanetaryComputerModule();
  let item = input.item;
  if (!item) {
    if (!input.itemId) throw new Error("An item or item id is required.");
    item = await getPlanetaryComputerStacClient(module).getItem(input.collection, input.itemId);
  }
  item = { ...item, collection: item.collection || input.collection };
  const style = resolvePlanetaryComputerStyle(module, input.collection, input);
  const bounds = boundsTuple(item.bbox);
  const name = input.name?.trim();

  const control = await ensurePlanetaryComputerControl(app);
  if (!control) {
    const params = style.renderParams ?? module.getDefaultPreset(input.collection)?.params ?? {};
    const tileUrl = getPlanetaryComputerTilerClient(module).getItemTileUrl(
      input.collection,
      item.id,
      params,
    );
    const layerId = app.addTileLayer?.(name || item.id, tileUrl, {
      attribution: "Microsoft Planetary Computer",
      ...(bounds ? { bounds } : {}),
      metadata: { stacCollectionId: input.collection, stacItemId: item.id },
    });
    if (!layerId) throw new Error("The active map cannot add tile layers.");
    return { layerId, item, tileLayerFallback: true, ...(bounds ? { bounds } : {}) };
  }

  const layer = control.addItemLayer(item, style);
  if (name) useAppStore.getState().updateLayer(layer.id, { name });
  return { layerId: layer.id, item, ...(bounds ? { bounds } : {}) };
}

/**
 * Adds a Planetary Computer mosaic to the map as a panel-owned layer: every
 * item of a collection that matches the search, composited into one layer.
 *
 * @param app - The GeoLibre app API.
 * @param input - The collection, the search selecting its items, and render options.
 * @returns The added layer.
 * @throws When the active renderer cannot host the panel (a mosaic has no XYZ fallback
 *   worth offering: its search id expires, so it could not be restored).
 */
export async function addPlanetaryComputerMosaicLayer(
  app: GeoLibreAppAPI,
  input: PlanetaryComputerStyleInput & PlanetaryComputerSearchInput,
): Promise<PlanetaryComputerAddResult> {
  const module = await loadPlanetaryComputerModule();
  const style = resolvePlanetaryComputerStyle(module, input.collection, input);
  const control = await ensurePlanetaryComputerControl(app);
  if (!control) {
    throw new Error("Planetary Computer mosaics need the MapLibre renderer.");
  }

  const collection = await getPlanetaryComputerStacClient(module).getCollection(input.collection);
  const { bbox, limit: _limit, ...searchParams } = planetaryComputerSearchParams(input);
  const layer = await control.addMosaicLayer(collection, { ...style, searchParams, bbox });
  const name = input.name?.trim();
  if (name) useAppStore.getState().updateLayer(layer.id, { name });
  return { layerId: layer.id, ...(layer.bounds ? { bounds: layer.bounds } : {}) };
}

/** One band value read at a point. */
export interface PlanetaryComputerPixelValue {
  /** Band or expression name reported by the Data API. */
  name: string;
  /** The value, or null where the pixel is nodata. */
  value: number | null;
}

/** Pixel values of a Planetary Computer layer at a point. */
export interface PlanetaryComputerPixelReading {
  /** Id of the STAC item the values came from (the topmost item for a mosaic). */
  itemId?: string;
  /** One entry per band of the layer's render (its assets or expression). */
  values: PlanetaryComputerPixelValue[];
}

/**
 * Whether a Data API failure only means "no data here" rather than a real error.
 *
 * @param error - The rejection from a point query.
 * @returns True for an out-of-footprint or nodata response.
 */
function isPlanetaryComputerNoDataError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /outside|out of bounds|no data|nodata|not found|no assets|empty/i.test(message);
}

/**
 * Reads the pixel values of a Planetary Computer layer at a coordinate.
 *
 * Values are the layer's own bands: the assets it renders, or the result of
 * its band-math expression. A mosaic is read from its topmost item at the point.
 *
 * @param layer - A Planetary Computer store layer.
 * @param lngLat - `[lng, lat]` in WGS84 degrees.
 * @param options - Abort signal.
 * @returns The reading, or null when the point is outside the data.
 */
export async function identifyPlanetaryComputerLayer(
  layer: GeoLibreLayer,
  lngLat: [number, number],
  options: { signal?: AbortSignal } = {},
): Promise<PlanetaryComputerPixelReading | null> {
  if (!isPlanetaryComputerLayer(layer)) return null;
  const module = await loadPlanetaryComputerModule();
  const tiler = getPlanetaryComputerTilerClient(module);
  const collectionId = stringMetadata(layer, "stacCollectionId");
  if (!collectionId) return null;

  const bounds = numberArrayMetadata(layer, "bounds");
  if (
    bounds &&
    (lngLat[0] < bounds[0] ||
      lngLat[0] > bounds[2] ||
      lngLat[1] < bounds[1] ||
      lngLat[1] > bounds[3])
  ) {
    return null;
  }

  const renderParams = tileParamsMetadata(layer, "renderParams");
  const assets = stringArrayMetadata(layer, "assets");
  const params = assets?.length ? { ...renderParams, assets } : renderParams;

  try {
    let itemId = stringMetadata(layer, "stacItemId");
    let itemCollection = collectionId;
    if (!itemId) {
      // A mosaic: find the topmost item under the point through the control's
      // registered search, then read that item.
      const active = planetaryComputerControl
        ?.getState()
        .activeLayers.find((candidate) => candidate.id === layer.id);
      if (!active?.mosaicId) return null;
      const items = await tiler.getMosaicItemsAtPoint(
        active.mosaicId,
        lngLat[0],
        lngLat[1],
        collectionId,
      );
      if (options.signal?.aborted || !items[0]) return null;
      itemId = items[0].id;
      itemCollection = items[0].collection || collectionId;
    }

    const data = await tiler.getItemPoint(itemCollection, itemId, lngLat[0], lngLat[1], params);
    if (options.signal?.aborted) return null;
    const values = Array.isArray(data.values) ? data.values : [];
    if (values.length === 0) return null;
    return {
      itemId,
      values: values.map((value, index) => ({
        name: data.band_names?.[index] || `b${index + 1}`,
        value: typeof value === "number" && Number.isFinite(value) ? value : null,
      })),
    };
  } catch (error) {
    if (isPlanetaryComputerNoDataError(error)) return null;
    throw error;
  }
}

/**
 * The live state of the panel's control, or null when it has not been created.
 *
 * @returns The control state.
 */
export function getPlanetaryComputerState(): PlanetaryComputerState | null {
  return planetaryComputerControl?.getState() ?? null;
}

/**
 * The loaded Planetary Computer library and the shared API clients, for the
 * panel's hand-off actions.
 *
 * @returns The module and clients.
 */
export async function getPlanetaryComputerClients(): Promise<{
  module: PlanetaryComputerModule;
  stac: STACClient;
  tiler: TiTilerClient;
}> {
  const module = await loadPlanetaryComputerModule();
  return {
    module,
    stac: getPlanetaryComputerStacClient(module),
    tiler: getPlanetaryComputerTilerClient(module),
  };
}

function getPlanetaryComputerStacClient(module: PlanetaryComputerModule): STACClient {
  planetaryComputerStacClient ??= new module.STACClient(
    PLANETARY_COMPUTER_STAC_URL,
    planetaryComputerStacClientOptions(),
  );
  return planetaryComputerStacClient;
}

function getPlanetaryComputerTilerClient(module: PlanetaryComputerModule): TiTilerClient {
  planetaryComputerTilerClient ??= new module.TiTilerClient();
  return planetaryComputerTilerClient;
}

/**
 * The acquisition date of a STAC item.
 *
 * @param item - The STAC item.
 * @returns Its `datetime`, else the start or end of its range, else undefined.
 */
export function planetaryComputerItemDate(item: STACItem): string | undefined {
  const { datetime, start_datetime: start, end_datetime: end } = item.properties ?? {};
  return datetime || start || end || undefined;
}

function planetaryComputerLayerName(activeLayer: ActiveLayer): string {
  if (activeLayer.item) return activeLayer.item.id;
  const title = activeLayer.collection?.title || activeLayer.collection?.id || activeLayer.id;
  const datetime = activeLayer.searchParams?.datetime;
  if (!datetime) return title;
  const range = datetime
    .split("/")
    .map((part) => (part === ".." ? "" : part.slice(0, 10)))
    .filter(Boolean)
    .join(" to ");
  return range ? `${title} (${range})` : title;
}

function patchPlanetaryComputerControlOnRemove(control: PlanetaryComputerControl): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    resetPlanetaryComputerControl(control);
  };
}

function resetPlanetaryComputerControl(control: PlanetaryComputerControl | null): void {
  if (planetaryComputerControl !== control) return;

  control?.off("layer:add", syncPlanetaryComputerLayersToStore);
  control?.off("layer:remove", syncPlanetaryComputerLayersToStore);
  control?.off("layer:update", syncPlanetaryComputerLayersToStore);
  planetaryComputerStoreUnsubscribe?.();
  planetaryComputerStoreUnsubscribe = null;
  planetaryComputerControlMounted = false;
  planetaryComputerControl = null;
}

function hidePlanetaryComputerControl(control: PlanetaryComputerControl | null): void {
  const container = control?.getContainer();
  const panel = control?.getPanelElement();
  if (container) container.style.display = "none";
  if (panel) panel.style.display = "none";
}

function showPlanetaryComputerControl(control: PlanetaryComputerControl | null): void {
  const container = control?.getContainer();
  const panel = control?.getPanelElement();
  if (container) container.style.display = "";
  if (panel) panel.style.display = "";
}

type PlanetaryComputerRestoreFailure = {
  id: string;
  name: string;
};

class InvalidPlanetaryComputerLayerMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPlanetaryComputerLayerMetadataError";
  }
}

function isInvalidPlanetaryComputerLayerMetadataError(error: unknown): boolean {
  return error instanceof InvalidPlanetaryComputerLayerMetadataError;
}

function stringMetadata(layer: GeoLibreLayer, key: string): string | undefined {
  const value = layer.metadata[key];
  return typeof value === "string" && value ? value : undefined;
}

function stringArrayMetadata(layer: GeoLibreLayer, key: string): string[] | undefined {
  const value = layer.metadata[key];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function numberArrayMetadata(
  layer: GeoLibreLayer,
  key: string,
): [number, number, number, number] | undefined {
  const value = layer.metadata[key];
  return boundsTuple(value);
}

function tileParamsMetadata(layer: GeoLibreLayer, key: string): TileParams {
  const value = layer.metadata[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as TileParams) : {};
}

function searchParamsMetadata(layer: GeoLibreLayer, key: string): Partial<STACSearchParams> {
  const value = layer.metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  // Only the fields a mosaic search uses; a hand-edited project cannot smuggle
  // anything else into the registration request.
  const candidate = value as Partial<STACSearchParams>;
  const params: Partial<STACSearchParams> = {};
  if (typeof candidate.datetime === "string") params.datetime = candidate.datetime;
  if (candidate.query && typeof candidate.query === "object") params.query = candidate.query;
  if (Array.isArray(candidate.sortby)) params.sortby = candidate.sortby;
  if (candidate.filter && typeof candidate.filter === "object") params.filter = candidate.filter;
  return params;
}

function boundsTuple(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number")) return undefined;
  if (value.length === 4) return value as [number, number, number, number];
  // A 3D STAC bbox is [west, south, minz, east, north, maxz].
  if (value.length === 6) return [value[0], value[1], value[3], value[4]];
  return undefined;
}
