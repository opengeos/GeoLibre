import {
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  useAppStore,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { MapboxOverlay } from "@deck.gl/mapbox";
import {
  extractGeotiffReprojectors,
  proj,
} from "@developmentseed/deck.gl-geotiff";
import {
  RasterLayer,
  type RasterLayerProps,
} from "@developmentseed/deck.gl-raster";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";
import type {
  AddVectorControl,
  AddVectorEventHandler,
  AddVectorLayerInfo,
  AddVectorControlOptions,
  CogLayerControl,
  CogLayerControlOptions,
  CogLayerEventHandler,
  CogLayerInfo,
  ControlGrid,
  ControlGridOptions,
  DefaultControlName,
  LidarControl,
  LidarLayerAdapter,
  PMTilesLayerControl,
  PMTilesLayerControlOptions,
  PMTilesLayerEventHandler,
  PMTilesLayerInfo,
  ZarrLayerControl,
  ZarrLayerControlOptions,
  ZarrLayerEventHandler,
  ZarrLayerInfo,
} from "maplibre-gl-components";
import type {
  LidarControlEventHandler,
  PointCloudInfo,
} from "maplibre-gl-lidar";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "../types";

type ControlGridConstructor =
  (typeof import("maplibre-gl-components"))["ControlGrid"];
type AddVectorControlConstructor =
  (typeof import("maplibre-gl-components"))["AddVectorControl"];
type CogLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["CogLayerControl"];
type PMTilesLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["PMTilesLayerControl"];
type ZarrLayerControlConstructor =
  (typeof import("maplibre-gl-components"))["ZarrLayerControl"];
type LidarControlConstructor =
  (typeof import("maplibre-gl-components"))["LidarControl"];
type LidarLayerAdapterConstructor =
  (typeof import("maplibre-gl-components"))["LidarLayerAdapter"];

interface LidarControlClickOutsideState {
  _clickOutsideHandler?: ((event: MouseEvent) => void) | null;
}

interface ComponentsConstructors {
  AddVectorControl: AddVectorControlConstructor;
  CogLayerControl: CogLayerControlConstructor;
  ControlGrid: ControlGridConstructor;
  LidarControl: LidarControlConstructor;
  LidarLayerAdapter: LidarLayerAdapterConstructor;
  PMTilesLayerControl: PMTilesLayerControlConstructor;
  ZarrLayerControl: ZarrLayerControlConstructor;
}

let componentsControlPosition: GeoLibreMapControlPosition = "top-right";
const cogRasterControlPosition: GeoLibreMapControlPosition = "top-left";
const flatGeobufControlPosition: GeoLibreMapControlPosition = "top-left";
const pmtilesControlPosition: GeoLibreMapControlPosition = "top-left";
const zarrControlPosition: GeoLibreMapControlPosition = "top-left";
const lidarControlPosition: GeoLibreMapControlPosition = "top-left";

const FLATGEOBUF_SAMPLE_URL =
  "https://flatgeobuf.org/test/data/UScounties.fgb";
const PMTILES_SAMPLE_URL =
  "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-05-20.0/buildings.pmtiles";
const ZARR_SAMPLE_URL =
  "https://carbonplan-maps.s3.us-west-2.amazonaws.com/v2/demo/4d/tavg-prec-month";
const LIDAR_SAMPLE_URL =
  "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";

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

const COG_RASTER_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-cog-raster-control",
  collapsed: true,
  defaultBands: "1",
  defaultColormap: "none",
  defaultOpacity: 1,
  defaultPickable: false,
  defaultRescaleMax: 255,
  defaultRescaleMin: 0,
  fontColor: "hsl(var(--popover-foreground))",
  visible: false,
} satisfies CogLayerControlOptions;

const PMTILES_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-pmtiles-control",
  collapsed: false,
  defaultCircleColor: DEFAULT_LAYER_STYLE.fillColor,
  defaultFillColor: DEFAULT_LAYER_STYLE.fillColor,
  defaultLineColor: DEFAULT_LAYER_STYLE.strokeColor,
  defaultOpacity: 0.8,
  defaultPickable: false,
  defaultUrl: PMTILES_SAMPLE_URL,
  fontColor: "hsl(var(--popover-foreground))",
} satisfies PMTilesLayerControlOptions;

const ZARR_OPTIONS = {
  backgroundColor: "hsl(var(--popover))",
  className: "geolibre-zarr-control",
  collapsed: false,
  defaultClim: [0, 300],
  defaultColormap: [
    "#f7fbff",
    "#deebf7",
    "#c6dbef",
    "#9ecae1",
    "#6baed6",
    "#4292c6",
    "#2171b5",
    "#08519c",
    "#08306b",
  ],
  defaultOpacity: 0.85,
  defaultPickable: false,
  defaultSelector: { band: "prec", month: 1 },
  defaultUrl: ZARR_SAMPLE_URL,
  defaultVariable: "climate",
  fontColor: "hsl(var(--popover-foreground))",
} satisfies ZarrLayerControlOptions;

const LIDAR_OPTIONS = {
  title: "Add LiDAR Layer",
  collapsed: false,
  className: "geolibre-lidar-layer-control",
  panelWidth: 365,
  maxHeight: 520,
  pointSize: 2,
  colorScheme: "elevation",
  pickable: false,
  autoZoom: true,
} satisfies ConstructorParameters<LidarControlConstructor>[0];

let componentsControl: ControlGrid | null = null;
let cogRasterControl: CogLayerControl | null = null;
let flatGeobufControl: AddVectorControl | null = null;
let pmtilesControl: PMTilesLayerControl | null = null;
let zarrControl: ZarrLayerControl | null = null;
let lidarControl: LidarControl | null = null;
let lidarLayerAdapter: LidarLayerAdapter | null = null;
let geoTiffRasterOverlay: MapboxOverlay | null = null;
let flatGeobufControlMounted = false;
let cogRasterControlMounted = false;
let geoTiffRasterOverlayMounted = false;
let pmtilesControlMounted = false;
let zarrControlMounted = false;
let lidarControlMounted = false;
let flatGeobufStoreUnsubscribe: (() => void) | null = null;
let cogRasterStoreUnsubscribe: (() => void) | null = null;
let geoTiffRasterStoreUnsubscribe: (() => void) | null = null;
let pmtilesStoreUnsubscribe: (() => void) | null = null;
let zarrStoreUnsubscribe: (() => void) | null = null;
let lidarStoreUnsubscribe: (() => void) | null = null;
let pluginActive = false;
let componentsControlRevision = 0;
let componentsConstructorsPromise: Promise<ComponentsConstructors> | null =
  null;

export interface CogRasterLayerOptions {
  url: string;
  name?: string;
  bands?: string;
  colormap?: CogLayerControlOptions["defaultColormap"];
  rescaleMin?: number;
  rescaleMax?: number;
  nodata?: number;
  opacity?: number;
  beforeLayerId?: string | null;
}

type MutableCogLayerControl = {
  _options?: CogLayerControlOptions;
  _render?: () => void;
  _state?: {
    bands: string;
    colormap: CogLayerControlOptions["defaultColormap"];
    layerName: string;
    layerOpacity: number;
    nodata: number | undefined;
    pickable: boolean;
    rescaleMax: number;
    rescaleMin: number;
    url: string;
  };
};

const pendingCogRasterLayerOptions: CogRasterLayerOptions[] = [];
const ignoredCogRasterLayerUrls = new Set<string>();
const geoTiffRasterLayerProps = new Map<string, GeoTiffRasterLayerState>();
const geoTiffRasterLayers = new Map<string, Layer>();
let geoTiffRasterLayerSequence = 0;

interface GeoTiffRasterLayerState {
  bounds?: [number, number, number, number];
  id: string;
  raster: GeoTiffRasterData;
  name: string;
  opacity: number;
  options: CogRasterLayerOptions;
  url: string;
  visible: boolean;
}

interface GeoTiffRasterData {
  height: number;
  image: ImageData;
  reprojectionFns: RasterLayerProps["reprojectionFns"];
  width: number;
}

type RasterBandValues =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array;

const getComponentsConstructors = (): Promise<ComponentsConstructors> => {
  componentsConstructorsPromise ??= import("maplibre-gl-components").then(
    ({
      AddVectorControl: AddVectorControlClass,
      CogLayerControl: CogLayerControlClass,
      ControlGrid: ControlGridClass,
      LidarControl: LidarControlClass,
      LidarLayerAdapter: LidarLayerAdapterClass,
      PMTilesLayerControl: PMTilesLayerControlClass,
      ZarrLayerControl: ZarrLayerControlClass,
    }) => ({
      AddVectorControl: AddVectorControlClass,
      CogLayerControl: CogLayerControlClass,
      ControlGrid: ControlGridClass,
      LidarControl: LidarControlClass,
      LidarLayerAdapter: LidarLayerAdapterClass,
      PMTilesLayerControl: PMTilesLayerControlClass,
      ZarrLayerControl: ZarrLayerControlClass,
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
  version: "0.17.1",
  activate: (app: GeoLibreAppAPI) => {
    pluginActive = true;
    if (componentsControl) return mountComponentsControl(app);
    createAndMountComponentsControl(app);
  },
  deactivate: (app: GeoLibreAppAPI) => {
    pluginActive = false;
    componentsControlRevision += 1;
    teardownCogRasterControl(app);
    teardownGeoTiffRasterOverlay(app);
    teardownFlatGeobufControl(app);
    teardownPMTilesControl(app);
    teardownZarrControl(app);
    teardownLidarControl(app);
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

export async function addCogRasterLayer(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
): Promise<string> {
  if (shouldUseGenericGeoTiffRenderer(options.url)) {
    return addGeoTiffRasterLayer(app, options);
  }

  const control = await ensureCogRasterControl(app);
  if (!control) {
    throw new Error("The COG raster layer control could not be added to the map.");
  }

  try {
    return await addLayerWithCogRasterControl(control, options);
  } catch (error) {
    return addGeoTiffRasterLayer(app, options, error);
  }
}

export function openPMTilesLayerPanel(app: GeoLibreAppAPI): void {
  void openStandalonePMTilesControl(app);
}

export function openZarrLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneZarrControl(app);
}

export function openLidarLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneLidarControl(app);
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

async function ensureCogRasterControl(
  app: GeoLibreAppAPI,
): Promise<CogLayerControl | null> {
  const { CogLayerControl: CogLayerControlClass } =
    await getComponentsConstructors();

  cogRasterControl ??= createCogRasterControl(CogLayerControlClass);

  if (!cogRasterControlMounted) {
    const added = app.addMapControl(cogRasterControl, cogRasterControlPosition);
    if (!added) {
      cogRasterControl = null;
      return null;
    }
    cogRasterControlMounted = true;
  }

  setTimeout(() => {
    cogRasterControl?.hide();
    cogRasterControl?.collapse();
  }, 0);
  return cogRasterControl;
}

async function openStandalonePMTilesControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { PMTilesLayerControl: PMTilesLayerControlClass } =
    await getComponentsConstructors();

  pmtilesControl ??= createPMTilesControl(PMTilesLayerControlClass);

  if (!pmtilesControlMounted) {
    const added = app.addMapControl(pmtilesControl, pmtilesControlPosition);
    if (!added) {
      pmtilesControl = null;
      return false;
    }
    pmtilesControlMounted = true;
  }

  setTimeout(() => {
    pmtilesControl?.show();
    pmtilesControl?.expand();
  }, 0);
  return true;
}

async function openStandaloneZarrControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const { ZarrLayerControl: ZarrLayerControlClass } =
    await getComponentsConstructors();

  zarrControl ??= createZarrControl(ZarrLayerControlClass);

  if (!zarrControlMounted) {
    const added = app.addMapControl(zarrControl, zarrControlPosition);
    if (!added) {
      zarrControl = null;
      return false;
    }
    zarrControlMounted = true;
  }

  setTimeout(() => {
    zarrControl?.show();
    zarrControl?.expand();
  }, 0);
  return true;
}

async function openStandaloneLidarControl(
  app: GeoLibreAppAPI,
): Promise<boolean> {
  const {
    LidarControl: LidarControlClass,
    LidarLayerAdapter: LidarLayerAdapterClass,
  } =
    await getComponentsConstructors();

  lidarControl ??= createLidarControl(
    LidarControlClass,
    LidarLayerAdapterClass,
  );

  if (!lidarControlMounted) {
    const added = app.addMapControl(lidarControl, lidarControlPosition);
    if (!added) {
      lidarControl = null;
      return false;
    }
    lidarControlMounted = true;
  }

  setTimeout(() => {
    disableLidarClickOutsideCollapse(lidarControl);
    showLidarControl(lidarControl);
    lidarControl?.expand();
    seedLidarDefaultUrl(lidarControl);
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

function createCogRasterControl(
  CogLayerControlClass: CogLayerControlConstructor,
): CogLayerControl {
  const control = new CogLayerControlClass(COG_RASTER_OPTIONS);
  control.on("layeradd", createCogRasterLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isCogRasterControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  cogRasterStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isCogRasterControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        cogRasterControl?.removeLayer(layer.id);
        continue;
      }

      if (!isCogRasterControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        cogRasterControl?.setLayerVisibility(
          currentLayer.id,
          currentLayer.visible,
          currentLayer.opacity,
        );
      }

      if (currentLayer.opacity !== layer.opacity) {
        if (currentLayer.visible) {
          cogRasterControl?.setLayerOpacity(currentLayer.id, currentLayer.opacity);
        } else {
          cogRasterControl?.setLayerVisibility(
            currentLayer.id,
            false,
            currentLayer.opacity,
          );
        }
      }
    }
  });
  return control;
}

function createLidarControl(
  LidarControlClass: LidarControlConstructor,
  LidarLayerAdapterClass: LidarLayerAdapterConstructor,
): LidarControl {
  const control = new LidarControlClass(LIDAR_OPTIONS);
  lidarLayerAdapter = new LidarLayerAdapterClass(control);
  control.on("collapse", () => hideLidarControl(control));
  control.on("load", createLidarLoadHandler());
  control.on("unload", createLidarUnloadHandler());
  lidarStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isLidarControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        if (hasLidarPointCloud(layer.id)) {
          lidarLayerAdapter?.removeLayer(layer.id);
        }
        continue;
      }

      if (!isLidarControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        lidarLayerAdapter?.setVisibility(currentLayer.id, currentLayer.visible);
      }

      if (currentLayer.opacity !== layer.opacity) {
        lidarLayerAdapter?.setOpacity(currentLayer.id, currentLayer.opacity);
      }
    }
  });
  return control;
}

function createZarrControl(
  ZarrLayerControlClass: ZarrLayerControlConstructor,
): ZarrLayerControl {
  const control = new ZarrLayerControlClass(ZARR_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("layeradd", createZarrLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isZarrControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  zarrStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    for (const layer of previous.layers) {
      if (!isZarrControlLayer(layer)) continue;

      const currentLayer = currentById.get(layer.id);
      if (!currentLayer) {
        zarrControl?.removeLayer(layer.id);
        continue;
      }

      if (!isZarrControlLayer(currentLayer)) continue;

      if (currentLayer.visible !== layer.visible) {
        zarrControl?.setLayerVisibility(
          currentLayer.id,
          currentLayer.visible,
          currentLayer.opacity,
        );
      }

      if (currentLayer.opacity !== layer.opacity) {
        if (currentLayer.visible) {
          zarrControl?.setLayerOpacity(currentLayer.id, currentLayer.opacity);
        } else {
          zarrControl?.setLayerVisibility(
            currentLayer.id,
            false,
            currentLayer.opacity,
          );
        }
      }
    }
  });
  return control;
}

function createPMTilesControl(
  PMTilesLayerControlClass: PMTilesLayerControlConstructor,
): PMTilesLayerControl {
  const control = new PMTilesLayerControlClass(PMTILES_OPTIONS);
  control.on("collapse", () => control.hide());
  control.on("layeradd", createPMTilesLayerAddHandler());
  control.on("layerremove", (event) => {
    const store = useAppStore.getState();
    const activeLayerIds = new Set(event.state.layers.map((layer) => layer.id));
    for (const layer of store.layers) {
      if (!isPMTilesControlLayer(layer)) continue;
      const shouldRemove = event.layerId
        ? layer.id === event.layerId
        : !activeLayerIds.has(layer.id);
      if (shouldRemove) {
        store.removeLayer(layer.id);
      }
    }
  });
  pmtilesStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const removedLayers = previous.layers.filter(
      (layer) =>
        isPMTilesControlLayer(layer) &&
        !state.layers.some((current) => current.id === layer.id),
    );
    for (const layer of removedLayers) {
      pmtilesControl?.removeLayer(layer.id);
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

function teardownCogRasterControl(app: GeoLibreAppAPI): void {
  cogRasterStoreUnsubscribe?.();
  cogRasterStoreUnsubscribe = null;
  if (cogRasterControl && cogRasterControlMounted) {
    app.removeMapControl(cogRasterControl);
  }
  cogRasterControl = null;
  cogRasterControlMounted = false;
}

function teardownGeoTiffRasterOverlay(app: GeoLibreAppAPI): void {
  geoTiffRasterStoreUnsubscribe?.();
  geoTiffRasterStoreUnsubscribe = null;
  geoTiffRasterLayerProps.clear();
  geoTiffRasterLayers.clear();
  updateGeoTiffRasterOverlayLayers();
  if (geoTiffRasterOverlay && geoTiffRasterOverlayMounted) {
    app.removeMapControl(geoTiffRasterOverlay);
  }
  geoTiffRasterOverlay = null;
  geoTiffRasterOverlayMounted = false;
}

function teardownPMTilesControl(app: GeoLibreAppAPI): void {
  pmtilesStoreUnsubscribe?.();
  pmtilesStoreUnsubscribe = null;
  if (pmtilesControl && pmtilesControlMounted) {
    app.removeMapControl(pmtilesControl);
  }
  pmtilesControl = null;
  pmtilesControlMounted = false;
}

function teardownZarrControl(app: GeoLibreAppAPI): void {
  zarrStoreUnsubscribe?.();
  zarrStoreUnsubscribe = null;
  if (zarrControl && zarrControlMounted) {
    app.removeMapControl(zarrControl);
  }
  zarrControl = null;
  zarrControlMounted = false;
}

function teardownLidarControl(app: GeoLibreAppAPI): void {
  lidarStoreUnsubscribe?.();
  lidarStoreUnsubscribe = null;
  lidarLayerAdapter?.destroy();
  lidarLayerAdapter = null;
  if (lidarControl && lidarControlMounted) {
    app.removeMapControl(lidarControl);
  }
  lidarControl = null;
  lidarControlMounted = false;
}

function createLidarLoadHandler(): LidarControlEventHandler {
  return (event) => {
    if (!event.pointCloud || !("source" in event.pointCloud)) return;

    const store = useAppStore.getState();
    const layer = createLidarStoreLayer(event.pointCloud);
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

function createLidarUnloadHandler(): LidarControlEventHandler {
  return (event) => {
    const pointCloudId = event.pointCloud?.id;
    if (!pointCloudId) return;

    const store = useAppStore.getState();
    const layer = store.layers.find((item) => item.id === pointCloudId);
    if (layer && isLidarControlLayer(layer)) {
      store.removeLayer(pointCloudId);
    }
  };
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

function createCogRasterLayerAddHandler(): CogLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const pendingOptions = pendingCogRasterLayerOptions.shift();
    if (
      !pendingOptions &&
      ignoredCogRasterLayerUrls.delete(layerInfo.url || event.url || "")
    ) {
      cogRasterControl?.removeLayer(event.layerId);
      return;
    }

    const store = useAppStore.getState();
    const layer = createCogRasterStoreLayer(
      event.layerId,
      layerInfo,
      pendingOptions,
    );
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer, pendingOptions?.beforeLayerId);
  };
}

function createZarrLayerAddHandler(): ZarrLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createZarrStoreLayer(event.layerId, layerInfo);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function createPMTilesLayerAddHandler(): PMTilesLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find(
      (layer) => layer.id === event.layerId,
    );
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createPMTilesStoreLayer(event.layerId, layerInfo);
    if (store.layers.some((item) => item.id === layer.id)) {
      store.updateLayer(layer.id, {
        metadata: layer.metadata,
        opacity: layer.opacity,
        source: layer.source,
        style: layer.style,
        visible: layer.visible,
      });
      return;
    }
    store.addLayer(layer);
  };
}

function addLayerWithCogRasterControl(
  control: CogLayerControl,
  options: CogRasterLayerOptions,
): Promise<string> {
  configureCogRasterControl(control, options);
  pendingCogRasterLayerOptions.push(options);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      ignoredCogRasterLayerUrls.add(options.url);
      settle(() =>
        reject(
          new Error(
            "The COG raster layer did not finish loading. Trying generic GeoTIFF rendering.",
          ),
        ),
      );
    }, 30000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      control.off("layeradd", handleLayerAdd);
      control.off("error", handleError);
      const pendingIndex = pendingCogRasterLayerOptions.indexOf(options);
      if (pendingIndex >= 0) {
        pendingCogRasterLayerOptions.splice(pendingIndex, 1);
      }
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const handleLayerAdd: CogLayerEventHandler = (event) => {
      if (!event.layerId || event.url !== options.url) return;
      settle(() => resolve(event.layerId!));
    };
    const handleError: CogLayerEventHandler = (event) => {
      settle(() =>
        reject(new Error(event.error || "Failed to load the COG raster layer.")),
      );
    };

    control.on("layeradd", handleLayerAdd);
    control.on("error", handleError);

    void control.addLayer(options.url).then(() => {
      const state = control.getState();
      if (!settled && state.error) {
        settle(() => reject(new Error(state.error || "Failed to load COG.")));
      }
    });
  });
}

async function addGeoTiffRasterLayer(
  app: GeoLibreAppAPI,
  options: CogRasterLayerOptions,
  cause: unknown = undefined,
): Promise<string> {
  const overlay = await ensureGeoTiffRasterOverlay(app);
  if (!overlay) {
    throw new Error(
      "The generic GeoTIFF raster overlay could not be added to the map.",
      { cause },
    );
  }

  const id = createGeoTiffRasterLayerId();
  const url = options.url.trim();
  const name = options.name?.trim() || layerNameFromUrl(url, id);
  const rasterInput = await fetchGeoTiffRasterInput(app, url, cause);
  const { bounds, raster } = await loadGeoTiffRasterData(rasterInput, options);
  const state: GeoTiffRasterLayerState = {
    bounds,
    id,
    name,
    opacity: options.opacity ?? 1,
    options,
    raster,
    url,
    visible: true,
  };

  geoTiffRasterLayerProps.set(id, state);
  geoTiffRasterLayers.set(id, createGeoTiffDeckLayer(state));
  updateGeoTiffRasterOverlayLayers();
  addOrUpdateGeoTiffStoreLayer(state);
  app.fitBounds?.(bounds);
  return id;
}

async function ensureGeoTiffRasterOverlay(
  app: GeoLibreAppAPI,
): Promise<MapboxOverlay | null> {
  const { MapboxOverlay: MapboxOverlayClass } = await import("@deck.gl/mapbox");
  geoTiffRasterOverlay ??= new MapboxOverlayClass({
    interleaved: false,
    layers: [],
  });

  if (!geoTiffRasterOverlayMounted) {
    const added = app.addMapControl(
      geoTiffRasterOverlay,
      cogRasterControlPosition,
    );
    if (!added) {
      geoTiffRasterOverlay = null;
      return null;
    }
    geoTiffRasterOverlayMounted = true;
  }

  geoTiffRasterStoreUnsubscribe ??= useAppStore.subscribe(
    (state, previous) => {
      const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

      for (const layer of previous.layers) {
        if (!isGeoTiffRasterLayer(layer)) continue;

        const currentLayer = currentById.get(layer.id);
        if (!currentLayer) {
          geoTiffRasterLayerProps.delete(layer.id);
          geoTiffRasterLayers.delete(layer.id);
          continue;
        }

        if (!isGeoTiffRasterLayer(currentLayer)) continue;

        if (
          currentLayer.visible !== layer.visible ||
          currentLayer.opacity !== layer.opacity
        ) {
          const rasterState = geoTiffRasterLayerProps.get(layer.id);
          if (!rasterState) continue;
          rasterState.visible = currentLayer.visible;
          rasterState.opacity = currentLayer.opacity;
          geoTiffRasterLayerProps.set(layer.id, rasterState);
          geoTiffRasterLayers.set(
            layer.id,
            createGeoTiffDeckLayer(rasterState),
          );
        }
      }

      updateGeoTiffRasterOverlayLayers();
    },
  );

  return geoTiffRasterOverlay;
}

async function fetchGeoTiffRasterInput(
  app: GeoLibreAppAPI,
  url: string,
  cause: unknown,
): Promise<ArrayBuffer> {
  if (app.fetchArrayBuffer) {
    try {
      return await app.fetchArrayBuffer(url);
    } catch (error) {
      throw new Error("The raster URL could not be fetched.", {
        cause: error || cause,
      });
    }
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
  } catch (error) {
    throw new Error("The raster URL could not be fetched.", {
      cause: error || cause,
    });
  }
}

async function loadGeoTiffRasterData(
  input: ArrayBuffer,
  options: CogRasterLayerOptions,
): Promise<{
  bounds: [number, number, number, number];
  raster: GeoTiffRasterData;
}> {
  const tiff = await fromArrayBuffer(input);
  const image = await tiff.getImage();
  const projection = await proj.epsgIoGeoKeyParser(image.getGeoKeys() ?? {});
  if (!projection) {
    throw new Error("Could not determine the GeoTIFF projection.");
  }

  const imageBounds = image.getBoundingBox();
  if (imageBounds.length !== 4) {
    throw new Error("Could not determine the GeoTIFF bounds.");
  }
  const bounds = getGeoTiffGeographicBounds(
    imageBounds as [number, number, number, number],
    projection.def,
  );
  const reprojectionFns = await extractGeotiffReprojectors(
    tiff as never,
    projection.def,
  );
  const sampleCount = image.getSamplesPerPixel();
  const sample = Math.min(getFirstRasterBand(options.bands), sampleCount - 1);
  const bandValues = (await image.readRasters({
    interleave: true,
    samples: [sample],
  })) as RasterBandValues & { height?: number; width?: number };
  const width = bandValues.width ?? image.getWidth();
  const height = bandValues.height ?? image.getHeight();
  const imageData = createRasterImageData(bandValues, width, height, options);

  return {
    bounds,
    raster: {
      height,
      image: imageData,
      reprojectionFns,
      width,
    },
  };
}

function getFirstRasterBand(bands: string | undefined): number {
  const parsed = Number.parseInt(bands?.split(",")[0]?.trim() || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

function createRasterImageData(
  values: RasterBandValues,
  width: number,
  height: number,
  options: CogRasterLayerOptions,
): ImageData {
  const stats = getRasterValueStats(values, options.nodata);
  const useAutoScale =
    (options.rescaleMin ?? 0) === 0 &&
    (options.rescaleMax ?? 255) === 255 &&
    stats.max > 255;
  const min = useAutoScale ? stats.min : (options.rescaleMin ?? stats.min);
  const max = useAutoScale ? stats.max : (options.rescaleMax ?? stats.max);
  const scale = max > min ? max - min : 1;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const pixelIndex = index * 4;
    if (
      !Number.isFinite(value) ||
      (options.nodata !== undefined && value === options.nodata)
    ) {
      pixels[pixelIndex + 3] = 0;
      continue;
    }

    const normalized = Math.max(0, Math.min(1, (value - min) / scale));
    const [red, green, blue] = colorFromRasterValue(
      normalized,
      options.colormap,
    );
    pixels[pixelIndex] = red;
    pixels[pixelIndex + 1] = green;
    pixels[pixelIndex + 2] = blue;
    pixels[pixelIndex + 3] = 255;
  }

  return new ImageData(pixels, width, height);
}

function getRasterValueStats(
  values: RasterBandValues,
  nodata: number | undefined,
): { max: number; min: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value) || (nodata !== undefined && value === nodata)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  return { min, max };
}

function colorFromRasterValue(
  value: number,
  colormap: CogRasterLayerOptions["colormap"],
): [number, number, number] {
  if (colormap === "terrain") {
    return interpolateColorRamp(value, [
      [51, 102, 51],
      [180, 170, 120],
      [255, 255, 255],
    ]);
  }
  if (colormap === "viridis") {
    return interpolateColorRamp(value, [
      [68, 1, 84],
      [33, 145, 140],
      [253, 231, 37],
    ]);
  }
  if (colormap === "plasma") {
    return interpolateColorRamp(value, [
      [13, 8, 135],
      [203, 71, 119],
      [240, 249, 33],
    ]);
  }
  if (colormap === "inferno" || colormap === "magma") {
    return interpolateColorRamp(value, [
      [0, 0, 4],
      [187, 55, 84],
      [252, 255, 164],
    ]);
  }
  if (colormap === "cividis") {
    return interpolateColorRamp(value, [
      [0, 34, 77],
      [126, 124, 120],
      [255, 233, 69],
    ]);
  }
  if (colormap === "turbo" || colormap === "jet") {
    return interpolateColorRamp(value, [
      [48, 18, 59],
      [33, 145, 140],
      [253, 231, 37],
      [122, 4, 3],
    ]);
  }
  const gray = Math.round(value * 255);
  return [gray, gray, gray];
}

function interpolateColorRamp(
  value: number,
  stops: [number, number, number][],
): [number, number, number] {
  if (stops.length === 1) return stops[0];
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const ratio = scaled - index;
  const start = stops[index];
  const end = stops[index + 1];
  return [
    Math.round(start[0] + (end[0] - start[0]) * ratio),
    Math.round(start[1] + (end[1] - start[1]) * ratio),
    Math.round(start[2] + (end[2] - start[2]) * ratio),
  ];
}

function getGeoTiffGeographicBounds(
  projectedBounds: [number, number, number, number],
  sourceProjection: Parameters<typeof proj4>[0],
): [number, number, number, number] {
  const converter = proj4(sourceProjection, "EPSG:4326");
  const [minX, minY, maxX, maxY] = projectedBounds;
  const corners = [
    converter.forward([minX, minY]),
    converter.forward([maxX, minY]),
    converter.forward([maxX, maxY]),
    converter.forward([minX, maxY]),
  ];
  const longitudes = corners.map(([longitude]) => longitude);
  const latitudes = corners.map(([, latitude]) => latitude);
  return [
    Math.min(...longitudes),
    Math.min(...latitudes),
    Math.max(...longitudes),
    Math.max(...latitudes),
  ];
}

function createGeoTiffDeckLayer(
  state: GeoTiffRasterLayerState,
): Layer {
  return new RasterLayer({
    id: state.id,
    image: state.raster.image,
    height: state.raster.height,
    opacity: state.visible ? state.opacity : 0,
    pickable: false,
    reprojectionFns: state.raster.reprojectionFns,
    width: state.raster.width,
  }) as unknown as Layer;
}

function updateGeoTiffRasterOverlayLayers(): void {
  geoTiffRasterOverlay?.setProps({
    layers: Array.from(geoTiffRasterLayers.values()),
  });
}

function addOrUpdateGeoTiffStoreLayer(state: GeoTiffRasterLayerState): void {
  const store = useAppStore.getState();
  const layer = createGeoTiffRasterStoreLayer(state);
  if (store.layers.some((item) => item.id === layer.id)) {
    store.updateLayer(layer.id, {
      metadata: layer.metadata,
      opacity: layer.opacity,
      source: layer.source,
      style: layer.style,
      visible: layer.visible,
    });
    return;
  }
  store.addLayer(layer, state.options.beforeLayerId);
}

function configureCogRasterControl(
  control: CogLayerControl,
  options: CogRasterLayerOptions,
): void {
  const mutableControl = control as unknown as MutableCogLayerControl;
  const state = mutableControl._state;
  if (state) {
    state.url = options.url;
    state.bands = options.bands?.trim() || "1";
    state.colormap = options.colormap ?? "none";
    state.rescaleMin = options.rescaleMin ?? 0;
    state.rescaleMax = options.rescaleMax ?? 255;
    state.nodata = options.nodata;
    state.layerName = options.name?.trim() || "";
    state.layerOpacity = options.opacity ?? 1;
    state.pickable = false;
  }
  if (mutableControl._options) {
    mutableControl._options.beforeId = options.beforeLayerId || "";
  }
  mutableControl._render?.();
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

function createCogRasterStoreLayer(
  id: string,
  layerInfo: CogLayerInfo,
  options?: CogRasterLayerOptions,
): GeoLibreLayer {
  const url = options?.url ?? layerInfo.url;
  const bands = options?.bands?.trim() || layerInfo.bands || "1";
  const colormap = options?.colormap ?? layerInfo.colormap;
  const rescaleMin = options?.rescaleMin ?? layerInfo.rescaleMin;
  const rescaleMax = options?.rescaleMax ?? layerInfo.rescaleMax;
  const nodata = options?.nodata ?? layerInfo.nodata;

  return {
    id,
    name: options?.name?.trim() || layerInfo.name || layerNameFromUrl(url, id),
    type: "cog",
    source: {
      bands,
      colormap,
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: id,
      type: "raster",
      url,
    },
    visible: true,
    opacity: options?.opacity ?? layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      bands,
      colormap,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [id],
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: id,
      sourceKind: "cog-url",
      tileType: "raster",
    },
    sourcePath: url,
  };
}

function createGeoTiffRasterStoreLayer(
  state: GeoTiffRasterLayerState,
): GeoLibreLayer {
  const bands = state.options.bands?.trim() || "1";
  const colormap = state.options.colormap ?? "none";
  const rescaleMin = state.options.rescaleMin ?? 0;
  const rescaleMax = state.options.rescaleMax ?? 255;
  const nodata = state.options.nodata;

  return {
    id: state.id,
    name: state.name,
    type: "cog",
    source: {
      bands,
      bounds: state.bounds,
      colormap,
      nodata,
      rescaleMax,
      rescaleMin,
      sourceId: state.id,
      type: "raster",
      url: state.url,
    },
    visible: state.visible,
    opacity: state.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      bands,
      colormap,
      customLayerType: "raster",
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [state.id],
      nodata,
      rasterFormat: "geotiff",
      rescaleMax,
      rescaleMin,
      sourceId: state.id,
      sourceKind: "geotiff-url",
      tileType: "raster",
    },
    sourcePath: state.url,
  };
}

function createPMTilesStoreLayer(
  id: string,
  layerInfo: PMTilesLayerInfo,
): GeoLibreLayer {
  const firstSourceLayer = layerInfo.sourceLayers[0];
  const fillColor =
    (firstSourceLayer && layerInfo.sourceLayerColors?.[firstSourceLayer]) ??
    DEFAULT_LAYER_STYLE.fillColor;

  return {
    id,
    name: layerInfo.name || layerNameFromUrl(layerInfo.url, id),
    type: "pmtiles",
    source: {
      sourceId: layerInfo.id,
      sourceLayers: layerInfo.sourceLayers,
      tileType: layerInfo.tileType,
      type: layerInfo.tileType === "raster" ? "raster" : "vector",
      url: layerInfo.url,
    },
    visible: true,
    opacity: layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: layerInfo.tileType === "raster" ? 0.6 : 1,
      fillColor,
      strokeColor: fillColor,
    },
    metadata: {
      externalNativeLayer: true,
      nativeLayerIds: layerInfo.layerIds,
      pickable: layerInfo.pickable,
      sourceId: layerInfo.id,
      sourceKind: "pmtiles-url",
      sourceLayerColors: layerInfo.sourceLayerColors,
      sourceLayers: layerInfo.sourceLayers,
      tileType: layerInfo.tileType,
    },
    sourcePath: layerInfo.url,
  };
}

function createZarrStoreLayer(
  id: string,
  layerInfo: ZarrLayerInfo,
): GeoLibreLayer {
  const name =
    layerInfo.name ||
    [layerNameFromUrl(layerInfo.url, id), layerInfo.variable]
      .filter(Boolean)
      .join(" - ");

  return {
    id,
    name,
    type: "zarr",
    source: {
      clim: layerInfo.clim,
      colormap: layerInfo.colormap,
      selector: layerInfo.selector,
      sourceId: layerInfo.id,
      type: "raster",
      url: layerInfo.url,
      variable: layerInfo.variable,
    },
    visible: true,
    opacity: layerInfo.opacity,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillOpacity: 1,
    },
    metadata: {
      clim: layerInfo.clim,
      colormap: layerInfo.colormap,
      externalNativeLayer: true,
      identifiable: false,
      nativeLayerIds: [layerInfo.id],
      selector: layerInfo.selector,
      sourceId: layerInfo.id,
      sourceKind: "zarr-url",
      tileType: "raster",
      variable: layerInfo.variable,
    },
    sourcePath: layerInfo.url,
  };
}

function createLidarStoreLayer(pointCloud: PointCloudInfo): GeoLibreLayer {
  return {
    id: pointCloud.id,
    name: pointCloud.name || layerNameFromUrl(pointCloud.source, pointCloud.id),
    type: "lidar",
    source: {
      bounds: [
        pointCloud.bounds.minX,
        pointCloud.bounds.minY,
        pointCloud.bounds.maxX,
        pointCloud.bounds.maxY,
      ],
      sourceId: pointCloud.id,
      type: "lidar",
      url: pointCloud.source,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "lidar",
      externalNativeLayer: true,
      hasClassification: pointCloud.hasClassification,
      hasIntensity: pointCloud.hasIntensity,
      hasRGB: pointCloud.hasRGB,
      identifiable: false,
      pointCount: pointCloud.pointCount,
      sourceId: pointCloud.id,
      sourceKind: "lidar-url",
      wkt: pointCloud.wkt,
    },
    sourcePath: pointCloud.source,
  };
}

function isFlatGeobufControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "flatgeobuf" &&
    layer.metadata.sourceKind === "flatgeobuf-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isCogRasterControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "cog-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isGeoTiffRasterLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "cog" &&
    layer.metadata.sourceKind === "geotiff-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isPMTilesControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "pmtiles" &&
    layer.metadata.sourceKind === "pmtiles-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isZarrControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "zarr" &&
    layer.metadata.sourceKind === "zarr-url" &&
    layer.metadata.externalNativeLayer === true
  );
}

function isLidarControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "lidar" &&
    layer.metadata.sourceKind === "lidar-url" &&
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

function createGeoTiffRasterLayerId(): string {
  geoTiffRasterLayerSequence += 1;
  return `geotiff-layer-${geoTiffRasterLayerSequence}`;
}

function shouldUseGenericGeoTiffRenderer(url: string): boolean {
  const isTiffPath = /\.tiff?$/i.test(url);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(url);
  if (!hasScheme) return isTiffPath;

  try {
    const parsedUrl = new URL(url);
    const isGitHubRelease =
      parsedUrl.hostname === "github.com" &&
      parsedUrl.pathname.includes("/releases/download/");
    const isTiff = /\.tiff?$/i.test(parsedUrl.pathname);
    return isTiff && (isGitHubRelease || parsedUrl.protocol === "file:");
  } catch {
    return isTiffPath;
  }
}

function seedLidarDefaultUrl(control: LidarControl | null): void {
  const panel = findLidarPanel(control);
  const input = panel?.querySelector<HTMLInputElement>(".lidar-control-input");
  if (!input || input.value.trim()) return;
  input.value = LIDAR_SAMPLE_URL;
}

function hideLidarControl(control: LidarControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "none";
}

function showLidarControl(control: LidarControl | null): void {
  const container = control?.getContainer();
  if (container) container.style.display = "";
}

function disableLidarClickOutsideCollapse(control: LidarControl | null): void {
  const clickOutsideState = control as unknown as
    | LidarControlClickOutsideState
    | null;
  const handler = clickOutsideState?._clickOutsideHandler;
  if (!handler) return;
  document.removeEventListener("click", handler);
  clickOutsideState._clickOutsideHandler = null;
}

function hasLidarPointCloud(id: string): boolean {
  return lidarControl?.getPointClouds().some((pointCloud) => pointCloud.id === id)
    ?? false;
}

function findLidarPanel(control: LidarControl | null): HTMLElement | null {
  const mapContainer = control?.getMap()?.getContainer();
  if (!mapContainer) return null;

  const panels = Array.from(
    mapContainer.querySelectorAll<HTMLElement>(".lidar-control-panel"),
  );

  return (
    panels.find(
      (panel) =>
        panel.querySelector(".lidar-control-title")?.textContent ===
        LIDAR_OPTIONS.title,
    ) ??
    panels[panels.length - 1] ??
    null
  );
}
