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
} from "maplibre-gl-planetary-computer";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../types";

type PlanetaryComputerControlConstructor =
  (typeof import("maplibre-gl-planetary-computer"))["PlanetaryComputerControl"];

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
}> | null = null;
let planetaryComputerStoreUnsubscribe: (() => void) | null = null;

export function openPlanetaryComputerPanel(app: GeoLibreAppAPI): void {
  void openStandalonePlanetaryComputerControl(app);
}

async function openStandalonePlanetaryComputerControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { PlanetaryComputerControl: PlanetaryComputerControlClass } =
    await getPlanetaryComputerConstructors();

  planetaryComputerControl ??= createPlanetaryComputerControl(
    PlanetaryComputerControlClass,
  );

  if (!planetaryComputerControlMounted) {
    const added = app.addMapControl(
      planetaryComputerControl,
      planetaryComputerControlPosition,
    );
    if (!added) {
      resetPlanetaryComputerControl(planetaryComputerControl);
      return false;
    }
    planetaryComputerControlMounted = true;
  }

  setTimeout(() => {
    showPlanetaryComputerControl(planetaryComputerControl);
    planetaryComputerControl?.expand();
  }, 0);
  return true;
}

function getPlanetaryComputerConstructors(): Promise<{
  PlanetaryComputerControl: PlanetaryComputerControlConstructor;
}> {
  planetaryComputerConstructorsPromise ??= import(
    "maplibre-gl-planetary-computer"
  ).then(({ PlanetaryComputerControl: PlanetaryComputerControlClass }) => ({
    PlanetaryComputerControl: PlanetaryComputerControlClass,
  }));
  return planetaryComputerConstructorsPromise;
}

function createPlanetaryComputerControl(
  PlanetaryComputerControlClass: PlanetaryComputerControlConstructor,
): PlanetaryComputerControl {
  const control = new PlanetaryComputerControlClass(PLANETARY_COMPUTER_OPTIONS);
  patchPlanetaryComputerControlOnRemove(control);
  control.on("collapse", () => hidePlanetaryComputerControl(control));
  control.on("layer:add", syncPlanetaryComputerLayersToStore);
  control.on("layer:remove", syncPlanetaryComputerLayersToStore);
  control.on("layer:update", syncPlanetaryComputerLayersToStore);

  // updateLayer stores the passed visible/opacity values verbatim before
  // re-emitting "layer:update" (verified against
  // maplibre-gl-planetary-computer 0.3.0), so the equality checks here and
  // in syncPlanetaryComputerLayersToStore break the store <-> control
  // feedback cycle.
  planetaryComputerStoreUnsubscribe ??= useAppStore.subscribe(
    (state, previous) => {
      const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

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
    },
  );

  return control;
}

function syncPlanetaryComputerLayersToStore(
  event: PlanetaryComputerEventData,
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
      if (
        existing.visible !== layer.visible ||
        existing.opacity !== layer.opacity ||
        existing.name !== layer.name
      ) {
        useAppStore.getState().updateLayer(layer.id, {
          name: layer.name,
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
  activeLayer: ActiveLayer,
): GeoLibreLayer {
  const bbox =
    activeLayer.item?.bbox ?? activeLayer.collection?.extent?.spatial?.bbox?.[0];
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

function planetaryComputerLayerName(activeLayer: ActiveLayer): string {
  if (activeLayer.item) return activeLayer.item.id;
  if (activeLayer.collection) {
    return activeLayer.collection.title || activeLayer.collection.id;
  }
  return activeLayer.id;
}

function patchPlanetaryComputerControlOnRemove(
  control: PlanetaryComputerControl,
): void {
  const originalOnRemove = control.onRemove.bind(control);
  control.onRemove = () => {
    originalOnRemove();
    resetPlanetaryComputerControl(control);
  };
}

function resetPlanetaryComputerControl(
  control: PlanetaryComputerControl | null,
): void {
  if (planetaryComputerControl !== control) return;

  planetaryComputerStoreUnsubscribe?.();
  planetaryComputerStoreUnsubscribe = null;
  planetaryComputerControlMounted = false;
  planetaryComputerControl = null;
}

function hidePlanetaryComputerControl(
  control: PlanetaryComputerControl | null,
): void {
  const container = control?.getContainer();
  const panel = control?.getPanelElement();
  if (container) container.style.display = "none";
  if (panel) panel.style.display = "none";
}

function showPlanetaryComputerControl(
  control: PlanetaryComputerControl | null,
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
