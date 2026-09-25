// The Zarr layer control, the programmatic Zarr / Cloud-Optimized NetCDF
// adds, and the Zarr time axis.
// Split out of maplibre-components.ts (opengeos/GeoLibre#2633).

import type {
  QueryGeometry,
  QueryOptions,
  QueryResult,
  Selector,
  ZarrLayer,
} from "@carbonplan/zarr-layer";
import {
  clearExternalNativePaintBridge,
  DEFAULT_LAYER_STYLE,
  type GeoLibreLayer,
  interpolateRampColors,
  setExternalNativePaintBridge,
  useAppStore,
} from "@geolibre/core";
import { readNativeZarrDimensions, registerZarrStore } from "@geolibre/map/zarr-source";
import type {
  ZarrLayerControl,
  ZarrLayerControlOptions,
  ZarrLayerEventHandler,
  ZarrLayerInfo,
  ZarrLocalStoreProvider,
} from "maplibre-gl-components";
import type { GeoLibreAppAPI, GeoLibreMapControlPosition } from "../../types";
import {
  KerchunkReferenceStore,
  type KerchunkRefs,
  loadKerchunkReference,
} from "../kerchunk-reference-store";
import { ensureMercatorProjection } from "../map-projection-utils";
import {
  nearestTimeIndex,
  registerTemporalLayer,
  unregisterTemporalLayer,
} from "../temporal-layers";
import {
  createDirectoryZarrMetadataReader,
  localZarrStoreUrl,
  type ZarrDirectoryReader,
  ZarrDirectoryStore,
} from "../zarr-directory-store";
import {
  pickTimeDimension,
  readCoordinateTimeAttributes,
  resolveZarrTimeAxis,
  type ZarrTimeAttributes,
} from "../zarr-time-axis";
import { getComponentsConstructors, type ZarrLayerControlConstructor } from "./constructors";
import { layerNameFromUrl } from "./shared";

const zarrControlPosition: GeoLibreMapControlPosition = "top-left";

const ZARR_SAMPLE_URL =
  "https://carbonplan-maps.s3.us-west-2.amazonaws.com/v2/demo/4d/tavg-prec-month";
/**
 * A cube with a real time axis, so the Zarr panel can demonstrate the Time
 * Slider binding. The CarbonPlan sample above cannot: its non-spatial dims are
 * `band` and a bare 1-12 `month` climatology with no CF `units`, which is not a
 * series of instants, so no temporal adapter is registered for it and the
 * Layers panel correctly offers no bind action.
 *
 * NOAA OI SST V2 monthly means, 1981-2023 on a 1-degree global grid, chunked
 * one time step per chunk (~165 KiB) so stepping the timeline is a single small
 * read. Public domain (U.S. Government work); see the store's own attributes
 * for the citation.
 */
const ZARR_TIME_SERIES_SAMPLE_URL =
  "https://data.source.coop/giswqs/opengeos/noaa-oisst-v2-monthly.zarr";

// Matches the stop count of the control's own default colormap, so a named ramp
// renders with the same smoothness as the built-in Zarr panel default. Declared
// above ZARR_OPTIONS because that initializer resolves a ramp for its samples.
const ZARR_COLORMAP_STOPS = 9;

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
  // The SST entry carries its own settings because the `default*` options above
  // are the CarbonPlan sample's: a -2..35 degree field drawn against a 0-300
  // ramp is a flat wash, and `{ band, month }` names dimensions it does not
  // have. Needs maplibre-gl-components >= 0.28.0, which applies these on select.
  sampleData: [
    { label: "Climate (CarbonPlan)", url: ZARR_SAMPLE_URL },
    {
      label: "Sea surface temperature, monthly (NOAA)",
      url: ZARR_TIME_SERIES_SAMPLE_URL,
      variable: "sst",
      clim: [-2, 32],
      colormap: interpolateRampColors("turbo", ZARR_COLORMAP_STOPS),
      // This store's only non-spatial dimension is `time`, which the Time
      // Slider drives; an empty selector clears the climate sample's.
      selector: {},
    },
  ],
  defaultVariable: "climate",
  fontColor: "hsl(var(--popover-foreground))",
} satisfies ZarrLayerControlOptions;

let zarrControl: ZarrLayerControl | null = null;
let zarrControlMounted = false;
let zarrStoreUnsubscribe: (() => void) | null = null;
const arcgisZarrTemporalUnsubscribes = new Map<string, () => void>();
const restoredArcgisZarrLayerIds = new Set<string>();
let restoredArcgisZarrStoreUnsubscribe: (() => void) | null = null;

export function openZarrLayerPanel(app: GeoLibreAppAPI): void {
  void openStandaloneZarrControl(app);
}

/**
 * The host's folder picker for the Zarr panel's "Browse folder" button, and the
 * folders it has opened so far.
 *
 * Reading a folder needs a filesystem API the plugins package does not have
 * (Tauri's `fs`, or the browser's `showDirectoryPicker`), so the app registers
 * one at startup. It stays null where neither exists, and the panel then shows
 * no button at all rather than one that cannot deliver.
 */
let zarrLocalStoreProvider: ZarrLocalStoreProvider | null = null;

/**
 * Readers for the local stores opened so far, keyed by the identifier the layer
 * was added under.
 *
 * A local cube's `url` is not an address, so the Time Slider's usual metadata
 * walk over HTTP has nothing to fetch. Keeping the reader lets
 * {@link registerZarrTemporalAdapter} read the store's CF `units`/`calendar`
 * out of the folder instead, for a layer the *panel* added — where, unlike a
 * programmatic add, the caller has no chance to pass its own context.
 */
const zarrLocalStoreReaders = new Map<string, ZarrDirectoryReader>();

/**
 * Register the host's folder picker for the Zarr panel.
 *
 * @param provider - Opens a folder dialog and returns read access to the chosen
 *   Zarr store, or null when dismissed. Pass null to remove the button.
 */
export function setZarrLocalStoreProvider(
  provider: (() => Promise<ZarrDirectoryReader | null>) | null,
): void {
  if (!provider) {
    zarrLocalStoreProvider = null;
    return;
  }
  zarrLocalStoreProvider = async () => {
    const reader = await provider();
    if (!reader) return null;
    // A reader holds a directory handle — memory, and the capability to read
    // that folder — so drop the ones no layer is using before taking another.
    pruneZarrLocalStoreReaders();
    // Mint the identifier here rather than let the control derive one, so the
    // reader can be filed under the same string the layer will carry.
    const url = localZarrStoreUrl(reader.name);
    zarrLocalStoreReaders.set(url, reader);
    return { name: reader.name, store: new ZarrDirectoryStore(reader), url };
  };
}

/**
 * Forget the folder readers no live Zarr layer is backed by.
 *
 * Run after a layer is removed, and before a new folder is taken: between the
 * two it also covers a folder the user browsed to and then never added, which
 * no layer removal would ever account for.
 */
function pruneZarrLocalStoreReaders(): void {
  if (zarrLocalStoreReaders.size === 0) return;
  const live = new Set(
    useAppStore
      .getState()
      .layers.filter(isZarrControlLayer)
      .map((layer) => layer.sourcePath),
  );
  for (const url of zarrLocalStoreReaders.keys()) {
    if (!live.has(url)) zarrLocalStoreReaders.delete(url);
  }
}

/** Options for {@link addCloudNetcdfLayer}. */
export interface CloudNetcdfLayerOptions {
  /** URL of the kerchunk reference manifest (JSON) for the NetCDF/HDF file. */
  url: string;
  /**
   * Pre-loaded, normalized reference map. When provided, the manifest is not
   * fetched again (avoids a second download of a potentially large manifest).
   */
  refs?: KerchunkRefs;
  /** Variable (array) to render. */
  variable: string;
  /** Dimension selector for non-spatial dims, e.g. `{ time: 0 }`. */
  selector?: Record<string, number | string>;
  /** Color limits `[min, max]`. */
  clim?: [number, number];
  /**
   * A named GeoLibre ramp (e.g. `"viridis"`) or an explicit list of hex colors,
   * matching {@link ZarrRasterLayerOptions.colormap}. An unrecognized name falls
   * back to the renderer's default ramp.
   */
  colormap?: string | string[];
  /** Layer opacity (0-1). */
  opacity?: number;
  /**
   * Explicit spatial bounds `[west, south, east, north]`. Recorded on the layer
   * so "Zoom to layer" and the Metadata panel know where the grid is: the
   * renderer resolves the extent internally and never reports it back, so
   * without this the layer has no bounds the host can fly to.
   */
  bounds?: [number, number, number, number];
  /** Optional request headers (e.g. for authenticated stores). */
  headers?: Record<string, string>;
}

/**
 * Add a Cloud-Optimized NetCDF/HDF5 layer by rendering it through the shared
 * Zarr control with a kerchunk reference store. The reference manifest is
 * fetched and normalized, a {@link KerchunkReferenceStore} resolves each chunk
 * to an HTTP byte range inside the original file, and the store is handed to
 * `ZarrLayerControl.addLayer(url, variable, { store })`. The resulting layer is
 * tracked in the store like any other Zarr layer.
 *
 * @param app The GeoLibre app API.
 * @param options Reference URL, variable, and optional styling/selector.
 * @throws If the Zarr control cannot be mounted or the reference fails to load.
 */
export async function addCloudNetcdfLayer(
  app: GeoLibreAppAPI,
  options: CloudNetcdfLayerOptions,
): Promise<void> {
  if (app.getMapRenderer?.() === "arcgis") {
    const refs =
      options.refs ?? (await loadKerchunkReference(options.url, { headers: options.headers }));
    await addNativeArcgisZarrLayer(
      {
        ...options,
        store: new KerchunkReferenceStore(refs, {
          headers: options.headers,
          sourceUrl: options.url,
        }),
      },
      refs,
    );
    return;
  }
  const { ZarrLayerControl: ZarrLayerControlClass } = await getComponentsConstructors();

  zarrControl ??= createZarrControl(ZarrLayerControlClass);
  if (!zarrControlMounted) {
    const added = app.addMapControl(zarrControl, zarrControlPosition);
    if (!added) {
      zarrControl = null;
      throw new Error("Could not add the Zarr control to the map.");
    }
    zarrControlMounted = true;
    // Mounted only to borrow its render path, exactly as addZarrRasterLayer
    // does. ZARR_OPTIONS sets `collapsed: false` for the "open the Zarr panel"
    // flow, so without this the panel unfolds over the map the moment a dialog
    // add lands — on top of the extent the camera has just been flown to.
    zarrControl.hide();
  }

  // The untiled Zarr renderer draws in Web Mercator; switch off globe first
  // (matching the COG raster flow) so the layer paints, on either 2D engine.
  ensureMercatorProjection(app.getMap?.() ?? app.getMapboxMap?.());

  const refs =
    options.refs ?? (await loadKerchunkReference(options.url, { headers: options.headers }));
  const store = new KerchunkReferenceStore(refs, {
    headers: options.headers,
    sourceUrl: options.url,
  });

  // The control is a module-level singleton and may have been torn down (set to
  // null on plugin deactivation) during the await above.
  if (!zarrControl) {
    throw new Error("The Zarr control was removed while loading the reference.");
  }

  // Success is tracked by the control's "layeradd" event (see createZarrControl),
  // which adds the layer to the store. We intentionally do not read
  // getState().error here: the control is shared, so the error may be stale from
  // a prior operation, and addLayer resolves before async chunk loading finishes.
  // Queued with every other programmatic add, because the event carries no
  // correlation id: overlapping adds would each latch onto the other's event.
  const control = zarrControl;
  await queueZarrAdd(async () => {
    // The same event names the new layer, which the temporal registration below
    // needs so this add's own references reach the time-axis lookup.
    let addedLayerId: string | null = null;
    const captureLayerId: ZarrLayerEventHandler = (event) => {
      if (event.layerId) addedLayerId = event.layerId;
    };
    control.on("layeradd", captureLayerId);
    // Claim this add, so the shared handler leaves the adapter to us.
    const endAdd = beginProgrammaticZarrAdd(options.url);
    try {
      await control.addLayer(options.url, options.variable, {
        store,
        zarrVersion: 2,
        selector: options.selector,
        clim: options.clim,
        colormap: resolveZarrColormap(options.colormap),
        opacity: options.opacity,
        bounds: options.bounds,
      });
    } finally {
      control.off("layeradd", captureLayerId);
      endAdd();
    }

    // The references carry the coordinate attributes inline, which is the only
    // way to read a NetCDF cube's CF units: its `url` names the kerchunk
    // manifest, not a Zarr store whose metadata documents could be walked.
    if (addedLayerId) {
      registerZarrTemporalAdapter(addedLayerId, options.url, { refs, headers: options.headers });
      // Record the extent on the layer itself. The control accepts `bounds` as a
      // render hint but does not always carry it back on the "layeradd" event,
      // and the renderer never reports the extent it resolved — so without this
      // write the Layers panel's "Zoom to layer" has nothing to fly to.
      if (options.bounds) applyZarrLayerBounds(addedLayerId, options.bounds);
    }
  });

  // Unlike openZarrLayerPanel, the dialog-based flow intentionally leaves the
  // Zarr control collapsed/hidden: the layer is managed from the layer and
  // style panels. Users can still open the Zarr panel from the menu to tweak
  // colormap/clim.
}

/**
 * Write a layer's spatial extent onto its store record, so the Layers panel's
 * "Zoom to layer" and the Metadata panel can read it back.
 *
 * @param layerId The layer added by the Zarr control.
 * @param bounds `[west, south, east, north]`.
 */
function applyZarrLayerBounds(layerId: string, bounds: [number, number, number, number]): void {
  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === layerId);
  if (!layer) return;
  store.updateLayer(layerId, {
    source: { ...layer.source, bounds },
    metadata: { ...layer.metadata, bounds },
  });
}

/** Options for {@link addZarrRasterLayer}. */
export interface ZarrRasterLayerOptions {
  /** URL of a plain Zarr store (v2/v3). Anything else is read through `store`. */
  url: string;
  /** Layer name shown in the Layers panel. Defaults to `<store> - <variable>`. */
  name?: string;
  /** Array/variable to render. Required: the renderer cannot guess it. */
  variable: string;
  /** Dimension selector for non-spatial dims, e.g. `{ time: 0 }`. */
  selector?: Record<string, number | string>;
  /** Color limits `[min, max]`. */
  clim?: [number, number];
  /**
   * A named GeoLibre ramp (e.g. `"viridis"`) or an explicit list of hex colors.
   * An unrecognized name falls back to the default ramp, as `addCogLayer` does.
   */
  colormap?: string | string[];
  /** Layer opacity (0-1). */
  opacity?: number;
  /** Zarr metadata version. Defaults to the renderer's detection. */
  zarrVersion?: 2 | 3;
  /** CRS of the store for built-in projections, e.g. `"EPSG:32633"`. */
  crs?: string;
  /** proj4 definition for a CRS the renderer does not know built-in. */
  proj4?: string;
  /** Explicit spatial bounds `[xMin, yMin, xMax, yMax]` in the store's CRS. */
  bounds?: [number, number, number, number];
  /** Override the names of the spatial dimensions when they are not lat/lon. */
  spatialDimensions?: { lat?: string; lon?: string };
  /** Request headers for an authenticated store. */
  headers?: Record<string, string>;
  /** Insert the new layer directly beneath this layer. */
  beforeLayerId?: string | null;
  /**
   * A zarrita `Readable` to read the store through, instead of fetching `url`.
   * With one supplied, `url` is only an identifier (see
   * {@link localZarrStoreUrl}): it names the layer and keys the control's state,
   * and is never requested. This is how a Zarr store on local disk renders.
   */
  store?: ZarrReadableStore;
  /**
   * Read the CF `units`/`calendar` of a coordinate, for a store the Time Slider
   * cannot look up over HTTP (again: a local folder). Consulted in place of the
   * metadata walk when the layer turns out to have a time axis.
   */
  readTimeAttributes?: ZarrTimeAttributesReader;
}

/** The minimum of zarrita's `Readable` that the renderer calls. */
export interface ZarrReadableStore {
  get(key: string): Promise<Uint8Array | undefined>;
}

/**
 * Reads one coordinate's CF time attributes out of a store's own metadata.
 *
 * @param dimension - The coordinate's name, e.g. `"time"`.
 * @returns Its `units`/`calendar`, or null when it declares neither.
 */
export type ZarrTimeAttributesReader = (dimension: string) => Promise<ZarrTimeAttributes | null>;

/**
 * Add a Zarr layer through GeoLibre's own `@carbonplan/zarr-layer` instance and
 * mirror it into the layer store, without opening the Zarr panel.
 *
 * This is the Zarr counterpart of `app.addCogLayer`: the host owns the
 * renderer, so an external plugin does not bundle a second copy of
 * `@carbonplan/zarr-layer` (plus its numcodecs WASM) and does not have to add a
 * raw MapLibre custom layer whose paint the Style panel cannot reach
 * (opengeos/GeoLibre#1445).
 *
 * `crs`/`proj4` are forwarded to the renderer, which reprojects on the GPU, so a
 * store in a projected CRS (a national grid on `EPSG:32633`, say) lands in the
 * right place instead of being read as WGS84.
 *
 * The Zarr control is mounted hidden when this is the first Zarr layer, so the
 * user does not get a map button they never asked for; a panel they already
 * opened is left alone.
 *
 * @param app The GeoLibre app API.
 * @param options Store URL, variable, and optional styling/CRS/selector.
 * @returns The new layer's id (the Layers-panel entry and the native layer id).
 * @throws If the control cannot be mounted, `variable` is missing, or the store
 *   fails to load.
 */
export async function addZarrRasterLayer(
  app: GeoLibreAppAPI,
  options: ZarrRasterLayerOptions,
): Promise<string> {
  const url = options.url?.trim();
  if (!url) {
    throw new Error("A Zarr store URL is required.");
  }
  // The control renders `state.variable` and reports "Please enter a variable
  // name" on its (hidden) panel when it is empty, so fail here with a message
  // that names the option instead.
  const variable = options.variable?.trim();
  if (!variable) {
    throw new Error("A Zarr variable is required (pass options.variable).");
  }

  if (app.getMapRenderer?.() === "arcgis")
    return addNativeArcgisZarrLayer({ ...options, url, variable });
  return queueZarrAdd(() => addZarrLayerExclusively(app, options, url, variable));
}

async function addNativeArcgisZarrLayer(
  options: ZarrRasterLayerOptions,
  refs?: KerchunkRefs,
): Promise<string> {
  const id = crypto.randomUUID();
  const layer = createZarrStoreLayer(id, {
    id,
    url: options.url,
    variable: options.variable,
    name: options.name,
    selector: options.selector,
    clim: options.clim ?? [0, 1],
    colormap: resolveZarrColormap(options.colormap) ?? interpolateRampColors("viridis", 256),
    opacity: options.opacity ?? 1,
    crs: options.crs,
    proj4: options.proj4,
    bounds: options.bounds,
  });
  layer.source = {
    ...layer.source,
    // Local NetCDF refs inline the entire decoded raster. Keep those in the
    // session store so saving a project cannot embed megabytes of base64 data.
    ...(refs && !options.url.startsWith("local:") ? { kerchunkRefs: refs } : {}),
    headers: options.headers,
    spatialDimensions: options.spatialDimensions,
  };
  if (options.store) {
    const dispose = registerZarrStore(id, options.store);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.layers === previous.layers) return;
      if (!state.layers.some((layer) => layer.id === id)) {
        dispose();
        unsubscribe();
      }
    });
  }
  useAppStore.getState().addLayer(layer, options.beforeLayerId);
  trackRestoredArcgisZarrLayer(id);
  void registerZarrTemporalAdapter(id, options.url, {
    refs,
    headers: options.headers,
    ...(options.readTimeAttributes ? { readAttributes: options.readTimeAttributes } : {}),
  }).then((registered) => {
    if (!registered) restoredArcgisZarrLayerIds.delete(id);
  });
  return id;
}

function trackRestoredArcgisZarrLayer(layerId: string): void {
  restoredArcgisZarrLayerIds.add(layerId);
  if (restoredArcgisZarrStoreUnsubscribe) return;
  restoredArcgisZarrStoreUnsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.layers === previous.layers) return;
    const currentIds = new Set(state.layers.map((layer) => layer.id));
    for (const id of restoredArcgisZarrLayerIds) {
      if (!currentIds.has(id)) restoredArcgisZarrLayerIds.delete(id);
    }
    if (restoredArcgisZarrLayerIds.size) return;
    restoredArcgisZarrStoreUnsubscribe?.();
    restoredArcgisZarrStoreUnsubscribe = null;
  });
}

// One add at a time: see the queue comment on queueZarrAdd.
let zarrAddQueue: Promise<void> = Promise.resolve();

/**
 * Run a Zarr add exclusively.
 *
 * The Zarr control is a shared singleton whose url/variable live in one state
 * slot, and its `layeradd` event carries no correlation id, so two overlapping
 * adds would each see the other's event and could return (and then patch, or
 * resolve the time axis of) the wrong layer. **Every** programmatic add goes
 * through here — both `addZarrRasterLayer` and `addCloudNetcdfLayer`, which
 * would otherwise overlap each other even for the same store. A failed add must
 * not break the chain.
 *
 * @param run - The add to run once the queue drains.
 * @returns Whatever the add resolves to.
 */
function queueZarrAdd<T>(run: () => Promise<T>): Promise<T> {
  const result = zarrAddQueue.then(run);
  zarrAddQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function addZarrLayerExclusively(
  app: GeoLibreAppAPI,
  options: ZarrRasterLayerOptions,
  url: string,
  variable: string,
): Promise<string> {
  const { ZarrLayerControl: ZarrLayerControlClass } = await getComponentsConstructors();

  zarrControl ??= createZarrControl(ZarrLayerControlClass);
  if (!zarrControlMounted) {
    const added = app.addMapControl(zarrControl, zarrControlPosition);
    if (!added) {
      zarrControl = null;
      throw new Error("Could not add the Zarr control to the map.");
    }
    zarrControlMounted = true;
    // Mounted only to borrow its render path — keep it out of sight.
    zarrControl.hide();
  }

  // Zarr renders correctly in globe (proj4js reprojects on the GPU), so — unlike the
  // COG/deck.gl path — do not force Mercator here. This keeps addZarrLayer consistent
  // with the Add Data → Zarr panel, which never switched projection. See #1466.

  const control = zarrControl;
  const headers = options.headers;

  let addedLayerId: string | null = null;
  let failure: string | null = null;
  const handleLayerAdd: ZarrLayerEventHandler = (event) => {
    if (event.layerId) addedLayerId = event.layerId;
  };
  const handleError: ZarrLayerEventHandler = (event) => {
    failure = event.error ?? null;
  };

  control.on("layeradd", handleLayerAdd);
  control.on("error", handleError);
  // Claim this add, so the shared `layeradd` handler leaves the adapter to the
  // registration below, which knows both the layer id and these headers.
  const endAdd = beginProgrammaticZarrAdd(url);
  try {
    // The control awaits its own load before resolving and reports failure by
    // emitting "error" rather than rejecting, so both outcomes are already
    // recorded above by the time this returns.
    await control.addLayer(url, variable, {
      selector: options.selector,
      clim: options.clim,
      colormap: resolveZarrColormap(options.colormap),
      opacity: options.opacity,
      ...(options.store ? { store: options.store } : {}),
      zarrVersion: options.zarrVersion,
      crs: options.crs,
      proj4: options.proj4,
      bounds: options.bounds,
      spatialDimensions: options.spatialDimensions,
      ...(headers && Object.keys(headers).length > 0
        ? { transformRequest: (requestUrl: string) => ({ url: requestUrl, headers }) }
        : {}),
    });
  } finally {
    control.off("layeradd", handleLayerAdd);
    control.off("error", handleError);
    endAdd();
  }

  if (!addedLayerId) {
    throw new Error(failure ?? "Failed to add the Zarr layer.");
  }

  // A cube with a time axis becomes drivable by the Time Slider. Registered
  // here rather than from the shared `layeradd` handler so this add's own
  // headers reach the metadata lookup even when another add of the same store
  // overlaps it (opengeos/GeoLibre#1448 review).
  registerZarrTemporalAdapter(addedLayerId, url, {
    headers,
    ...(options.readTimeAttributes ? { readAttributes: options.readTimeAttributes } : {}),
  });

  // `createZarrLayerAddHandler` has already mirrored the layer into the store
  // (the control emits "layeradd" synchronously) along with the spatial
  // reference the renderer resolved, so only the fields the caller alone knows
  // are left to apply.
  const store = useAppStore.getState();
  const patch: Partial<GeoLibreLayer> = {};
  const name = options.name?.trim();
  if (name) patch.name = name;
  if (options.beforeLayerId) patch.beforeId = options.beforeLayerId;
  if (Object.keys(patch).length > 0) {
    store.updateLayer(addedLayerId, patch);
  }

  return addedLayerId;
}

/**
 * Re-select the non-spatial dimensions of a live Zarr layer, e.g. to step a
 * plugin's own time slider through `{ time: n }` without rebuilding the layer.
 *
 * The renderer keeps the fetched chunks, so this is much cheaper than removing
 * and re-adding the layer. The new selector is written back to the store layer
 * so the Metadata panel and the project file show what is on screen.
 *
 * @param layerId A layer id returned by {@link addZarrRasterLayer}.
 * @param selector The dimension selector, e.g. `{ time: 3 }`.
 * @returns True when the layer accepted the selector, false when there is no
 *   live Zarr layer with that id.
 */
export async function setZarrLayerSelector(
  layerId: string,
  selector: Record<string, number | string>,
): Promise<boolean> {
  const instance = zarrControl?.getLayersMap().get(layerId) as
    | { setSelector?: (selector: Record<string, number | string>) => Promise<void> | void }
    | undefined;
  const native =
    useAppStore.getState().primaryRenderer === "arcgis" &&
    useAppStore.getState().layers.some((layer) => layer.id === layerId && layer.type === "zarr");
  if (!native && (!instance || typeof instance.setSelector !== "function")) return false;

  await instance?.setSelector?.(selector);

  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === layerId);
  if (layer) {
    store.updateLayer(layerId, {
      source: { ...layer.source, selector },
      metadata: { ...layer.metadata, selector },
    });
  }
  return true;
}

/**
 * Read the data values of a live Zarr layer under a GeoJSON geometry: a `Point`
 * for click-to-value, a `Polygon`/`MultiPolygon` for region statistics.
 *
 * The read side of {@link setZarrLayerSelector}, and the reason a plugin does
 * not need its own zarrita point reader: the renderer already holds the store's
 * grid, so it does the CRS reprojection and fill-value masking itself. Pass a
 * WGS84 `[lng, lat]` straight from a map click; the returned `coordinates` are
 * in the store's **source** CRS (Web Mercator meters for EPSG:3857, degrees for
 * EPSG:4326, source units for a custom proj4 dataset).
 *
 * The renderer answers with empty value arrays rather than an error when the
 * geometry falls outside the store's grid, or when the layer has not finished
 * loading its first chunks — so a query fired immediately after the add can
 * come back empty even though the id is live. An aborted query rejects.
 *
 * `selector` scopes the read only: the layer keeps rendering the slice it is on,
 * so an Identify readout for another time leaves the map alone. Moving the
 * display is {@link setZarrLayerSelector}'s job.
 *
 * @param layerId A layer id returned by {@link addZarrRasterLayer} (or a layer
 *   the Zarr panel added).
 * @param geometry The query geometry, in WGS84.
 * @param selector Dimensions to read instead of the layer's current selector,
 *   e.g. `{ time: 12 }`. Omit to read the slice on screen.
 * @param options `signal` to cancel the read, `includeSpatialCoordinates` to
 *   drop the per-pixel coordinate arrays (default: included).
 * @returns The renderer's result, or null when there is no live Zarr layer with
 *   that id (the counterpart of {@link setZarrLayerSelector} returning false).
 */
export async function queryZarrLayer(
  layerId: string,
  geometry: QueryGeometry,
  selector?: Selector,
  options?: QueryOptions,
): Promise<QueryResult | null> {
  const instance = zarrControl?.getLayersMap().get(layerId) as
    | Pick<ZarrLayer, "queryData">
    | undefined;
  if (!instance || typeof instance.queryData !== "function") return null;

  return instance.queryData(geometry, selector, options);
}
// ----- Zarr time axis --------------------------------------------------------
// A Zarr cube's time is an internal dimension, so the Time Slider drives it
// through a temporal adapter (see `temporal-layers.ts`) rather than by filtering
// features or swapping sources. Registration is best-effort and silent: a store
// with no time axis simply never becomes bindable.

/**
 * What resolving a new layer's time axis needs but the `layeradd` event does not
 * carry: an authenticated store's request headers, and — for a layer whose `url`
 * is not something the metadata walk can fetch — a way to read the coordinate
 * attributes anyway. Cloud-Optimized NetCDF supplies the kerchunk references
 * whose inline `.zattrs` hold them (its `url` names the manifest); a store on
 * local disk supplies a reader over the folder.
 */
interface ZarrTemporalContext {
  headers?: Record<string, string>;
  refs?: KerchunkRefs;
  readAttributes?: ZarrTimeAttributesReader;
}

/**
 * Store URLs with a programmatic add in flight, refcounted.
 *
 * The `layeradd` event carries no correlation token, so a handler firing for one
 * add cannot tell which caller's headers or references belong to it — and two
 * adds of the *same* URL can overlap, because `addCloudNetcdfLayer` runs off
 * `addZarrRasterLayer`'s queue. Rather than guess, the shared handler skips any
 * layer whose URL has a programmatic add running: those callers know both the
 * layer id and their own context, and register the adapter themselves once the
 * add resolves. Only the Zarr panel's own adds (which have no context to get
 * wrong) are registered by the handler.
 */
const programmaticZarrAdds = new Map<string, number>();

/** Mark a programmatic add in flight, returning a disposer for its `finally`. */
function beginProgrammaticZarrAdd(url: string): () => void {
  programmaticZarrAdds.set(url, (programmaticZarrAdds.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (programmaticZarrAdds.get(url) ?? 1) - 1;
    if (remaining > 0) programmaticZarrAdds.set(url, remaining);
    else programmaticZarrAdds.delete(url);
  };
}

// How long to wait for `@carbonplan/zarr-layer` to finish loading its coordinate
// arrays. `addLayer` resolves once the store's metadata is read, but the
// dimension values land a moment later, so the read polls rather than assuming.
const ZARR_DIMENSION_POLL_MS = 250;
const ZARR_DIMENSION_ATTEMPTS = 24;

/**
 * The raw non-spatial coordinate values `@carbonplan/zarr-layer` loaded for a
 * layer.
 *
 * `dimensionValues` is a real instance property but is **not** part of the
 * package's public type surface (it is declared `private`), so this reads it
 * through a structural cast. If the renderer ever renames it, Zarr layers
 * quietly stop offering a Time Slider binding rather than failing the build;
 * `tests/zarr-time-axis.test.ts` asserts the property still exists so the drift
 * shows up in CI instead.
 *
 * @param layerId - A live Zarr layer id.
 * @returns The coordinate values, or null when the layer went away or loaded none.
 */
async function readZarrDimensionValues(
  layerId: string,
): Promise<Record<string, (number | string)[]> | null> {
  if (useAppStore.getState().primaryRenderer === "arcgis") {
    const layer = useAppStore.getState().layers.find((layer) => layer.id === layerId);
    return layer ? readNativeZarrDimensions(layer) : null;
  }
  for (let attempt = 0; attempt < ZARR_DIMENSION_ATTEMPTS; attempt += 1) {
    const instance = zarrControl?.getLayersMap().get(layerId) as
      | { dimensionValues?: Record<string, (number | string)[]> }
      | undefined;
    if (!instance) return null;
    const values = instance.dimensionValues;
    if (values && Object.keys(values).length > 0) return values;
    await new Promise((resolve) => setTimeout(resolve, ZARR_DIMENSION_POLL_MS));
  }
  return null;
}

/**
 * A reader for the CF `units`/`calendar` of a local store's coordinate, or null
 * when this layer is not folder-backed.
 *
 * Coordinates sit beside the data variables, which in a multiscale pyramid is
 * one level down, so both places are tried.
 *
 * @param url - The identifier the layer was added under.
 * @returns A reader over that folder's coordinate attributes, or null.
 */
function localZarrTimeAttributesReader(url: string): ZarrTimeAttributesReader | null {
  const reader = zarrLocalStoreReaders.get(url);
  if (!reader) return null;
  const read = createDirectoryZarrMetadataReader(reader);
  return (dimension: string) => readCoordinateTimeAttributes(read, dimension);
}

/** Read a coordinate's `units`/`calendar` out of an inline kerchunk `.zattrs`. */
function zarrTimeAttributesFromRefs(
  refs: KerchunkRefs | undefined,
  dimension: string,
): { units?: string; calendar?: string } | null {
  const entry = refs?.[`${dimension}/.zattrs`];
  if (typeof entry !== "string") return null;
  try {
    const parsed = JSON.parse(entry) as Record<string, unknown>;
    const units = typeof parsed.units === "string" ? parsed.units : undefined;
    const calendar = typeof parsed.calendar === "string" ? parsed.calendar : undefined;
    return units === undefined && calendar === undefined ? null : { units, calendar };
  } catch {
    return null;
  }
}

/**
 * Resolve a freshly added Zarr layer's time axis and, when it has one, register
 * the temporal adapter that lets the Time Slider step it via
 * {@link setZarrLayerSelector}.
 *
 * The caller supplies its own {@link ZarrTemporalContext}: the `layeradd` event
 * carries no correlation token, so context can only be attributed reliably by
 * the code that started the add.
 *
 * @param layerId - The new layer's id.
 * @param url - The store URL (or kerchunk manifest URL).
 * @param context - The add's headers, references, or attribute reader, when the
 *   caller has them.
 */
function registerZarrTemporalAdapter(
  layerId: string,
  url: string | undefined,
  context: ZarrTemporalContext = {},
): Promise<boolean> {
  const { headers, refs } = context;
  // A folder the panel opened is not something the caller could have passed
  // context for, so fall back to the reader filed under this layer's own url.
  const readAttributes =
    context.readAttributes ?? localZarrTimeAttributesReader(url ?? "") ?? undefined;
  return (async () => {
    const dimensionValues = await readZarrDimensionValues(layerId);
    if (!dimensionValues) return true;
    const dimension = pickTimeDimension(dimensionValues) ?? "time";
    // Either source of attributes replaces the HTTP metadata walk, which for
    // these layers would only produce a run of failed requests.
    const attributes = refs
      ? zarrTimeAttributesFromRefs(refs, dimension)
      : readAttributes
        ? await readAttributes(dimension).catch(() => null)
        : undefined;
    const axis = await resolveZarrTimeAxis(url ?? "", dimensionValues, {
      ...(headers ? { headers } : {}),
      ...(attributes !== undefined ? { attributes } : {}),
    });
    if (!axis) return true;
    // The layer may have been removed while the axis was being resolved.
    if (!useAppStore.getState().layers.some((layer) => layer.id === layerId)) return true;
    if (
      useAppStore.getState().primaryRenderer !== "arcgis" &&
      !zarrControl?.getLayersMap().has(layerId)
    )
      return true;
    registerTemporalLayer(layerId, {
      dimension: axis.dimension,
      getTimeValues: () => axis.values,
      setTime: async (date) => {
        const index = nearestTimeIndex(axis.values, date.getTime());
        if (index < 0) return;
        const current = useAppStore.getState().layers.find((layer) => layer.id === layerId);
        await setZarrLayerSelector(layerId, {
          ...((current?.source.selector as Record<string, number | string>) ?? {}),
          [axis.dimension]: index,
        });
      },
    });
    if (useAppStore.getState().primaryRenderer === "arcgis") {
      // Native layers have no Zarr control to own their temporal cleanup.
      arcgisZarrTemporalUnsubscribes.get(layerId)?.();
      const unsubscribe = useAppStore.subscribe((state, previous) => {
        if (state.layers === previous.layers) return;
        if (state.layers.some((layer) => layer.id === layerId)) return;
        unregisterTemporalLayer(layerId);
        unsubscribe();
        arcgisZarrTemporalUnsubscribes.delete(layerId);
      });
      arcgisZarrTemporalUnsubscribes.set(layerId, unsubscribe);
    }
    return true;
  })().catch((error) => {
    console.warn("[zarr] Could not register the time axis", error);
    return false;
  });
}

export function restoreArcgisZarrLayers(): void {
  for (const layer of useAppStore.getState().layers) {
    if (layer.type !== "zarr") continue;
    if (restoredArcgisZarrLayerIds.has(layer.id)) continue;
    trackRestoredArcgisZarrLayer(layer.id);
    void registerZarrTemporalAdapter(layer.id, String(layer.source.url), {
      headers: layer.source.headers as Record<string, string> | undefined,
      refs: layer.source.kerchunkRefs as KerchunkRefs | undefined,
    }).then((registered) => {
      if (!registered) restoredArcgisZarrLayerIds.delete(layer.id);
    });
  }
}

// The control takes an explicit list of hex colors; the public option also
// accepts a named GeoLibre ramp so a JS plugin need not spell out the stops.
// `interpolateRampColors` falls back to the first built-in ramp for an unknown
// name, mirroring how addCogLayer treats an unrecognized colormap.
function resolveZarrColormap(colormap: string | string[] | undefined): string[] | undefined {
  if (colormap === undefined) return undefined;
  if (Array.isArray(colormap)) return colormap.length > 0 ? colormap : undefined;
  const name = colormap.trim();
  if (!name) return undefined;
  return interpolateRampColors(name, ZARR_COLORMAP_STOPS);
}

async function openStandaloneZarrControl(app: GeoLibreAppAPI): Promise<boolean> {
  const { ZarrLayerControl: ZarrLayerControlClass } = await getComponentsConstructors();

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

function createZarrControl(ZarrLayerControlClass: ZarrLayerControlConstructor): ZarrLayerControl {
  const control = new ZarrLayerControlClass({
    ...ZARR_OPTIONS,
    // Only when the host registered one: without the option the panel shows no
    // Browse folder button, which is what a browser with no directory picker
    // should see.
    ...(zarrLocalStoreProvider ? { localStoreProvider: zarrLocalStoreProvider } : {}),
  });
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
        unregisterTemporalLayer(layer.id);
        store.removeLayer(layer.id);
      }
    }
    pruneZarrLocalStoreReaders();
  });
  zarrStoreUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    const currentById = new Map(state.layers.map((layer) => [layer.id, layer]));

    // Visibility and opacity are applied by the paint bridge (see
    // registerZarrPaintBridge), which layer-sync drives like every other layer
    // property. Only removal is handled here, because a layer dropped from the
    // store no longer reaches sync at all.
    for (const layer of previous.layers) {
      if (!isZarrControlLayer(layer)) continue;
      if (currentById.has(layer.id)) continue;
      unregisterTemporalLayer(layer.id);
      clearExternalNativePaintBridge(layer.id);
      zarrControl?.removeLayer(layer.id);
    }
    pruneZarrLocalStoreReaders();
  });
  return control;
}

// Route the panels' opacity/visibility to the Zarr control's setters. The
// control expresses "hidden" as opacity 0 (a custom layer has no paint), so a
// hidden layer's stored opacity has to travel with the visibility call or
// re-showing it would restore full opacity instead of the user's value.
function registerZarrPaintBridge(layerId: string): void {
  setExternalNativePaintBridge(layerId, {
    setOpacity: (opacity) => {
      const layer = useAppStore.getState().layers.find((item) => item.id === layerId);
      if (layer && !layer.visible) {
        zarrControl?.setLayerVisibility(layerId, false, opacity);
        return;
      }
      zarrControl?.setLayerOpacity(layerId, opacity);
    },
    setVisibility: (visible) => {
      const opacity =
        useAppStore.getState().layers.find((item) => item.id === layerId)?.opacity ?? 1;
      zarrControl?.setLayerVisibility(layerId, visible, opacity);
    },
  });
}

export function teardownZarrControl(app: GeoLibreAppAPI): void {
  zarrStoreUnsubscribe?.();
  zarrStoreUnsubscribe = null;
  if (zarrControl && zarrControlMounted) {
    app.removeMapControl(zarrControl);
  }
  zarrControl = null;
  zarrControlMounted = false;
}

function createZarrLayerAddHandler(): ZarrLayerEventHandler {
  return (event) => {
    if (!event.layerId) return;
    const layerInfo = event.state.layers.find((layer) => layer.id === event.layerId);
    if (!layerInfo) return;

    const store = useAppStore.getState();
    const layer = createZarrStoreLayer(event.layerId, layerInfo);
    // The renderer owns the pixels, so the panel's opacity/visibility reach it
    // through the control's setters rather than MapLibre paint properties.
    registerZarrPaintBridge(layer.id);
    // A cube with a time axis becomes drivable by the Time Slider. Resolving the
    // axis needs the renderer's async metadata load plus a store lookup, so it
    // runs on its own and registers the adapter whenever it lands.
    //
    // Only for the Zarr panel's own adds: a programmatic add knows both its
    // layer id and its own headers/references, which this event cannot be
    // attributed to (see `programmaticZarrAdds`), so it registers its own.
    if (!programmaticZarrAdds.has(layerInfo.url ?? "")) {
      registerZarrTemporalAdapter(layer.id, layerInfo.url);
    }
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

function createZarrStoreLayer(id: string, layerInfo: ZarrLayerInfo): GeoLibreLayer {
  const name =
    layerInfo.name ||
    [layerNameFromUrl(layerInfo.url, id), layerInfo.variable].filter(Boolean).join(" - ");

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
      // The spatial reference the renderer actually used, whether it came from
      // the panel's CRS fields, an addZarrLayer option, or the store's own
      // metadata. Recorded so the Metadata panel and the project file show how a
      // projected store was placed.
      ...(layerInfo.crs ? { crs: layerInfo.crs } : {}),
      ...(layerInfo.proj4 ? { proj4: layerInfo.proj4 } : {}),
      ...(layerInfo.bounds ? { bounds: layerInfo.bounds } : {}),
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
      // A Zarr layer is a MapLibre custom (WebGL) layer with no paint
      // properties: brightness/saturation/contrast/hue would be inert sliders.
      // The Style panel therefore shows the generic controls only, and opacity
      // reaches the renderer through the paint bridge registered alongside this
      // record (opengeos/GeoLibre#1445).
      paintMode: "plugin",
      ...(layerInfo.crs ? { crs: layerInfo.crs } : {}),
      ...(layerInfo.proj4 ? { proj4: layerInfo.proj4 } : {}),
      selector: layerInfo.selector,
      sourceId: layerInfo.id,
      sourceKind: "zarr-url",
      tileType: "raster",
      variable: layerInfo.variable,
    },
    sourcePath: layerInfo.url,
  };
}

function isZarrControlLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "zarr" &&
    layer.metadata.sourceKind === "zarr-url" &&
    layer.metadata.externalNativeLayer === true
  );
}
