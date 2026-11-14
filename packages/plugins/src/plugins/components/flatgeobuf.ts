// The standalone FlatGeobuf (AddVectorControl) panel.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type {
  AddVectorControl,
  AddVectorControlOptions,
  AddVectorEventHandler,
  AddVectorLayerInfo,
} from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import { type AddVectorControlConstructor, getComponentsConstructors } from "./constructors";
import { layerNameFromUrl } from "./shared";

const flatGeobufControlPosition: GeoLibreMapControlPosition = "top-left";

const FLATGEOBUF_SAMPLE_URL = "https://flatgeobuf.org/test/data/UScounties.fgb";

const ADD_VECTOR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-flatgeobuf-control",
  collapsed: false,
  defaultFormat: "flatgeobuf",
  defaultPickable: false,
  sampleData: [{ label: "US counties", url: FLATGEOBUF_SAMPLE_URL }],
  fontColor: "hsl(var(--popover-foreground))",
} satisfies AddVectorControlOptions;

let flatGeobufControl: AddVectorControl | null = null;
let flatGeobufControlMounted = false;
let flatGeobufStoreUnsubscribe: (() => void) | null = null;

export function openFlatGeobufAddVectorLayerPanel(app: GeoLibreAppAPI): void {
  const renderer = app.getMapRenderer?.();
  // eslint-disable-next-line local/no-renderer-kind-checks -- picks the engine's own adapter
  if (renderer === "mapbox" || renderer === "arcgis") {
    // The vector importer materializes FlatGeobuf into the shared layer store.
    // The standalone control owns MapLibre layers outside that bridge.
    void import("../maplibre-vector")
      .then(({ openVectorLayerPanel }) => openVectorLayerPanel(app))
      .catch((error) => {
        console.error("[GeoLibre] Failed to open the vector layer panel", error);
      });
    return;
  }
  void openStandaloneFlatGeobufControl(app);
}

async function openStandaloneFlatGeobufControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { AddVectorControl: AddVectorControlClass } = await getComponentsConstructors();

  flatGeobufControl ??= createFlatGeobufControl(AddVectorControlClass);

  if (!flatGeobufControlMounted) {
    const added = app.addMapControl(flatGeobufControl, flatGeobufControlPosition);
    if (!added) {
      flatGeobufControl = null;
      return false;
    }
    flatGeobufControlMounted = true;
  }

  setTimeout(() => {
    flatGeobufControl?.show();
    flatGeobufControl?.expand();
  }, 0);
  return true;
}

function createFlatGeobufControl(
  AddVectorControlClass: AddVectorControlConstructor,
): AddVectorControl {
  const control = new AddVectorControlClass(ADD_VECTOR_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("layeradd", createFlatGeobufLayerAddHandler(control));
  control.on("layerremove", (event) => {
    if (!event.layerId) return;
    const store = useAppStore.getState();
    if (store.layers.some((layer) => layer.id === event.layerId)) {
      store.removeLayer(event.layerId);
    }
  });
  flatGeobufStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const removedLayers = previous.layers.filter(
      (layer) =>
        isFlatGeobufControlLayer(layer) && !state.layers.some((current) => current.id === layer.id),
    );
    for (const layer of removedLayers) {
      flatGeobufControl?.removeLayer(layer.id);
    }
  });
  return control;
}

export function teardownFlatGeobufControl(app: GeoLibreAppAPI): void {
  flatGeobufStoreUnsubscribe?.();
  flatGeobufStoreUnsubscribe = null;
  if (flatGeobufControl && flatGeobufControlMounted) {
    app.removeMapControl(flatGeobufControl);
  }
  flatGeobufControl = null;
  flatGeobufControlMounted = false;
}

function createFlatGeobufLayerAddHandler(control: AddVectorControl): AddVectorEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find((layer) => layer.id === event.layerId);
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const name = flatGeobufLayerName(layerInfo, event.state.layerName);
    const layer = createFlatGeobufStoreLayer(event.layerId, layerInfo, control, name);
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

/**
 * Picks the store name for a layer the FlatGeobuf panel just added.
 *
 * The panel's Layer Name field is not carried on the layer info: upstream uses
 * the typed name as the layer id instead (falling back to the URL's file name,
 * then a generated id). So the typed name wins when it is the id the layer got;
 * otherwise the name comes from the URL as before.
 *
 * @param layerInfo - The upstream layer info for the added layer.
 * @param typedName - The panel's Layer Name field at the time of the add.
 * @returns The display name for the GeoLibre layer.
 */
export function flatGeobufLayerName(layerInfo: AddVectorLayerInfo, typedName?: string): string {
  const customName = typedName?.trim();
  if (customName && customName === layerInfo.id) return customName;
  return layerNameFromUrl(layerInfo.url, layerInfo.id);
}

function createFlatGeobufStoreLayer(
  id: string,
  layerInfo: AddVectorLayerInfo,
  control: AddVectorControl,
  name: string,
): GeoLibreLayer {
  const nativeLayerIds = control
    .getLayerIds()
    .filter((layerId) => layerInfo.layerIds.includes(layerId));
  const url = layerInfo.url;

  return {
    id,
    name,
    type: "flatgeobuf",
    source: {
      type: "geojson",
      url,
      sourceId: layerInfo.sourceId,
    },
    visible: true,
    opacity: layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
      fillColor: layerInfo.fillColor,
      strokeColor: layerInfo.strokeColor,
    },
    metadata: {
      externalNativeLayer: true,
      featureCount: layerInfo.featureCount,
      format: layerInfo.format,
      geometryTypes: layerInfo.geometryTypes,
      nativeLayerIds,
      sourceId: layerInfo.sourceId,
      sourceKind: "flatgeobuf-url",
    },
    sourcePath: url,
  };
}

function isFlatGeobufControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "flatgeobuf" &&
    layer.metadata.sourceKind === "flatgeobuf-url" &&
    layer.metadata.externalNativeLayer === true
  );
}
