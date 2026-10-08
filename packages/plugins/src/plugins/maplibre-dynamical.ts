import { useAppStore, VECTOR_COLOR_RAMPS } from "@geolibre/core";
import proj4 from "proj4";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { createPluginTranslator, pluginDisplayTitle } from "../plugin-i18n";
import { addZarrRasterLayer, setZarrLayerSelector } from "./components/zarr";
import {
  DYNAMICAL_CATALOG_PAGE_URL,
  DYNAMICAL_HOME_URL,
  type DynamicalDataset,
  type DynamicalVariable,
  datasetMapSupport,
  defaultSliceIndex,
  defaultVariableStyle,
  fetchDynamicalCatalog,
  formatLeadTime,
  formatUtc,
  bboxCenter,
  bboxContains,
  isLeadTimeDimension,
  isTemporalDimension,
  memberDimension,
  nearestIndex,
  nearestLongitudeIndex,
  needsRegionalView,
  projectedBounds,
  projectedDimensions,
  projectionFromSpatialRef,
  regionalMinZoom,
  sampleRange,
  seriesCsv,
  seriesDimension,
  seriesWindow,
  sliceDimensions,
  sliceSelectorValue,
  summarizeSeries,
  wrapLongitude,
  type SeriesStep,
} from "./dynamical-api";
import { renderSeriesChart } from "./dynamical-series-chart";
import { registerGribberishCodec } from "./grib2-codec";
import { getStyleMap } from "./style-map";
import {
  DEFAULT_ICECHUNK_BRANCH,
  icechunkLayerUrl,
  icechunkTimeAttributesReader,
  openIcechunkStore,
  repositoryOpenError,
  type ZarrKeyReader,
} from "./stac-icechunk";
import { parseCfTimeUnits } from "./zarr-time-axis";

export const DYNAMICAL_PLUGIN_ID = "geolibre-dynamical";
const PANEL_ID = DYNAMICAL_PLUGIN_ID;
const PLUGIN_NAME = "Dynamical";
/** `metadata.sourceKind` is the Zarr control's; this key marks the layers this panel added. */
const DATASET_METADATA_KEY = "dynamicalDatasetId";
/** How far below its minimum zoom a regional layer still draws. */
const REGIONAL_ZOOM_TOLERANCE = 0.05;
/** Wait this long after a slider stops before re-slicing a live layer. */
const SLICE_DEBOUNCE_MS = 250;

const CSS = {
  panel:
    "display:flex;flex-direction:column;gap:10px;padding:10px;height:100%;" +
    "box-sizing:border-box;overflow-y:auto;color:hsl(var(--foreground));font-size:12px;",
  hint: "margin:0;color:hsl(var(--muted-foreground));line-height:1.45;",
  label: "display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;",
  input:
    "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));",
  info:
    "display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:6px;" +
    "border:1px solid hsl(var(--border));background:hsl(var(--muted));",
  infoSummary: "font-weight:600;cursor:pointer;",
  infoText: "margin:0;font-size:11px;line-height:1.45;",
  facts: "margin:0;padding-inline-start:16px;font-size:11px;line-height:1.5;",
  links: "display:flex;gap:12px;flex-wrap:wrap;font-size:11px;",
  link: "color:hsl(var(--primary));text-decoration:underline;",
  slider: "display:flex;flex-direction:column;gap:2px;",
  sliderHead: "display:flex;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;",
  sliderValue:
    "font-weight:400;color:hsl(var(--muted-foreground));font-variant-numeric:tabular-nums;",
  range: "width:100%;",
  row: "display:flex;gap:8px;",
  primary:
    "padding:7px 10px;border:none;border-radius:6px;background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;",
  secondary:
    "padding:6px 10px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));cursor:pointer;font-weight:600;",
  textButton:
    "padding:0;border:none;background:none;color:hsl(var(--primary));text-decoration:underline;" +
    "cursor:pointer;font-size:11px;",
  table: "width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums;",
  cell: "padding:2px 6px;border-bottom:1px solid hsl(var(--border));text-align:end;",
  status:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;background:hsl(var(--muted));" +
    "color:hsl(var(--muted-foreground));line-height:1.45;",
  statusError:
    "box-sizing:border-box;width:100%;padding:8px;border-radius:6px;" +
    "background:hsl(var(--destructive) / 0.12);color:hsl(var(--destructive));line-height:1.45;",
  attribution: "margin:0;font-size:10px;color:hsl(var(--muted-foreground));line-height:1.4;",
} as const;

/** One non-spatial dimension of the chosen variable, with the steps the slider moves over. */
interface SliceAxis {
  name: string;
  /** What each step reads as. */
  labels: string[];
  /** Raw numeric coordinates, for {@link sliceSelectorValue}; empty when the store has none. */
  coordinates: number[];
  /** Epoch milliseconds for a timestamp axis, seconds for a lead-time axis. */
  values: number[];
}

/** A grid's horizontal coordinates, and how a longitude/latitude reaches them. */
interface GridCoordinates {
  x: { name: string; values: Float64Array };
  y: { name: string; values: Float64Array };
  /** proj4 definition of a projected grid; null for a latitude/longitude grid. */
  projection: string | null;
}

/** The layer this panel added last, which its sliders keep re-slicing. */
interface LiveLayer {
  id: string;
  datasetId: string;
  variable: string;
  /** The name the panel gave it, so a name the user typed is left alone. */
  name: string;
}

/**
 * Panel state, at module scope so a rebuild (a language change) keeps the
 * selection; reset when the plugin deactivates.
 */
interface PanelState {
  datasetId: string | null;
  variable: string | null;
  /** Slider positions, by dimension name, for the chosen dataset. */
  indices: Record<string, number>;
  colormap: string | null;
  min: string;
  max: string;
  aboutOpen: boolean;
  live: LiveLayer | null;
  /** The point a time series was read at; it carries over to other variables and datasets. */
  point: { lng: number; lat: number } | null;
}

function initialState(): PanelState {
  return {
    datasetId: null,
    variable: null,
    indices: {},
    colormap: null,
    min: "",
    max: "",
    aboutOpen: false,
    live: null,
    point: null,
  };
}

let state: PanelState = initialState();
let appRef: GeoLibreAppAPI | null = null;
let unregisterPanel: (() => void) | null = null;
let unsubscribeLocale: (() => void) | null = null;
let panelContainer: HTMLElement | null = null;
let disposePanel: (() => void) | null = null;
/** The catalog, read once per session; a failed read is retried on the next open. */
let catalogPromise: Promise<DynamicalDataset[]> | null = null;
/** Slice axes per repository and variable, read once per session. */
const axesCache = new Map<string, Promise<SliceAxis[]>>();
/** Horizontal grid coordinates per repository, read once per session. */
const gridCache = new Map<string, Promise<GridCoordinates>>();
/** The source and layer marking the point a series was read at. */
const POINT_SOURCE_ID = "geolibre-dynamical-point";
const POINT_LAYER_ID = "geolibre-dynamical-point-circle";

const tr = createPluginTranslator(() => appRef, DYNAMICAL_PLUGIN_ID);

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (content !== undefined) node.textContent = content;
  return node;
}

function link(content: string, href: string): HTMLAnchorElement {
  const anchor = element("a", CSS.link, content);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener";
  return anchor;
}

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = element("label", CSS.label, text);
  label.append(control);
  return label;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadCatalog(): Promise<DynamicalDataset[]> {
  catalogPromise ??= fetchDynamicalCatalog().catch((error: unknown) => {
    catalogPromise = null;
    throw error;
  });
  return catalogPromise;
}

/**
 * Open a dataset's repository, through the reader the STAC browser shares. A virtual repository
 * first teaches zarrita the `gribberish` codec its chunks decode with.
 */
async function openRepository(dataset: DynamicalDataset): Promise<ZarrKeyReader> {
  try {
    if (dataset.virtual) await registerGribberishCodec();
    return await openIcechunkStore(dataset.repositoryUrl, DEFAULT_ICECHUNK_BRANCH);
  } catch (error) {
    throw repositoryOpenError(
      error,
      tr("openFailed", "Could not open the {{name}} repository.", { name: dataset.title }),
    );
  }
}

/** A zarrita group over a repository reader. Imported lazily, like the reader itself. */
async function zarrRoot(store: ZarrKeyReader) {
  const zarr = await import("zarrita");
  // zarrita addresses keys absolutely, which is what the reader wants. Uncast, so a change to
  // either side's contract fails the build rather than the read.
  return { zarr, root: zarr.root(store) };
}

function toNumbers(data: ArrayLike<unknown>): number[] {
  return Array.from(data, (value) => Number(value));
}

/** Milliseconds per unit of a CF duration unit (`seconds`, `hours`), or null. */
function durationUnitMs(units: unknown): number | null {
  if (typeof units !== "string") return null;
  return parseCfTimeUnits(`${units} since 1970-01-01`)?.unitMs ?? null;
}

/**
 * Read the coordinates of each non-spatial dimension, to label the sliders. A dimension with no
 * coordinate array slides over its indices.
 */
function readSliceAxes(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
  store: ZarrKeyReader,
): Promise<SliceAxis[]> {
  const key = JSON.stringify([dataset.repositoryUrl, variable.name]);
  let pending = axesCache.get(key);
  if (!pending) {
    pending = (async () => {
      const { zarr, root } = await zarrRoot(store);
      const axes: SliceAxis[] = [];
      for (const name of sliceDimensions(dataset, variable)) {
        let coordinates: number[] = [];
        let attributes: Record<string, unknown> = {};
        // Only a coordinate the repository lacks falls back to indices. A failed read rejects,
        // which drops the cached promise, rather than labelling the sliders with indices all session.
        if (await store.get(`/${name}/zarr.json`)) {
          const array = await zarr.open.v3(root.resolve(name), { kind: "array" });
          attributes = array.attrs as Record<string, unknown>;
          coordinates = toNumbers((await zarr.get(array)).data as ArrayLike<unknown>);
        } else {
          const size = dataset.dimensions[name]?.size ?? 1;
          coordinates = Array.from({ length: size }, (_, index) => index);
        }
        const time = isTemporalDimension(dataset, name)
          ? parseCfTimeUnits(String(attributes.units ?? dataset.dimensions[name]?.unit ?? ""))
          : null;
        if (time) {
          const values = coordinates.map((value) => time.epochMs + value * time.unitMs);
          axes.push({ name, coordinates, values, labels: values.map(formatUtc) });
        } else if (isLeadTimeDimension(name)) {
          const unitMs = durationUnitMs(attributes.units ?? dataset.dimensions[name]?.unit) ?? 1000;
          const values = coordinates.map((value) => (value * unitMs) / 1000);
          axes.push({ name, coordinates, values, labels: values.map(formatLeadTime) });
        } else {
          axes.push({ name, coordinates, values: coordinates, labels: coordinates.map(String) });
        }
      }
      return axes;
    })();
    axesCache.set(key, pending);
    void pending.catch(() => axesCache.delete(key));
  }
  return pending;
}

/** The renderer selector for the chosen steps. */
function selectorFor(axes: SliceAxis[], indices: Record<string, number>): Record<string, number> {
  const selector: Record<string, number> = {};
  for (const axis of axes) {
    selector[axis.name] = sliceSelectorValue(indices[axis.name] ?? 0, axis.coordinates);
  }
  return selector;
}

/** `init 2026-10-07 06:00 UTC +6 h`, or the analysis time; what a layer name says of its slice. */
function sliceLabel(axes: SliceAxis[], indices: Record<string, number>): string {
  return axes
    .map((axis) => {
      const label = axis.labels[indices[axis.name] ?? 0] ?? "";
      if (axis.name === "init_time") return tr("initLabel", "init {{time}}", { time: label });
      if (isLeadTimeDimension(axis.name) || axis.name === "time") return label;
      return `${axis.name} ${label}`;
    })
    .join(" ");
}

/** The valid time of a forecast slice: the run time plus the lead time. */
function validTime(axes: SliceAxis[], indices: Record<string, number>): number | null {
  const init = axes.find((axis) => axis.name === "init_time");
  const lead = axes.find((axis) => isLeadTimeDimension(axis.name));
  if (!init || !lead) return null;
  const start = init.values[indices[init.name] ?? 0];
  const offset = lead.values[indices[lead.name] ?? 0];
  return Number.isFinite(start) && Number.isFinite(offset) ? start + offset * 1000 : null;
}

/**
 * A value range read from the data: one chunk around the centre of the grid, at the chosen slice.
 * One chunk keeps it to a single read while still landing on the domain rather than its corner.
 */
async function sampleClim(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
  store: ZarrKeyReader,
  axes: SliceAxis[],
  indices: Record<string, number>,
  diverging: boolean,
): Promise<[number, number] | null> {
  const { zarr, root } = await zarrRoot(store);
  const array = await zarr.open.v3(root.resolve(variable.name), { kind: "array" });
  const selection = variable.dimensions.map((name, position) => {
    const axis = axes.find((candidate) => candidate.name === name);
    if (axis) return indices[name] ?? 0;
    const size = array.shape[position] ?? 1;
    const chunk = Math.max(1, Math.min(variable.chunks[position] || size, size));
    const start = Math.floor(size / 2 / chunk) * chunk;
    return zarr.slice(start, Math.min(start + chunk, size));
  });
  const chunk = await zarr.get(array, selection);
  return sampleRange(chunk.data as ArrayLike<number>, diverging);
}

/** The CRS of a projected grid, from its CF `spatial_ref` variable. */
async function readProjection(store: ZarrKeyReader): Promise<string | null> {
  const bytes = await store.get("/spatial_ref/zarr.json");
  if (!bytes) return null;
  try {
    const document = JSON.parse(new TextDecoder().decode(bytes)) as {
      attributes?: Record<string, unknown>;
    };
    return projectionFromSpatialRef(document.attributes ?? {});
  } catch {
    return null;
  }
}

function liveLayerExists(live: LiveLayer | null): live is LiveLayer {
  return Boolean(live && useAppStore.getState().layers.some((layer) => layer.id === live.id));
}

/** The map's size in CSS pixels, which decides how many chunks a view holds. */
function viewportSize(app: GeoLibreAppAPI): { width: number; height: number } {
  const container = getStyleMap(app)?.getContainer();
  return {
    width: container?.clientWidth || window.innerWidth,
    height: container?.clientHeight || window.innerHeight,
  };
}

/**
 * Bring the map in to a regional layer's minimum zoom before it is added, so the renderer's first
 * read covers a region rather than the globe. Stays over the current view when the dataset covers
 * it, and moves to the dataset otherwise.
 *
 * Returns:
 *   A function that puts the camera back, for an add that fails; null when nothing moved.
 */
function zoomInForRegionalLayer(
  app: GeoLibreAppAPI,
  dataset: DynamicalDataset,
  minZoom: number,
): (() => void) | null {
  const map = getStyleMap(app);
  if (!map) return null;
  const center = map.getCenter();
  const zoom = map.getZoom();
  const bbox = dataset.bbox;
  const inside = !bbox || bboxContains(bbox, center.lng, center.lat);
  if (zoom >= minZoom && inside) return null;
  map.jumpTo({ center: inside ? center : bboxCenter(bbox), zoom: Math.max(zoom, minZoom) });
  return () => map.jumpTo({ center, zoom });
}

/**
 * Hide a regional layer below its minimum zoom, where a view would read more chunks than the
 * budget allows.
 *
 * MapLibre skips a layer's render passes outside its zoom range, and the renderer only fetches from
 * them, so this keeps a zoomed-out view (or a re-slice while zoomed out) from reading anything. The
 * Zarr control has no zoom option and the layer sync leaves control-rendered layers' zoom ranges
 * alone, so the range is set here. The renderer also fetches once while it initializes, gated on
 * its own minimum zoom rather than MapLibre's; that is set too, when the renderer still has the
 * field, for a view zoomed out while the layer's metadata loads.
 */
function applyRegionalZoomRange(app: GeoLibreAppAPI, layerId: string, minZoom: number): void {
  const map = getStyleMap(app);
  const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
  if (!map || !layer) return;
  // A zoom animation can settle a hair short of a whole level (3.9999 shows as "4.00"), which
  // would leave the layer hidden at the zoom the panel names; the margin widens a view by ~3%.
  const threshold = Math.max(0, minZoom - REGIONAL_ZOOM_TOLERANCE);
  const nativeIds = layer.metadata.nativeLayerIds;
  for (const nativeId of Array.isArray(nativeIds) ? nativeIds : []) {
    if (typeof nativeId !== "string") continue;
    const native = map.getLayer(nativeId) as { implementation?: { minZoom?: unknown } } | undefined;
    if (!native) continue;
    map.setLayerZoomRange(nativeId, threshold, 24);
    const renderer = native.implementation;
    if (renderer && typeof renderer.minZoom === "number") renderer.minZoom = threshold;
  }
}

/** Read a 1-D coordinate array. */
async function readCoordinate(store: ZarrKeyReader, name: string): Promise<Float64Array> {
  const { zarr, root } = await zarrRoot(store);
  const array = await zarr.open.v3(root.resolve(name), { kind: "array" });
  return Float64Array.from((await zarr.get(array)).data as ArrayLike<number>, Number);
}

/** A grid's horizontal coordinates and CRS, read once per repository. */
function readGridCoordinates(
  dataset: DynamicalDataset,
  store: ZarrKeyReader,
): Promise<GridCoordinates> {
  let pending = gridCache.get(dataset.repositoryUrl);
  if (!pending) {
    pending = (async () => {
      const spatial = Object.values(dataset.dimensions).filter((dim) => dim.type === "spatial");
      const xName =
        spatial.find((dim) => dim.axis === "x" || dim.name === "longitude")?.name ?? "longitude";
      const yName =
        spatial.find((dim) => dim.axis === "y" || dim.name === "latitude")?.name ?? "latitude";
      const projected = projectedDimensions(dataset);
      const [x, y, projection] = await Promise.all([
        readCoordinate(store, xName),
        readCoordinate(store, yName),
        projected ? readProjection(store) : Promise.resolve(null),
      ]);
      if (projected && !projection) throw new Error("The grid's CRS could not be read.");
      return { x: { name: xName, values: x }, y: { name: yName, values: y }, projection };
    })();
    gridCache.set(dataset.repositoryUrl, pending);
    void pending.catch(() => gridCache.delete(dataset.repositoryUrl));
  }
  return pending;
}

/**
 * The grid cell nearest a longitude/latitude, as an index per horizontal dimension.
 *
 * Returns:
 *   The indices, or null when the point falls outside the grid.
 */
function locateCell(
  grid: GridCoordinates,
  lng: number,
  lat: number,
): Record<string, number> | null {
  let column: number | null;
  let row: number | null;
  if (grid.projection) {
    const [x, y] = proj4("EPSG:4326", grid.projection, [lng, lat]) as [number, number];
    column = nearestIndex(grid.x.values, x);
    row = nearestIndex(grid.y.values, y);
  } else {
    column = nearestLongitudeIndex(grid.x.values, wrapLongitude(lng, grid.x.values));
    row = nearestIndex(grid.y.values, lat);
  }
  return column === null || row === null ? null : { [grid.x.name]: column, [grid.y.name]: row };
}

/** A point's series, read and summarized, with what the chart and CSV need to say about it. */
interface PointSeries {
  steps: SeriesStep[];
  /** The window's first step along the series dimension. */
  start: number;
  dimension: string;
  members: number;
}

/**
 * Read one grid cell of a variable along its series dimension, every ensemble member included,
 * over the window {@link seriesWindow} allows; other dimensions stay at the panel's steps.
 */
async function readPointSeries(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
  store: ZarrKeyReader,
  axes: SliceAxis[],
  indices: Record<string, number>,
  cell: Record<string, number>,
): Promise<PointSeries | null> {
  const dimension = seriesDimension(dataset, variable);
  const axis = axes.find((candidate) => candidate.name === dimension);
  if (!dimension || !axis) return null;
  const [start, end] = seriesWindow(
    dataset,
    variable,
    dimension,
    indices[dimension] ?? 0,
    axis.labels.length,
  );
  const member = memberDimension(dataset, variable);
  const { zarr, root } = await zarrRoot(store);
  const array = await zarr.open.v3(root.resolve(variable.name), { kind: "array" });
  const selection = variable.dimensions.map((name) => {
    if (name === dimension) return zarr.slice(start, end);
    if (name === member) return null;
    return cell[name] ?? indices[name] ?? 0;
  });
  const chunk = await zarr.get(array, selection);
  const data = chunk.data as ArrayLike<number>;
  // What is left of the array's dimensions: the series and, for an ensemble, the members.
  const kept = variable.dimensions.filter((name) => name === dimension || name === member);
  const stepStride = chunk.stride[kept.indexOf(dimension)] ?? 1;
  const memberAxis = member ? kept.indexOf(member) : -1;
  const memberCount = memberAxis >= 0 ? chunk.shape[memberAxis] : 1;
  const memberStride = memberAxis >= 0 ? chunk.stride[memberAxis] : 0;

  // A forecast's steps are lead times after its run; an analysis's are times already.
  const init = axes.find((candidate) => candidate.name === "init_time");
  const runStart = init ? init.values[indices[init.name] ?? 0] : 0;
  const times: number[] = [];
  const values: Float64Array[] = [];
  for (let step = 0; step < end - start; step += 1) {
    const raw = axis.values[start + step];
    times.push(isLeadTimeDimension(dimension) ? runStart + raw * 1000 : raw);
    const row = new Float64Array(memberCount);
    for (let m = 0; m < memberCount; m += 1) {
      row[m] = Number(data[step * stepStride + m * memberStride]);
    }
    values.push(row);
  }
  return { steps: summarizeSeries(times, values), start, dimension, members: memberCount };
}

/**
 * The map's `styledata`/`sourcedata` listener that puts the point marker back after a basemap
 * change drops it, while a marker is shown. `styledata` can fire before the new style has loaded,
 * so `sourcedata` retries once it has.
 */
let markerHeal: {
  map: { off(type: "styledata" | "sourcedata", listener: () => void): unknown };
  listener: () => void;
} | null = null;

function stopMarkerHeal(): void {
  markerHeal?.map.off("styledata", markerHeal.listener);
  markerHeal?.map.off("sourcedata", markerHeal.listener);
  markerHeal = null;
}

/** Mark the point a series was read at, and keep it marked across style changes. */
function showPointMarker(app: GeoLibreAppAPI, lng: number, lat: number): void {
  const map = getStyleMap(app);
  if (!map) return;
  stopMarkerHeal();
  const listener = () => {
    if (map.isStyleLoaded() && !map.getSource(POINT_SOURCE_ID)) addPointMarker(map, lng, lat);
  };
  map.on("styledata", listener);
  map.on("sourcedata", listener);
  markerHeal = { map, listener };
  addPointMarker(map, lng, lat);
}

function addPointMarker(
  map: NonNullable<ReturnType<typeof getStyleMap>>,
  lng: number,
  lat: number,
) {
  const data = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: {},
        geometry: { type: "Point" as const, coordinates: [lng, lat] },
      },
    ],
  };
  const source = map.getSource(POINT_SOURCE_ID) as
    | { setData?: (data: unknown) => void }
    | undefined;
  if (source?.setData) {
    source.setData(data);
    return;
  }
  map.addSource(POINT_SOURCE_ID, { type: "geojson", data });
  map.addLayer({
    id: POINT_LAYER_ID,
    type: "circle",
    source: POINT_SOURCE_ID,
    paint: {
      "circle-radius": 6,
      "circle-color": "#ffffff",
      "circle-stroke-color": "#111827",
      "circle-stroke-width": 2,
    },
  });
}

function removePointMarker(app: GeoLibreAppAPI | null): void {
  stopMarkerHeal();
  const map = getStyleMap(app);
  if (!map) return;
  if (map.getLayer(POINT_LAYER_ID)) map.removeLayer(POINT_LAYER_ID);
  if (map.getSource(POINT_SOURCE_ID)) map.removeSource(POINT_SOURCE_ID);
}

/**
 * The regional layers this panel added, by layer id, so a resize can recompute their minimum
 * zoom: the budget is per view, and a larger map at the same zoom holds more chunks.
 */
const regionalLayers = new Map<
  string,
  { dataset: DynamicalDataset; variable: DynamicalVariable }
>();
/** The map the resize listener is on, and the listener, while any regional layer exists. */
let resizeWatch: {
  map: { off(type: "resize", listener: () => void): unknown };
  listener: () => void;
} | null = null;

function stopResizeWatch(): void {
  resizeWatch?.map.off("resize", resizeWatch.listener);
  resizeWatch = null;
}

/** Re-apply every live regional layer's minimum zoom for the map's current size. */
function refreshRegionalZoomRanges(app: GeoLibreAppAPI): void {
  const layers = useAppStore.getState().layers;
  for (const [layerId, entry] of regionalLayers) {
    if (!layers.some((layer) => layer.id === layerId)) {
      regionalLayers.delete(layerId);
      continue;
    }
    applyRegionalZoomRange(
      app,
      layerId,
      regionalMinZoom(entry.dataset, entry.variable, viewportSize(app)),
    );
  }
  if (!regionalLayers.size) stopResizeWatch();
}

/** Track a regional layer, listening for map resizes while any exists. */
function watchRegionalLayer(
  app: GeoLibreAppAPI,
  layerId: string,
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
): void {
  regionalLayers.set(layerId, { dataset, variable });
  const map = getStyleMap(app);
  if (!map || resizeWatch?.map === map) return;
  stopResizeWatch();
  const listener = () => refreshRegionalZoomRanges(app);
  map.on("resize", listener);
  resizeWatch = { map, listener };
}

/**
 * Re-slices run one after another, so an older one cannot land last. Module-wide, so a panel
 * rebuilt for a language change queues behind the one it replaced.
 */
let sliceChain: Promise<void> = Promise.resolve();

function buildPanel(container: HTMLElement): () => void {
  container.replaceChildren();
  container.style.cssText = CSS.panel;
  let disposed = false;
  let catalog: DynamicalDataset[] = [];
  let axes: SliceAxis[] = [];
  let axesRequest = 0;
  let busy = false;
  /** Whether `axes` belongs to the chosen variable; Add waits for it. */
  let axesReady = false;
  let sliceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the status line holds a re-slice failure, which the next success clears. */
  let sliceErrorShown = false;

  const statusBox = element("div");
  const setStatus = (message: string | null, error = false): void => {
    if (disposed) return;
    if (!message) {
      statusBox.style.display = "none";
      return;
    }
    statusBox.style.cssText = error ? CSS.statusError : CSS.status;
    statusBox.textContent = message;
  };
  setStatus(null);

  // --- About ----------------------------------------------------------------
  const about = element("details", CSS.info);
  about.open = state.aboutOpen;
  about.addEventListener("toggle", () => {
    state.aboutOpen = about.open;
  });
  const aboutLinks = element("div", CSS.links);
  aboutLinks.append(
    link("dynamical.org", DYNAMICAL_HOME_URL),
    link(tr("catalogLink", "Data catalog"), DYNAMICAL_CATALOG_PAGE_URL),
  );
  about.append(
    element("summary", CSS.infoSummary, tr("aboutSummary", "About dynamical.org")),
    element(
      "p",
      CSS.infoText,
      tr(
        "aboutText",
        "dynamical.org publishes weather forecasts and analyses from NOAA, ECMWF, DWD, ECCC and NASA as free, cloud-optimized Icechunk (Zarr) archives, updated as each model run lands.",
      ),
    ),
    element(
      "p",
      CSS.infoText,
      tr(
        "aboutAccess",
        "GeoLibre reads the archives straight from their cloud storage, one map slice at a time, and decodes the low-latency virtual datasets from the producers' original GRIB2 files. Analyses and ensembles store a long time series in every chunk, so they draw a region at a time, once the map is zoomed in.",
      ),
    ),
    aboutLinks,
  );

  // --- Controls -------------------------------------------------------------
  const datasetSelect = element("select", CSS.input);
  const datasetInfo = element("div", CSS.info);
  datasetInfo.style.display = "none";
  const variableSelect = element("select", CSS.input);
  const variableLabel = labelled(tr("variable", "Variable"), variableSelect);
  const slidersBox = element("div", "display:flex;flex-direction:column;gap:8px;");
  const validLine = element("div", CSS.hint);
  const regionalLine = element("p", CSS.hint);

  const colormapSelect = element("select", CSS.input);
  for (const ramp of VECTOR_COLOR_RAMPS) {
    const option = element("option", undefined, ramp.label);
    option.value = ramp.value;
    colormapSelect.append(option);
  }
  const minInput = element("input", CSS.input);
  const maxInput = element("input", CSS.input);
  for (const input of [minInput, maxInput]) {
    input.type = "number";
    input.step = "any";
    input.placeholder = tr("auto", "Auto");
  }
  const rangeRow = element("div", CSS.row);
  rangeRow.append(labelled(tr("min", "Min"), minInput), labelled(tr("max", "Max"), maxInput));
  const styleBox = element("div", "display:flex;flex-direction:column;gap:8px;");
  styleBox.append(labelled(tr("colormap", "Colormap"), colormapSelect), rangeRow);

  const addButton = element("button", CSS.primary, tr("addToMap", "Add to map"));
  addButton.type = "button";
  const attribution = element("p", CSS.attribution);

  const editor = element("div", "display:flex;flex-direction:column;gap:10px;");
  editor.append(
    variableLabel,
    slidersBox,
    validLine,
    styleBox,
    regionalLine,
    addButton,
    attribution,
  );
  editor.style.display = "none";

  // --- Point time series ----------------------------------------------------
  const seriesBox = element("div", CSS.info);
  seriesBox.style.display = "none";
  const seriesHint = element("p", CSS.infoText);
  const pickButton = element("button", CSS.secondary, tr("pickPoint", "Pick a point on the map"));
  pickButton.type = "button";
  const seriesStatus = element("p", CSS.infoText);
  const seriesHeading = element("div", "font-weight:600;font-size:12px;");
  const seriesSubtitle = element("div", `${CSS.hint}font-size:11px;`);
  const chartBox = element("div");
  const seriesFooter = element("div", CSS.links);
  const csvButton = element("button", CSS.textButton, tr("downloadCsv", "Download CSV"));
  csvButton.type = "button";
  seriesFooter.append(
    element(
      "span",
      CSS.hint,
      tr("seriesPickHint", "Click the chart to show that step on the map."),
    ),
    csvButton,
  );
  const tableDetails = element("details");
  tableDetails.append(element("summary", CSS.infoSummary, tr("showValues", "Show values")));
  const seriesResult = element("div", "display:flex;flex-direction:column;gap:6px;");
  seriesResult.append(seriesHeading, seriesSubtitle, chartBox, seriesFooter, tableDetails);
  seriesResult.style.display = "none";
  seriesBox.append(
    element("div", CSS.infoSummary, tr("seriesTitle", "Time series at a point")),
    seriesHint,
    pickButton,
    seriesStatus,
    seriesResult,
  );

  container.append(
    element(
      "p",
      CSS.hint,
      tr(
        "hint",
        "Add weather forecasts and analyses from dynamical.org's open data catalog. Pick a dataset, a variable and a forecast run, then step through the lead times.",
      ),
    ),
    about,
    labelled(tr("dataset", "Dataset"), datasetSelect),
    datasetInfo,
    editor,
    seriesBox,
    statusBox,
  );

  const currentDataset = (): DynamicalDataset | undefined =>
    catalog.find((dataset) => dataset.id === state.datasetId);
  const currentVariable = (): DynamicalVariable | undefined =>
    currentDataset()?.variables.find((variable) => variable.name === state.variable);

  const unsupportedReason = (dataset: DynamicalDataset): string | null =>
    datasetMapSupport(dataset) === "time-series"
      ? tr("unsupportedTimeSeries", "time-series layout, too large to map")
      : null;

  /** The chosen variable's minimum zoom, or 0 when it draws at any zoom. */
  const currentMinZoom = (): number => {
    const dataset = currentDataset();
    const variable = currentVariable();
    if (!appRef || !dataset || !variable || !needsRegionalView(dataset, variable)) return 0;
    return regionalMinZoom(dataset, variable, viewportSize(appRef));
  };

  const renderRegionalHint = (): void => {
    const minZoom = currentMinZoom();
    regionalLine.style.display = minZoom > 0 ? "" : "none";
    regionalLine.textContent =
      minZoom > 0
        ? tr(
            "regionalHint",
            "This dataset stores a long time series in every chunk, so it draws a region at a time: from zoom {{zoom}} in. Adding it zooms the map in if needed.",
            { zoom: minZoom },
          )
        : "";
  };

  const renderDatasets = (): void => {
    const placeholder = element(
      "option",
      undefined,
      catalog.length
        ? tr("chooseDataset", "Choose a dataset…")
        : tr("loading", "Loading the catalog…"),
    );
    placeholder.value = "";
    datasetSelect.replaceChildren(placeholder);
    const supported = element("optgroup");
    supported.label = tr("groupSupported", "Map-ready");
    const regional = element("optgroup");
    regional.label = tr("groupRegional", "Regional: draws when zoomed in");
    const unsupported = element("optgroup");
    unsupported.label = tr("groupUnsupported", "Not available in the browser");
    for (const dataset of catalog) {
      const reason = unsupportedReason(dataset);
      const option = element(
        "option",
        undefined,
        reason ? `${dataset.title} (${reason})` : dataset.title,
      );
      option.value = dataset.id;
      option.disabled = Boolean(reason);
      if (reason) unsupported.append(option);
      else if (datasetMapSupport(dataset) === "regional") regional.append(option);
      else supported.append(option);
    }
    if (supported.children.length) datasetSelect.append(supported);
    if (regional.children.length) datasetSelect.append(regional);
    if (unsupported.children.length) datasetSelect.append(unsupported);
    const dataset = currentDataset();
    datasetSelect.value = dataset && !unsupportedReason(dataset) ? dataset.id : "";
  };

  const renderDatasetInfo = (dataset: DynamicalDataset | undefined): void => {
    datasetInfo.replaceChildren();
    if (!dataset) {
      datasetInfo.style.display = "none";
      return;
    }
    datasetInfo.style.cssText = CSS.info;
    if (dataset.summary || dataset.description) {
      // The summaries are Markdown; only their `code` spans would show as such in plain text.
      const summary = (dataset.summary || dataset.description).replace(/`([^`]*)`/g, "$1");
      datasetInfo.append(element("p", CSS.infoText, summary));
    }
    const facts = element("ul", CSS.facts);
    for (const fact of [
      [dataset.spatialDomain, dataset.spatialResolution].filter(Boolean).join(" · "),
      dataset.timeDomain,
      dataset.forecastDomain,
    ]) {
      if (fact) facts.append(element("li", undefined, fact));
    }
    if (facts.children.length) datasetInfo.append(facts);
    const links = element("div", CSS.links);
    links.append(link(tr("docs", "Documentation"), dataset.docsUrl));
    if (dataset.bbox) {
      const bbox = dataset.bbox;
      const zoom = element("a", CSS.link, tr("zoom", "Zoom to extent"));
      zoom.href = "#";
      zoom.addEventListener("click", (event) => {
        event.preventDefault();
        appRef?.fitBounds?.(bbox);
      });
      links.append(zoom);
    }
    datasetInfo.append(links);
  };

  const renderVariables = (dataset: DynamicalDataset): void => {
    variableSelect.replaceChildren();
    for (const variable of dataset.variables) {
      const option = element(
        "option",
        undefined,
        variable.unit ? `${variable.longName} (${variable.unit})` : variable.longName,
      );
      option.value = variable.name;
      if (variable.comment) option.title = variable.comment;
      variableSelect.append(option);
    }
    if (!dataset.variables.some((variable) => variable.name === state.variable)) {
      state.variable =
        dataset.variables.find((variable) => variable.name === "temperature_2m")?.name ??
        dataset.variables[0]?.name ??
        null;
    }
    variableSelect.value = state.variable ?? "";
  };

  /** Fill the colormap and range from the variable's defaults. */
  const applyStyleDefaults = (variable: DynamicalVariable): void => {
    const style = defaultVariableStyle(variable);
    state.colormap = style.colormap;
    state.min = style.clim ? String(style.clim[0]) : "";
    state.max = style.clim ? String(style.clim[1]) : "";
    renderStyle();
  };

  const renderStyle = (): void => {
    colormapSelect.value = state.colormap ?? "viridis";
    minInput.value = state.min;
    maxInput.value = state.max;
  };

  const renderValidTime = (): void => {
    const valid = validTime(axes, state.indices);
    validLine.textContent =
      valid === null ? "" : tr("validTime", "Valid {{time}}", { time: formatUtc(valid) });
    validLine.style.display = valid === null ? "none" : "";
  };

  const axisTitle = (name: string): string => {
    if (name === "init_time") return tr("axisInit", "Forecast run");
    if (isLeadTimeDimension(name)) return tr("axisLead", "Lead time");
    if (name === "time") return tr("axisTime", "Time");
    if (name === "ensemble_member") return tr("axisMember", "Ensemble member");
    return name;
  };

  const renderSliders = (): void => {
    slidersBox.replaceChildren();
    for (const axis of axes) {
      const wrap = element("div", CSS.slider);
      const head = element("div", CSS.sliderHead);
      const value = element("span", CSS.sliderValue);
      head.append(element("span", undefined, axisTitle(axis.name)), value);
      const range = element("input", CSS.range);
      range.type = "range";
      range.min = "0";
      range.max = String(Math.max(0, axis.labels.length - 1));
      range.step = "1";
      range.value = String(state.indices[axis.name] ?? 0);
      range.setAttribute("aria-label", axisTitle(axis.name));
      value.textContent = axis.labels[state.indices[axis.name] ?? 0] ?? "";
      range.disabled = axis.labels.length < 2;
      range.addEventListener("input", () => {
        state.indices[axis.name] = Number(range.value);
        value.textContent = axis.labels[state.indices[axis.name]] ?? "";
        renderValidTime();
        scheduleLiveSlice();
        refreshSeries(axis.name);
      });
      wrap.append(head, range);
      slidersBox.append(wrap);
    }
    renderValidTime();
  };

  /** Read the chosen variable's slice axes, then lay out the sliders. */
  const loadAxes = async (): Promise<void> => {
    const dataset = currentDataset();
    const variable = currentVariable();
    if (!dataset || !variable) return;
    const request = ++axesRequest;
    axes = [];
    axesReady = false;
    seriesBox.style.display = "none";
    slidersBox.replaceChildren(
      element("div", CSS.hint, tr("readingAxes", "Reading the time axes…")),
    );
    addButton.disabled = true;
    try {
      const store = await openRepository(dataset);
      const read = await readSliceAxes(dataset, variable, store);
      if (disposed || request !== axesRequest) return;
      axes = read;
      const indices: Record<string, number> = {};
      for (const axis of axes) {
        const remembered = state.indices[axis.name];
        indices[axis.name] =
          remembered !== undefined && remembered < axis.labels.length
            ? remembered
            : defaultSliceIndex(dataset, axis.name, axis.labels.length);
      }
      state.indices = indices;
      axesReady = true;
      renderSliders();
      addButton.disabled = busy;
      renderSeriesHint();
      // A picked point carries over to the new variable or dataset.
      if (state.point) void readSeries();
      else clearSeries();
    } catch (error) {
      if (disposed || request !== axesRequest) return;
      slidersBox.replaceChildren();
      setStatus(errorMessage(error), true);
    }
  };

  const chooseDataset = (id: string): void => {
    const changed = id !== state.datasetId;
    state.datasetId = id || null;
    const dataset = currentDataset();
    renderDatasetInfo(dataset);
    if (!dataset) {
      editor.style.display = "none";
      seriesBox.style.display = "none";
      return;
    }
    if (changed) state.indices = {};
    // Back to its flex column: an empty display would make it a block and drop the gaps.
    editor.style.display = "flex";
    attribution.textContent = [
      dataset.attribution,
      dataset.license ? tr("license", "License: {{license}}", { license: dataset.license }) : "",
    ]
      .filter(Boolean)
      .join(" ");
    const previousVariable = state.variable;
    renderVariables(dataset);
    renderRegionalHint();
    const variable = currentVariable();
    if (variable && (changed || previousVariable !== state.variable || !state.colormap)) {
      applyStyleDefaults(variable);
    } else {
      renderStyle();
    }
    setStatus(null);
    void loadAxes();
  };

  /** Re-slice the live layer once the slider settles. */
  const scheduleLiveSlice = (): void => {
    if (sliceTimer) clearTimeout(sliceTimer);
    sliceTimer = setTimeout(() => {
      sliceTimer = null;
      sliceChain = sliceChain.then(applyLiveSlice).catch((error: unknown) => {
        sliceErrorShown = true;
        setStatus(
          tr("resliceFailed", "Could not show that slice: {{message}}", {
            message: errorMessage(error),
          }),
          true,
        );
      });
    }, SLICE_DEBOUNCE_MS);
  };

  const applyLiveSlice = async (): Promise<void> => {
    if (disposed) return;
    const live = state.live;
    const dataset = currentDataset();
    if (!liveLayerExists(live) || !dataset || live.datasetId !== dataset.id) return;
    if (live.variable !== state.variable || !axesReady) return;
    const sliceAxes = axes;
    const indices = { ...state.indices };
    const applied = await setZarrLayerSelector(live.id, selectorFor(sliceAxes, indices));
    if (!applied || disposed) return;
    // The slice now shown is fine, whatever an earlier one reported.
    if (sliceErrorShown) {
      sliceErrorShown = false;
      setStatus(null);
    }
    const store = useAppStore.getState();
    const layer = store.layers.find((entry) => entry.id === live.id);
    // The variable that was sliced, even if another is chosen by now.
    const variable = dataset.variables.find((entry) => entry.name === live.variable);
    // The current record, not the one read before the await: a name the user typed meanwhile wins.
    const current = state.live;
    if (!layer || !variable || current?.id !== live.id || layer.name !== current.name) return;
    const name = layerName(dataset, variable, sliceAxes, indices);
    store.updateLayer(live.id, { name });
    state.live = { ...current, name };
  };

  const layerName = (
    dataset: DynamicalDataset,
    variable: DynamicalVariable,
    sliceAxes: SliceAxis[],
    indices: Record<string, number>,
  ): string =>
    [dataset.title, variable.longName, sliceLabel(sliceAxes, indices)].filter(Boolean).join(" · ");

  const readRange = (): [number, number] | null => {
    const min = state.min.trim() === "" ? Number.NaN : Number(state.min);
    const max = state.max.trim() === "" ? Number.NaN : Number(state.max);
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? [min, max] : null;
  };

  const addLayer = async (): Promise<void> => {
    const app = appRef;
    const dataset = currentDataset();
    const variable = currentVariable();
    if (!app || !dataset || !variable || busy || !axesReady) return;
    busy = true;
    addButton.disabled = true;
    // The slice as it was clicked: changing the selection mid-add reloads the shared axes.
    const sliceAxes = axes;
    const indices = { ...state.indices };
    const stillChosen = () => state.datasetId === dataset.id && state.variable === variable.name;
    let restoreCamera: (() => void) | null = null;
    try {
      setStatus(tr("opening", "Opening {{name}}…", { name: dataset.title }));
      const store = await openRepository(dataset);
      const style = defaultVariableStyle(variable);
      let clim = readRange();
      if (!clim) {
        setStatus(tr("sampling", "Reading a sample to set the color range…"));
        clim = await sampleClim(
          dataset,
          variable,
          store,
          sliceAxes,
          indices,
          Boolean(style.diverging),
        );
        if (clim && !disposed && stillChosen()) {
          state.min = String(clim[0]);
          state.max = String(clim[1]);
          renderStyle();
        }
      }
      const projected = projectedDimensions(dataset);
      const proj4 = projected ? await readProjection(store) : null;
      const bounds = projected ? projectedBounds(dataset) : null;
      const name = layerName(dataset, variable, sliceAxes, indices);
      const minZoom = needsRegionalView(dataset, variable)
        ? regionalMinZoom(dataset, variable, viewportSize(app))
        : 0;
      // The jump has to come before the add, which fetches as it initializes; a failed add puts
      // the camera back.
      restoreCamera = minZoom > 0 ? zoomInForRegionalLayer(app, dataset, minZoom) : null;
      setStatus(tr("adding", "Adding {{name}}…", { name: variable.longName }));
      const layerId = await addZarrRasterLayer(app, {
        url: icechunkLayerUrl(dataset.repositoryUrl, DEFAULT_ICECHUNK_BRANCH),
        // The renderer's `store` takes `get(key: string)` where the reader wants a rooted key;
        // zarrita addresses keys absolutely, so it holds (as in the STAC browser).
        store,
        readTimeAttributes: icechunkTimeAttributesReader(store),
        variable: variable.name,
        name,
        selector: selectorFor(sliceAxes, indices),
        colormap: state.colormap ?? style.colormap,
        ...(clim ? { clim } : {}),
        ...(projected ? { spatialDimensions: projected } : {}),
        ...(proj4 ? { proj4 } : {}),
        ...(bounds ? { bounds } : {}),
        ...(minZoom > 0 ? { minZoom: Math.max(0, minZoom - REGIONAL_ZOOM_TOLERANCE) } : {}),
      });
      // The layer is on the map, drawing at the zoom the camera moved to.
      restoreCamera = null;
      if (minZoom > 0) applyRegionalZoomRange(app, layerId, minZoom);
      // Tracked even at a minimum zoom of 0: a larger map later can need one.
      if (needsRegionalView(dataset, variable)) {
        watchRegionalLayer(app, layerId, dataset, variable);
      }
      const layer = useAppStore.getState().layers.find((entry) => entry.id === layerId);
      if (layer) {
        useAppStore.getState().updateLayer(layerId, {
          metadata: {
            ...layer.metadata,
            [DATASET_METADATA_KEY]: dataset.id,
            attribution: dataset.attribution,
            ...(dataset.license ? { license: dataset.license } : {}),
            ...(dataset.bbox ? { bounds: dataset.bbox } : {}),
          },
        });
      }
      state.live = { id: layerId, datasetId: dataset.id, variable: variable.name, name };
      setStatus(
        minZoom > 0
          ? tr(
              "addedRegional",
              "Added {{name}}. It draws from zoom {{zoom}} in and hides when zoomed out further; each new region takes a few seconds.",
              { name: variable.longName, zoom: minZoom },
            )
          : sliceAxes.length
            ? tr(
                "addedLive",
                "Added {{name}}. Move the sliders to re-slice it; the first view of a region can take a few seconds.",
                { name: variable.longName },
              )
            : tr("added", "Added {{name}}.", { name: variable.longName }),
      );
    } catch (error) {
      restoreCamera?.();
      setStatus(
        tr("addFailed", "Could not add the layer: {{message}}", { message: errorMessage(error) }),
        true,
      );
    } finally {
      busy = false;
      if (!disposed) addButton.disabled = !axesReady;
    }
  };

  // --- Point time series: reading and drawing --------------------------------
  let series: (PointSeries & { datasetId: string; variable: DynamicalVariable }) | null = null;
  let seriesRequest = 0;
  let seriesTimer: ReturnType<typeof setTimeout> | null = null;
  let stopChart: (() => void) | null = null;
  let cancelPick: (() => void) | null = null;

  const setSeriesStatus = (message: string | null): void => {
    seriesStatus.textContent = message ?? "";
    seriesStatus.style.display = message ? "" : "none";
  };
  setSeriesStatus(null);

  const clearSeries = (): void => {
    // A read still in flight is for what was cleared.
    seriesRequest += 1;
    series = null;
    seriesResult.style.opacity = "";
    stopChart?.();
    stopChart = null;
    chartBox.replaceChildren();
    seriesResult.style.display = "none";
  };

  /** Show the card, with the window a pick would read, once the slice axes are known. */
  const renderSeriesHint = (): void => {
    const dataset = currentDataset();
    const variable = currentVariable();
    const dimension = dataset && variable ? seriesDimension(dataset, variable) : null;
    const axis = axes.find((candidate) => candidate.name === dimension);
    if (!dataset || !variable || !dimension || !axis || !axesReady) {
      seriesBox.style.display = "none";
      return;
    }
    seriesBox.style.cssText = CSS.info;
    const [start, end] = seriesWindow(
      dataset,
      variable,
      dimension,
      state.indices[dimension] ?? 0,
      axis.labels.length,
    );
    seriesHint.textContent = tr(
      "seriesHint",
      "Click the map to chart {{name}} at one grid cell, from {{from}} to {{to}} ({{count}} steps).",
      {
        name: variable.longName,
        from: axis.labels[start] ?? "",
        to: axis.labels[end - 1] ?? "",
        count: end - start,
      },
    );
  };

  const renderTable = (): void => {
    tableDetails.querySelector("table")?.remove();
    if (!tableDetails.open || !series) return;
    const ensemble = series.members > 1;
    const table = element("table", CSS.table);
    const head = element("tr");
    for (const text of [
      tr("seriesTime", "Time (UTC)"),
      ...(ensemble
        ? [tr("seriesMean", "Ensemble mean"), tr("min", "Min"), tr("max", "Max")]
        : [series.variable.unit || tr("seriesValue", "Value")]),
    ]) {
      head.append(element("th", CSS.cell, text));
    }
    table.append(head);
    const cell = (value: number | undefined) =>
      value !== undefined && Number.isFinite(value) ? String(Number(value.toPrecision(6))) : "—";
    for (const step of series.steps) {
      const row = element("tr");
      row.append(element("td", `${CSS.cell}text-align:start;`, formatUtc(step.time)));
      row.append(element("td", CSS.cell, cell(step.value)));
      if (ensemble)
        row.append(
          element("td", CSS.cell, cell(step.min)),
          element("td", CSS.cell, cell(step.max)),
        );
      table.append(row);
    }
    tableDetails.append(table);
  };

  const renderSeries = (): void => {
    const current = series;
    if (!current || !state.point) return;
    const lat = state.point.lat.toFixed(3);
    const lon = state.point.lng.toFixed(3);
    const name = current.variable.longName;
    seriesHeading.textContent = tr("seriesHeading", "{{name}} at {{lat}}, {{lon}}", {
      name,
      lat,
      lon,
    });
    const init = axes.find((axis) => axis.name === "init_time");
    seriesSubtitle.textContent = [
      current.variable.unit,
      init && isLeadTimeDimension(current.dimension)
        ? tr("seriesRun", "Run {{time}}", { time: init.labels[state.indices.init_time ?? 0] ?? "" })
        : "",
      current.members > 1
        ? tr("seriesMembers", "{{count}} members: mean and range", { count: current.members })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    seriesResult.style.display = "flex";
    seriesResult.style.opacity = "";
    stopChart?.();
    stopChart = renderSeriesChart(chartBox, {
      steps: current.steps,
      currentIndex: (state.indices[current.dimension] ?? 0) - current.start,
      labels: {
        // The heading names the variable; the tooltip only needs the unit.
        value: current.variable.unit || name,
        mean: tr("seriesMean", "Ensemble mean"),
        range: tr("seriesRange", "Member range"),
        shown: tr("seriesShown", "The step shown on the map"),
        description: tr(
          "seriesDescription",
          "Time series of {{name}} at {{lat}}, {{lon}}. The arrow keys step through the values; Enter shows that step on the map.",
          { name, lat, lon },
        ),
      },
      onPick: (index) => {
        // The redraw replaces the chart, so a keyboard user keeps their place in the new one.
        const focused = chartBox.contains(document.activeElement);
        state.indices[current.dimension] = current.start + index;
        renderSliders();
        scheduleLiveSlice();
        renderSeries();
        if (focused) chartBox.querySelector<SVGElement>("svg[tabindex]")?.focus();
      },
    });
    renderTable();
  };

  /** Read the series at the picked state.point for the chosen dataset, variable and slice. */
  const readSeries = async (): Promise<void> => {
    const app = appRef;
    const dataset = currentDataset();
    const variable = currentVariable();
    const picked = state.point;
    if (!app || !dataset || !variable || !picked || !axesReady) return;
    const request = ++seriesRequest;
    const sliceAxes = axes;
    const indices = { ...state.indices };
    setSeriesStatus(tr("readingSeries", "Reading the series…"));
    // The previous chart stays while the new one loads, dimmed, so the panel does not jump.
    seriesResult.style.opacity = "0.5";
    try {
      const store = await openRepository(dataset);
      const grid = await readGridCoordinates(dataset, store);
      const cell = locateCell(grid, picked.lng, picked.lat);
      if (disposed || request !== seriesRequest) return;
      if (!cell) {
        clearSeries();
        setSeriesStatus(
          tr("outsideGrid", "That point is outside the {{name}} grid.", { name: dataset.title }),
        );
        return;
      }
      const read = await readPointSeries(dataset, variable, store, sliceAxes, indices, cell);
      if (disposed || request !== seriesRequest) return;
      if (!read) {
        clearSeries();
        setSeriesStatus(null);
        return;
      }
      series = { ...read, datasetId: dataset.id, variable };
      setSeriesStatus(null);
      renderSeries();
    } catch (error) {
      if (disposed || request !== seriesRequest) return;
      clearSeries();
      setSeriesStatus(
        tr("seriesFailed", "Could not read the series: {{message}}", {
          message: errorMessage(error),
        }),
      );
    }
  };

  const scheduleSeriesRead = (): void => {
    if (!state.point) return;
    if (seriesTimer) clearTimeout(seriesTimer);
    seriesTimer = setTimeout(() => {
      seriesTimer = null;
      void readSeries();
    }, SLICE_DEBOUNCE_MS);
  };

  /**
   * Keep the chart in step with a slider: the series slider moves the chart's marker while it
   * stays inside the window read, the member slider changes nothing (every member is read), and
   * anything else (another run) reads the series again.
   */
  const refreshSeries = (dimension: string): void => {
    renderSeriesHint();
    if (!state.point) return;
    const current = series;
    const dataset = currentDataset();
    const variable = currentVariable();
    // The series reads every member, so another member reads the same values.
    if (current && dataset && variable && dimension === memberDimension(dataset, variable)) return;
    const index = state.indices[dimension] ?? 0;
    if (
      current &&
      dimension === current.dimension &&
      index >= current.start &&
      index < current.start + current.steps.length
    ) {
      renderSeries();
      return;
    }
    scheduleSeriesRead();
  };

  const stopPicking = (): void => {
    cancelPick?.();
    cancelPick = null;
    pickButton.textContent = tr("pickPoint", "Pick a point on the map");
  };

  const startPicking = (): void => {
    const map = getStyleMap(appRef);
    if (!map) return;
    if (cancelPick) {
      stopPicking();
      return;
    }
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    const onClick = (event: { lngLat: { lng: number; lat: number } }) => {
      stopPicking();
      state.point = { lng: event.lngLat.lng, lat: event.lngLat.lat };
      if (appRef) showPointMarker(appRef, state.point.lng, state.point.lat);
      void readSeries();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stopPicking();
    };
    map.once("click", onClick);
    document.addEventListener("keydown", onKey);
    cancelPick = () => {
      map.off("click", onClick);
      document.removeEventListener("keydown", onKey);
      canvas.style.cursor = "";
    };
    pickButton.textContent = tr("picking", "Click the map… (Esc to cancel)");
  };

  pickButton.addEventListener("click", startPicking);
  tableDetails.addEventListener("toggle", renderTable);
  csvButton.addEventListener("click", () => {
    const current = series;
    if (!current || !state.point) return;
    const unit = current.variable.unit ? ` (${current.variable.unit})` : "";
    appRef?.exportTextFile?.(
      `${current.datasetId}-${current.variable.name}-${state.point.lat.toFixed(3)}_${state.point.lng.toFixed(3)}.csv`,
      seriesCsv(current.steps, `${current.variable.name}${unit}`),
      { description: "CSV", extensions: ["csv"], mimeType: "text/csv", promptName: true },
    );
  });

  datasetSelect.addEventListener("change", () => chooseDataset(datasetSelect.value));
  variableSelect.addEventListener("change", () => {
    state.variable = variableSelect.value || null;
    const variable = currentVariable();
    if (variable) applyStyleDefaults(variable);
    renderRegionalHint();
    void loadAxes();
  });
  colormapSelect.addEventListener("change", () => {
    state.colormap = colormapSelect.value;
  });
  minInput.addEventListener("input", () => {
    state.min = minInput.value;
  });
  maxInput.addEventListener("input", () => {
    state.max = maxInput.value;
  });
  addButton.addEventListener("click", () => void addLayer());

  renderDatasets();
  loadCatalog()
    .then((loaded) => {
      if (disposed) return;
      catalog = loaded;
      renderDatasets();
      if (state.datasetId && currentDataset()) chooseDataset(state.datasetId);
    })
    .catch((error: unknown) => {
      if (disposed) return;
      setStatus(
        tr("catalogFailed", "Could not load the dynamical.org catalog: {{message}}", {
          message: errorMessage(error),
        }),
        true,
      );
    });

  return () => {
    disposed = true;
    if (sliceTimer) clearTimeout(sliceTimer);
    if (seriesTimer) clearTimeout(seriesTimer);
    cancelPick?.();
    stopChart?.();
    container.replaceChildren();
  };
}

function mountPanel(container: HTMLElement): void {
  disposePanel?.();
  panelContainer = container;
  disposePanel = buildPanel(container);
}

/**
 * Dynamical plugin: browses dynamical.org's catalog of cloud-optimized weather
 * forecasts, ensembles and analyses (NOAA GFS, GEFS, HRRR and MRMS, ECMWF AIFS
 * and IFS, DWD ICON-EU, ECCC HRDPS, NASA IMERG) and adds a variable as a Zarr
 * raster layer read straight from its Icechunk repository, with sliders for the
 * forecast run and lead time. Virtual repositories decode the producers' GRIB2
 * messages in the browser; analyses and ensembles draw from a minimum zoom.
 */
export const maplibreDynamicalPlugin: GeoLibrePlugin = {
  id: DYNAMICAL_PLUGIN_ID,
  name: PLUGIN_NAME,
  version: "0.1.0",
  // The layers go through the shared Zarr control.
  engines: ["maplibre", "mapbox"],
  activate: (app) => {
    appRef = app;
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: pluginDisplayTitle(app, DYNAMICAL_PLUGIN_ID, PLUGIN_NAME),
        dock: "replace-style",
        defaultWidth: 360,
        render: (container) => {
          mountPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
            if (panelContainer === container) panelContainer = null;
          };
        },
      }) ?? null;
    unsubscribeLocale =
      app.onLocaleChange?.(() => {
        if (panelContainer) mountPanel(panelContainer);
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    removePointMarker(app);
    unsubscribeLocale?.();
    unsubscribeLocale = null;
    unregisterPanel?.();
    unregisterPanel = null;
    disposePanel?.();
    disposePanel = null;
    panelContainer = null;
    state = initialState();
    // A later session reads the axes afresh.
    axesCache.clear();
    stopResizeWatch();
    regionalLayers.clear();
    gridCache.clear();
    appRef = null;
  },
};

export default maplibreDynamicalPlugin;
