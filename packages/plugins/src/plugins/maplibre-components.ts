import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type {
  AddVectorControl,
  AddVectorEventHandler,
  AddVectorLayerInfo,
  AddVectorControlOptions,
  ControlGrid,
  ControlGridOptions,
  DefaultControlName,
} from "maplibre-gl-components";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

type ControlGridConstructor =
  (typeof import("maplibre-gl-components"))["ControlGrid"];
type AddVectorControlConstructor =
  (typeof import("maplibre-gl-components"))["AddVectorControl"];

interface ComponentsConstructors {
  AddVectorControl: AddVectorControlConstructor;
  ControlGrid: ControlGridConstructor;
}

let componentsControlPosition: GeoLibreMapControlPosition = "top-right";
const flatGeobufControlPosition: GeoLibreMapControlPosition = "top-left";

const FLATGEOBUF_SAMPLE_URL =
  "https://flatgeobuf.org/test/data/UScounties.fgb";

const COMPONENT_CONTROL_NAMES = [
  "spinGlobe",
  "fullscreen",
  "north",
  "terrain",
  "search",
  "viewState",
  "inspect",
  "vectorDataset",
  "basemap",
  "measure",
  "geoEditor",
  "bookmark",
  "print",
  "swipe",
  "streetView",
  "addVector",
  "cogLayer",
  "zarrLayer",
  "pmtilesLayer",
  "stacLayer",
  "stacSearch",
  "planetaryComputer",
  "gaussianSplat",
  "lidar",
  "usgsLidar",
] satisfies DefaultControlName[];

const COMPONENTS_OPTIONS = {
  className: "geolibre-components-control",
  collapsed: false,
  columns: 5,
  defaultControls: COMPONENT_CONTROL_NAMES,
  excludeLayers: [
    "usgs-lidar-*",
    "lidar-*",
    "mapbox-gl-draw-*",
    "gl-draw-*",
    "gm_*",
    "inspect-highlight-*",
    "measure-*",
  ],
  gap: 2,
  rows: 5,
  showRowColumnControls: true,
} satisfies Omit<ControlGridOptions, "position" | "basemapStyleUrl">;

const ADD_VECTOR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-flatgeobuf-control",
  collapsed: false,
  defaultFormat: "flatgeobuf",
  defaultPickable: false,
  defaultUrl: FLATGEOBUF_SAMPLE_URL,
  fontColor: "hsl(var(--popover-foreground))",
} satisfies AddVectorControlOptions;

let componentsControl: ControlGrid | null = null;
let flatGeobufControl: AddVectorControl | null = null;
let flatGeobufControlMounted = false;
let flatGeobufStoreUnsubscribe: (() => void) | null = null;
let pluginActive = false;
let componentsControlRevision = 0;
let componentsConstructorsPromise: Promise<ComponentsConstructors> | null =
  null;

const getComponentsConstructors = (): Promise<ComponentsConstructors> => {
  componentsConstructorsPromise ??= import("maplibre-gl-components").then(
    ({
      AddVectorControl: AddVectorControlClass,
      ControlGrid: ControlGridClass,
    }) => ({
      AddVectorControl: AddVectorControlClass,
      ControlGrid: ControlGridClass,
    }),
  );
  return componentsConstructorsPromise;
};

const createComponentsControl = async (
  app: GeoLibreAppAPI,
): Promise<ControlGrid | null> => {
  const { ControlGrid: ControlGridClass } = await getComponentsConstructors();
  if (!pluginActive) return null;
  return new ControlGridClass(getComponentsOptions(app));
};

const createAndMountComponentsControl = (app: GeoLibreAppAPI): void => {
  const revision = ++componentsControlRevision;
  void createComponentsControl(app).then((control) => {
    if (
      !pluginActive ||
      componentsControl ||
      !control ||
      revision !== componentsControlRevision
    ) {
      return;
    }
    componentsControl = control;
    mountComponentsControl(app);
  });
};

const mountComponentsControl = (app: GeoLibreAppAPI): boolean => {
  if (!componentsControl) return false;
  const added = app.addMapControl(
    componentsControl,
    componentsControlPosition,
  );
  if (!added) {
    componentsControl = null;
    return false;
  }
  setTimeout(() => componentsControl?.expand(), 0);
  return true;
};

export const maplibreComponentsPlugin: GeoLibrePlugin = {
  id: "maplibre-gl-components",
  name: "Components",
  version: "0.16.3",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    if (componentsControl) return mountComponentsControl(app);
    createAndMountComponentsControl(app);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    componentsControlRevision += 1;
    teardownFlatGeobufControl(app);
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
  },
  getMapControlPosition: () => componentsControlPosition,
  setMapControlPosition: (
    app: GeoLibreAppAPI,
    position: GeoLibreMapControlPosition,
  ) => {
    componentsControlPosition = position;
    if (!componentsControl) return;
    app.removeMapControl(componentsControl);
    componentsControl = null;
    createAndMountComponentsControl(app);
  },
};

export function openFlatGeobufAddVectorLayerPanel(
  app: GeoLibreAppAPI,
): void {
  void openStandaloneFlatGeobufControl(app);
}

function getComponentsOptions(
  app: GeoLibreAppAPI,
): ControlGridOptions {
  return {
    ...COMPONENTS_OPTIONS,
    basemapStyleUrl: app.getActiveBasemap(),
    position: componentsControlPosition,
  };
}

async function openStandaloneFlatGeobufControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { AddVectorControl: AddVectorControlClass } =
    await getComponentsConstructors();

  flatGeobufControl ??= createFlatGeobufControl(AddVectorControlClass);

  if (!flatGeobufControlMounted) {
    const added = app.addMapControl(
      flatGeobufControl,
      flatGeobufControlPosition,
    );
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
        isFlatGeobufControlLayer(layer) &&
        !state.layers.some((current) => current.id === layer.id),
    );
    for (const layer of removedLayers) {
      flatGeobufControl?.removeLayer(layer.id);
    }
  });
  return control;
}

function teardownFlatGeobufControl(app: GeoLibreAppAPI): void {
  flatGeobufStoreUnsubscribe?.();
  flatGeobufStoreUnsubscribe = null;
  if (flatGeobufControl && flatGeobufControlMounted) {
    app.removeMapControl(flatGeobufControl);
  }
  flatGeobufControl = null;
  flatGeobufControlMounted = false;
}

function createFlatGeobufLayerAddHandler(
  control: AddVectorControl,
): AddVectorEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createFlatGeobufStoreLayer(event.layerId, layerInfo, control);
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

function createFlatGeobufStoreLayer(
  id: string,
  layerInfo: AddVectorLayerInfo,
  control: AddVectorControl,
): GeoLibreLayer {
  const nativeLayerIds = control
    .getLayerIds()
    .filter((layerId) => layerInfo.layerIds.includes(layerId));
  const url = layerInfo.url;

  return {
    id,
    name: layerNameFromUrl(url, id),
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

function layerNameFromUrl(url: string, fallback: string): string {
  try {
    const fileName = new URL(url).pathname.split("/").pop() ?? fallback;
    return fileName.replace(/\.[^.]+$/, "") || fallback;
  } catch {
    return fallback;
  }
}
