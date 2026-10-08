import { useAppStore, VECTOR_COLOR_RAMPS } from "@geolibre/core";
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
  formatUtcTimeOfDay,
  bboxCenter,
  bboxContains,
  isLeadTimeDimension,
  isTemporalDimension,
  needsRegionalView,
  projectedBounds,
  projectedDimensions,
  projectionFromSpatialRef,
  regionalMinZoom,
  sampleRange,
  sliceDimensions,
  sliceSelectorValue,
  stepForUtcDate,
  stepsOnUtcDate,
  utcDateKey,
} from "./dynamical-api";
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
  range: "flex:1;min-width:0;",
  sliderRow: "display:flex;align-items:center;gap:4px;",
  stepButton:
    "flex:none;width:24px;height:24px;padding:0;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));" +
    "cursor:pointer;line-height:1;",
  pickerRow: "display:flex;gap:6px;margin-top:4px;",
  pickerInput:
    "flex:1;min-width:0;box-sizing:border-box;padding:4px 6px;border:1px solid hsl(var(--border));" +
    "border-radius:6px;background:hsl(var(--background));color:hsl(var(--foreground));" +
    "font-size:11px;",
  row: "display:flex;gap:8px;",
  primary:
    "padding:7px 10px;border:none;border-radius:6px;background:hsl(var(--primary));" +
    "color:hsl(var(--primary-foreground));cursor:pointer;font-weight:600;",
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
  /** Whether `values` are timestamps, which also get a day and run picker. */
  temporal: boolean;
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
          axes.push({
            name,
            coordinates,
            values,
            labels: values.map(formatUtc),
            temporal: true,
          });
        } else if (isLeadTimeDimension(name)) {
          const unitMs = durationUnitMs(attributes.units ?? dataset.dimensions[name]?.unit) ?? 1000;
          const values = coordinates.map((value) => (value * unitMs) / 1000);
          axes.push({
            name,
            coordinates,
            values,
            labels: values.map(formatLeadTime),
            temporal: false,
          });
        } else {
          axes.push({
            name,
            coordinates,
            values: coordinates,
            labels: coordinates.map(String),
            temporal: false,
          });
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
      const title = axisTitle(axis.name);
      const last = Math.max(0, axis.labels.length - 1);
      const wrap = element("div", CSS.slider);
      const head = element("div", CSS.sliderHead);
      const value = element("span", CSS.sliderValue);
      head.append(element("span", undefined, title), value);
      const range = element("input", CSS.range);
      range.type = "range";
      range.min = "0";
      range.max = String(last);
      range.step = "1";
      range.setAttribute("aria-label", title);
      // A long archive packs many steps into each pixel of the slider, so the buttons step one at
      // a time and a timestamp axis also takes a day and a run.
      const stepButton = (text: string, label: string, delta: number): HTMLButtonElement => {
        const button = element("button", CSS.stepButton, text);
        button.type = "button";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.addEventListener("click", () => select((state.indices[axis.name] ?? 0) + delta));
        return button;
      };
      const previous = stepButton(
        "‹",
        tr("stepPrevious", "Previous {{axis}}", { axis: title }),
        -1,
      );
      const next = stepButton("›", tr("stepNext", "Next {{axis}}", { axis: title }), 1);
      const row = element("div", CSS.sliderRow);
      row.append(previous, range, next);
      wrap.append(head, row);

      let dateInput: HTMLInputElement | null = null;
      let runSelect: HTMLSelectElement | null = null;
      if (axis.temporal && axis.labels.length > 1) {
        dateInput = element("input", CSS.pickerInput);
        dateInput.type = "date";
        // A loop, not a spread: an hourly analysis holds more steps than a call takes arguments.
        const finite = axis.values.filter(Number.isFinite);
        dateInput.min = utcDateKey(finite.reduce((low, value) => Math.min(low, value), Infinity));
        dateInput.max = utcDateKey(
          finite.reduce((high, value) => Math.max(high, value), -Infinity),
        );
        dateInput.setAttribute(
          "aria-label",
          tr("pickDate", "{{axis}} date (UTC)", { axis: title }),
        );
        dateInput.addEventListener("change", () => {
          const index = stepForUtcDate(
            axis.values,
            dateInput!.value,
            state.indices[axis.name] ?? 0,
          );
          if (index >= 0) select(index);
          else sync();
        });
        runSelect = element("select", CSS.pickerInput);
        runSelect.setAttribute("aria-label", tr("pickRun", "{{axis}} time (UTC)", { axis: title }));
        runSelect.addEventListener("change", () => select(Number(runSelect!.value)));
        const picker = element("div", CSS.pickerRow);
        picker.append(dateInput, runSelect);
        wrap.append(picker);
      }

      /** Show the chosen step in every control of this axis. */
      const sync = (): void => {
        const index = state.indices[axis.name] ?? 0;
        range.value = String(index);
        value.textContent = axis.labels[index] ?? "";
        range.disabled = axis.labels.length < 2;
        previous.disabled = range.disabled || index <= 0;
        next.disabled = range.disabled || index >= last;
        if (dateInput && runSelect) {
          const day = utcDateKey(axis.values[index]);
          dateInput.value = day;
          runSelect.replaceChildren(
            ...stepsOnUtcDate(axis.values, day).map((step) => {
              const option = element("option", undefined, formatUtcTimeOfDay(axis.values[step]));
              option.value = String(step);
              return option;
            }),
          );
          runSelect.value = String(index);
        }
      };
      const select = (index: number): void => {
        const clamped = Math.min(last, Math.max(0, Math.round(index)));
        const changed = clamped !== (state.indices[axis.name] ?? 0);
        state.indices[axis.name] = clamped;
        sync();
        if (!changed) return;
        renderValidTime();
        scheduleLiveSlice();
      };
      range.addEventListener("input", () => select(Number(range.value)));
      sync();
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
    appRef = null;
  },
};

export default maplibreDynamicalPlugin;
