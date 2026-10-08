/**
 * dynamical.org's weather data catalog: a static STAC catalog whose collections each describe one
 * Icechunk repository (NOAA GFS/GEFS/HRRR/MRMS, ECMWF AIFS/IFS, DWD ICON-EU, ECCC HRDPS, NASA
 * IMERG) through the datacube extension.
 *
 * Pure parsing and the decisions the panel makes from it, kept apart from the DOM so they can be
 * tested against the real documents.
 */

export const DYNAMICAL_CATALOG_URL = "https://stac.dynamical.org/catalog.json";
export const DYNAMICAL_HOME_URL = "https://dynamical.org/";
export const DYNAMICAL_CATALOG_PAGE_URL = "https://dynamical.org/catalog/";

/**
 * Most slices of the other dimensions one chunk may hold for the dataset to draw at any zoom.
 *
 * A map draws one slice, but the reader decodes whole chunks. dynamical.org's "time-optimized"
 * archives pack a forecast's lead times into each chunk (49-105 of them, so a global GFS slice is
 * ~70 MB), and the analyses and ensembles pack hundreds to thousands (1-6 GB per global slice).
 * The first group draws the whole globe in seconds; the second only draws a region at a time
 * ({@link REGIONAL_VIEW_BUDGET_BYTES}).
 */
export const MAX_SLICES_PER_CHUNK = 128;

/**
 * Most decoded bytes one view of a regional dataset may read: the renderer fetches one region per
 * chunk in view, so a minimum zoom ({@link regionalMinZoom}) keeps the chunks in view under this.
 */
export const REGIONAL_VIEW_BUDGET_BYTES = 256 * 2 ** 20;

/**
 * Largest single chunk a regional dataset may decode. Past this one region alone is too much to
 * hold, at any zoom (the biggest dynamical.org has today, NASA IMERG's, is ~58 MB).
 */
export const MAX_REGIONAL_CHUNK_BYTES = 96 * 2 ** 20;

/** Every dynamical.org data variable is stored as 32-bit floats (or decodes to them). */
const BYTES_PER_VALUE = 4;

/** The deepest minimum zoom a regional dataset is given. */
const MAX_REGIONAL_MIN_ZOOM = 12;

/** MapLibre's tile size: at zoom `z` the world is `512 * 2^z` pixels wide. */
const WORLD_TILE_PIXELS = 512;

/** Metres per degree along a meridian, to size a projected grid's chunks in degrees. */
const METRES_PER_DEGREE = 111_320;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One child link of the root catalog. */
export interface DynamicalCatalogEntry {
  id: string;
  title: string;
  href: string;
}

/** A datacube dimension, as the collection describes it. */
export interface DynamicalDimension {
  name: string;
  type: string;
  axis?: string;
  unit?: string;
  size?: number;
  extent?: [unknown, unknown];
}

/** A data variable the collection lists. */
export interface DynamicalVariable {
  name: string;
  longName: string;
  unit: string;
  dimensions: string[];
  chunks: number[];
  comment?: string;
}

/**
 * How a dataset can be drawn in the browser: at any zoom, a region at a time (from a minimum
 * zoom), or not at all.
 */
export type DynamicalMapSupport = "supported" | "regional" | "time-series";

/** A dataset (one STAC collection) reduced to what the panel shows and reads. */
export interface DynamicalDataset {
  id: string;
  title: string;
  modelName: string;
  description: string;
  summary: string;
  attribution: string;
  license: string;
  version: string;
  docsUrl: string;
  /** The repository's HTTPS address, which the Icechunk reader opens. */
  repositoryUrl: string;
  /**
   * Whether chunks point into the producer's GRIB files rather than at Zarr chunks; those decode
   * through the `gribberish` codec ({@link registerGribberishCodec}).
   */
  virtual: boolean;
  bbox: [number, number, number, number] | null;
  dimensions: Record<string, DynamicalDimension>;
  variables: DynamicalVariable[];
  spatialDomain: string;
  spatialResolution: string;
  timeDomain: string;
  forecastDomain: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The first entry of a STAC `summaries` list, which dynamical.org fills with one string each. */
function summary(document: Record<string, unknown>, key: string): string {
  const summaries = isRecord(document.summaries) ? document.summaries : {};
  const values = summaries[key];
  return Array.isArray(values) ? text(values[0]) : "";
}

/**
 * The child collections the root catalog links to.
 *
 * Args:
 *   document: The parsed `catalog.json`.
 *   baseUrl: Where it was read from, for resolving relative links.
 *
 * Returns:
 *   One entry per child link, in catalog order.
 */
export function parseDynamicalCatalog(
  document: unknown,
  baseUrl: string = DYNAMICAL_CATALOG_URL,
): DynamicalCatalogEntry[] {
  if (!isRecord(document) || !Array.isArray(document.links)) return [];
  const entries: DynamicalCatalogEntry[] = [];
  for (const link of document.links) {
    if (!isRecord(link) || link.rel !== "child" || typeof link.href !== "string") continue;
    let href: string;
    try {
      href = new URL(link.href, baseUrl).href;
    } catch {
      continue;
    }
    // `https://stac.dynamical.org/<id>/collection.json`: the id is the folder.
    const id = href.split("/").slice(-2, -1)[0] ?? href;
    entries.push({ id, title: text(link.title) || id, href });
  }
  return entries;
}

function parseBbox(document: Record<string, unknown>): [number, number, number, number] | null {
  const extent = isRecord(document.extent) ? document.extent : {};
  const spatial = isRecord(extent.spatial) ? extent.spatial : {};
  const boxes = Array.isArray(spatial.bbox) ? spatial.bbox : [];
  const first = boxes[0];
  if (!Array.isArray(first) || first.length < 4) return null;
  const numbers = first.map(Number);
  // A 3D box is [w, s, minZ, e, n, maxZ].
  const box = numbers.length >= 6 ? [numbers[0], numbers[1], numbers[3], numbers[4]] : numbers;
  return box.slice(0, 4).every(Number.isFinite)
    ? (box.slice(0, 4) as [number, number, number, number])
    : null;
}

/**
 * Read one collection document into a {@link DynamicalDataset}.
 *
 * Args:
 *   document: The parsed `collection.json`.
 *
 * Returns:
 *   The dataset, or null when the document is not a collection with an HTTPS Icechunk asset.
 */
export function parseDynamicalCollection(document: unknown): DynamicalDataset | null {
  if (!isRecord(document) || document.type !== "Collection" || typeof document.id !== "string") {
    return null;
  }
  const assets = isRecord(document.assets) ? document.assets : {};
  // The `icechunk` asset is an `s3://` URI; the HTTPS one is what a browser can read.
  const asset = Object.values(assets).find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      typeof candidate.href === "string" &&
      candidate.href.startsWith("https://") &&
      text(candidate.type).toLowerCase().includes("icechunk"),
  );
  if (!asset) return null;

  const dimensions: Record<string, DynamicalDimension> = {};
  if (isRecord(document["cube:dimensions"])) {
    for (const [name, raw] of Object.entries(document["cube:dimensions"])) {
      if (!isRecord(raw)) continue;
      dimensions[name] = {
        name,
        type: text(raw.type),
        ...(text(raw.axis) ? { axis: text(raw.axis).toLowerCase() } : {}),
        ...(text(raw.unit) ? { unit: text(raw.unit) } : {}),
        ...(typeof raw.size === "number" ? { size: raw.size } : {}),
        ...(Array.isArray(raw.extent) && raw.extent.length === 2
          ? { extent: [raw.extent[0], raw.extent[1]] as [unknown, unknown] }
          : {}),
      };
    }
  }

  const variables: DynamicalVariable[] = [];
  if (isRecord(document["cube:variables"])) {
    for (const [name, raw] of Object.entries(document["cube:variables"])) {
      if (!isRecord(raw) || raw.type !== "data") continue;
      const dims = Array.isArray(raw.dimensions) ? raw.dimensions.map(String) : [];
      const chunks = Array.isArray(raw.chunks) ? raw.chunks.map(Number) : [];
      variables.push({
        name,
        longName: text(raw.long_name) || name,
        unit: text(raw.unit),
        dimensions: dims,
        chunks: chunks.length === dims.length ? chunks : [],
        ...(text(raw.comment) ? { comment: text(raw.comment) } : {}),
      });
    }
  }

  const links = Array.isArray(document.links) ? document.links : [];
  const docs = links.find(
    (link): link is Record<string, unknown> =>
      isRecord(link) && link.rel === "about" && typeof link.href === "string",
  );

  return {
    id: document.id,
    title: text(document.title) || document.id,
    modelName: text(document.model_name),
    description: text(document.description),
    summary: text(document.description_summary),
    attribution: text(document.attribution),
    license: text(document.license),
    version: text(document.version),
    // Rendered as a link, so only an http(s) address from the catalog is used.
    docsUrl:
      docs && /^https?:\/\//i.test(String(docs.href))
        ? String(docs.href)
        : `${DYNAMICAL_CATALOG_PAGE_URL}${document.id}/`,
    repositoryUrl: String(asset.href).replace(/\/+$/, ""),
    virtual: "icechunk:virtual_chunk_containers" in asset,
    bbox: parseBbox(document),
    dimensions,
    variables,
    spatialDomain: summary(document, "spatial_domain"),
    spatialResolution: summary(document, "spatial_resolution"),
    timeDomain: summary(document, "time_domain"),
    forecastDomain: summary(document, "forecast_domain"),
  };
}

/**
 * Read the root catalog and every collection it links to.
 *
 * Args:
 *   fetcher: The fetch to read with.
 *   signal: Aborts the reads.
 *
 * Returns:
 *   The datasets in catalog order. A collection that fails to load or parse is left out rather
 *   than failing the rest; the call rejects only when the root catalog itself cannot be read.
 */
export async function fetchDynamicalCatalog(
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<DynamicalDataset[]> {
  const response = await fetcher(DYNAMICAL_CATALOG_URL, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const entries = parseDynamicalCatalog(await response.json(), DYNAMICAL_CATALOG_URL);
  const datasets = await Promise.all(
    entries.map(async (entry) => {
      try {
        const child = await fetcher(entry.href, { signal });
        if (!child.ok) return null;
        return parseDynamicalCollection(await child.json());
      } catch (error) {
        if (signal?.aborted) throw error;
        return null;
      }
    }),
  );
  return datasets.filter((dataset): dataset is DynamicalDataset => dataset !== null);
}

/** Whether a dimension is one of the two the map is drawn across. */
export function isSpatialDimension(dataset: DynamicalDataset, name: string): boolean {
  return dataset.dimensions[name]?.type === "spatial";
}

/**
 * How many slices of the non-spatial dimensions one chunk of a variable spans: what drawing one
 * slice costs relative to the slice itself.
 */
export function slicesPerChunk(dataset: DynamicalDataset, variable: DynamicalVariable): number {
  if (!variable.chunks.length) return 1;
  return variable.dimensions.reduce(
    (product, name, index) =>
      isSpatialDimension(dataset, name) ? product : product * (variable.chunks[index] || 1),
    1,
  );
}

/** Decoded bytes in one chunk of a variable. */
export function chunkBytes(variable: DynamicalVariable): number {
  if (!variable.chunks.length) return 0;
  return variable.chunks.reduce((product, length) => product * (length || 1), BYTES_PER_VALUE);
}

/**
 * Whether the browser can draw a dataset.
 *
 * Virtual repositories decode the producer's GRIB2 messages through the `gribberish` codec, one
 * whole field per chunk, so they draw like any other. The others are judged on their chunk layout:
 * few slices per chunk draws everywhere ({@link MAX_SLICES_PER_CHUNK}), many draws a region at a
 * time while each chunk stays small enough to decode ({@link MAX_REGIONAL_CHUNK_BYTES}).
 */
export function datasetMapSupport(dataset: DynamicalDataset): DynamicalMapSupport {
  // The worst variable decides: the panel offers every variable of a dataset it lists as ready.
  const worst = Math.max(
    1,
    ...dataset.variables.map((variable) => slicesPerChunk(dataset, variable)),
  );
  if (worst <= MAX_SLICES_PER_CHUNK) return "supported";
  const largest = Math.max(0, ...dataset.variables.map((variable) => chunkBytes(variable)));
  return largest > 0 && largest <= MAX_REGIONAL_CHUNK_BYTES ? "regional" : "time-series";
}

/** Whether a variable's chunks hold more slices than a whole-world view can afford. */
export function needsRegionalView(dataset: DynamicalDataset, variable: DynamicalVariable): boolean {
  return slicesPerChunk(dataset, variable) > MAX_SLICES_PER_CHUNK;
}

/** The step between a dimension's cells, from its extent and size. */
function cellStep(dimension: DynamicalDimension | undefined): number | null {
  const [first, last] = (dimension?.extent ?? []).map(Number);
  const size = dimension?.size ?? 0;
  if (!Number.isFinite(first) || !Number.isFinite(last) || size < 2) return null;
  const step = Math.abs(last - first) / (size - 1);
  return step > 0 ? step : null;
}

/** Whether a dimension counts in metres (a projected grid) rather than degrees. */
function inMetres(dimension: DynamicalDimension): boolean {
  return /^(m|metre|metres|meter|meters)$/i.test(dimension.unit ?? "");
}

/**
 * How far one chunk of a variable reaches, and how many chunks span the grid, along x and y.
 *
 * A projected grid's metres are read as degrees of latitude, which overstates how many of its
 * chunks a view away from the equator holds; the minimum zoom errs deeper for it.
 *
 * Returns:
 *   Degrees per chunk and chunk counts, or null when the extents or chunks are missing.
 */
export function chunkFootprint(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
): { x: number; y: number; columns: number; rows: number } | null {
  let x: { span: number; count: number } | null = null;
  let y: { span: number; count: number } | null = null;
  for (const [index, name] of variable.dimensions.entries()) {
    const dimension = dataset.dimensions[name];
    if (!dimension || dimension.type !== "spatial") continue;
    const step = cellStep(dimension);
    const cells = variable.chunks[index];
    if (!step || !cells) continue;
    const span = (step * cells) / (inMetres(dimension) ? METRES_PER_DEGREE : 1);
    const count = Math.ceil((dimension.size ?? cells) / cells);
    if (dimension.axis === "x" || name === "longitude") x = { span, count };
    else y = { span, count };
  }
  if (!x || !y) return null;
  return { x: x.span, y: y.span, columns: x.count, rows: y.count };
}

/**
 * The lowest zoom at which a view of a regional variable stays within the decode budget.
 *
 * A view `width` pixels wide spans `360 * width / (512 * 2^zoom)` degrees of longitude, and as
 * many of latitude per pixel at the equator, where a Mercator pixel covers the most; the chunks it
 * touches are counted with one extra row and column for a view that straddles chunk edges.
 *
 * Args:
 *   dataset: The dataset.
 *   variable: The variable to draw.
 *   viewport: The map's size in CSS pixels.
 *   budget: Decoded bytes a view may read.
 *
 * Returns:
 *   A whole zoom level; 0 when the variable draws at any zoom.
 */
export function regionalMinZoom(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
  viewport: { width: number; height: number },
  budget: number = REGIONAL_VIEW_BUDGET_BYTES,
): number {
  if (!needsRegionalView(dataset, variable)) return 0;
  const footprint = chunkFootprint(dataset, variable);
  const bytes = chunkBytes(variable);
  if (!footprint || !bytes) return MAX_REGIONAL_MIN_ZOOM;
  const allowed = Math.max(1, Math.floor(budget / bytes));
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  for (let zoom = 0; zoom < MAX_REGIONAL_MIN_ZOOM; zoom += 1) {
    const degreesPerPixel = 360 / (WORLD_TILE_PIXELS * 2 ** zoom);
    const columns = Math.min(
      footprint.columns,
      Math.ceil((width * degreesPerPixel) / footprint.x) + 1,
    );
    const rows = Math.min(footprint.rows, Math.ceil((height * degreesPerPixel) / footprint.y) + 1);
    if (columns * rows <= allowed) return zoom;
  }
  return MAX_REGIONAL_MIN_ZOOM;
}

/** A variable's non-spatial dimensions, in array order: the ones the panel picks a slice of. */
export function sliceDimensions(dataset: DynamicalDataset, variable: DynamicalVariable): string[] {
  return variable.dimensions.filter((name) => !isSpatialDimension(dataset, name));
}

/**
 * The names of a dataset's horizontal dimensions, for a renderer that only finds `lat`/`lon`-like
 * names by itself. Null for a latitude/longitude grid, which needs no help.
 */
export function projectedDimensions(
  dataset: DynamicalDataset,
): { lat: string; lon: string } | null {
  const spatial = Object.values(dataset.dimensions).filter((dim) => dim.type === "spatial");
  const x = spatial.find((dim) => dim.axis === "x");
  const y = spatial.find((dim) => dim.axis === "y");
  if (!x || !y || (x.name === "longitude" && y.name === "latitude")) return null;
  return { lat: y.name, lon: x.name };
}

/**
 * The outer edges of a projected grid, from the cell-centre extents the collection lists.
 *
 * Returns:
 *   `[xMin, yMin, xMax, yMax]` in the grid's own units, or null when the extents or sizes are
 *   missing.
 */
export function projectedBounds(
  dataset: DynamicalDataset,
): [number, number, number, number] | null {
  const names = projectedDimensions(dataset);
  if (!names) return null;
  const edges = (dim: DynamicalDimension | undefined): [number, number] | null => {
    const [first, last] = (dim?.extent ?? []).map(Number);
    const size = dim?.size ?? 0;
    if (!Number.isFinite(first) || !Number.isFinite(last) || size < 2) return null;
    const half = Math.abs(last - first) / (size - 1) / 2;
    return [Math.min(first, last) - half, Math.max(first, last) + half];
  };
  const x = edges(dataset.dimensions[names.lon]);
  const y = edges(dataset.dimensions[names.lat]);
  return x && y ? [x[0], y[0], x[1], y[1]] : null;
}

/**
 * A proj4 definition for a grid, from the attributes of its CF `spatial_ref` variable.
 *
 * A rotated-pole grid (ECCC HRDPS) is spelled out as `ob_tran`: its WKT uses GDAL's "Pole
 * rotation (GRIB convention)" method, which proj4js parses without error and then ignores,
 * placing the grid on the unrotated globe. Anything else goes through as its WKT, which proj4js
 * reads (HRRR's Lambert conformal conic).
 *
 * Args:
 *   attributes: The `spatial_ref` variable's attributes.
 *
 * Returns:
 *   A proj4 definition or WKT string, or null when the attributes describe no CRS.
 */
export function projectionFromSpatialRef(attributes: Record<string, unknown>): string | null {
  if (attributes.grid_mapping_name === "rotated_latitude_longitude") {
    const poleLat = Number(attributes.grid_north_pole_latitude);
    const poleLon = Number(attributes.grid_north_pole_longitude);
    const gridLon = Number(attributes.north_pole_grid_longitude ?? 0);
    const radius = Number(attributes.semi_major_axis ?? 6371229);
    if ([poleLat, poleLon, gridLon, radius].every(Number.isFinite)) {
      return (
        `+proj=ob_tran +o_proj=longlat +o_lat_p=${poleLat} +o_lon_p=${gridLon} ` +
        `+lon_0=${180 + poleLon} +R=${radius} +no_defs`
      );
    }
  }
  const wkt = attributes.crs_wkt ?? attributes.spatial_ref;
  return typeof wkt === "string" && wkt.trim() ? wkt : null;
}

/** Whether a dimension holds forecast lead times (seconds after the run started). */
export function isLeadTimeDimension(name: string): boolean {
  return name === "lead_time";
}

/** Whether a dimension holds timestamps. */
export function isTemporalDimension(dataset: DynamicalDataset, name: string): boolean {
  return dataset.dimensions[name]?.type === "temporal";
}

/**
 * Where a dimension's slider starts: the newest step for a timestamp axis (the latest analysis or
 * forecast run), the first otherwise (analysis time of a forecast, the control member).
 */
export function defaultSliceIndex(dataset: DynamicalDataset, name: string, length: number): number {
  if (length <= 0) return 0;
  return isTemporalDimension(dataset, name) ? length - 1 : 0;
}

/**
 * The selector value that names step `index` of a dimension.
 *
 * The renderer matches a number against the coordinate values first and falls back to reading it
 * as an index, so an index is passed — it survives a coordinate array the renderer cannot read —
 * unless it happens to equal a different step's coordinate, which would select that step instead.
 */
export function sliceSelectorValue(index: number, coordinates: readonly number[]): number {
  const collision = coordinates.indexOf(index);
  if (collision < 0 || collision === index) return index;
  const value = coordinates[index];
  return Number.isFinite(value) ? value : index;
}

/** `2026-10-07 06:00 UTC`. */
export function formatUtc(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The UTC calendar day of a timestamp as `2026-10-07`, the value a date input holds. */
export function utcDateKey(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}

/** The time of day of a timestamp as `06:00 UTC`, what a run on a known day reads as. */
export function formatUtcTimeOfDay(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** The indices of the steps that fall on a UTC calendar day, in axis order. */
export function stepsOnUtcDate(values: readonly number[], dateKey: string): number[] {
  const steps: number[] = [];
  // An unreadable timestamp keys as "", which would otherwise match every other one.
  if (!dateKey) return steps;
  values.forEach((value, index) => {
    if (utcDateKey(value) === dateKey) steps.push(index);
  });
  return steps;
}

/**
 * The step to jump to when a day is picked: the one at the current step's time of day if that
 * day has it, else the day's first step, else the step nearest that time on that day (a day the
 * archive skips).
 *
 * @param values - Epoch milliseconds of each step.
 * @param dateKey - The picked day, `YYYY-MM-DD`.
 * @param current - The step shown now, whose time of day is kept.
 * @returns The step index, or -1 when the day does not parse or the axis is empty.
 */
export function stepForUtcDate(
  values: readonly number[],
  dateKey: string,
  current: number,
): number {
  const day = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(day) || values.length === 0) return -1;
  const now = values[current];
  const timeOfDay = Number.isFinite(now) ? ((now % 86_400_000) + 86_400_000) % 86_400_000 : 0;
  const target = day + timeOfDay;
  const onDay = stepsOnUtcDate(values, dateKey);
  if (onDay.length) return onDay.find((index) => values[index] === target) ?? onDay[0];
  let best = -1;
  let bestDistance = Infinity;
  values.forEach((value, index) => {
    const distance = Math.abs(value - target);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

/** A lead time in seconds as `+6 h`, or `+3 d 6 h` from two days on. */
export function formatLeadTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const hours = Math.round(seconds / 3600);
  if (Math.abs(hours) < 48) return `+${hours} h`;
  const days = Math.floor(hours / 24);
  const rest = hours - days * 24;
  return rest ? `+${days} d ${rest} h` : `+${days} d`;
}

/** A colormap and value range to open a variable with. */
export interface DynamicalVariableStyle {
  colormap: string;
  /** Absent when no fixed range suits the variable; the panel then samples the data. */
  clim?: [number, number];
  /** Whether the range should sit symmetrically around zero. */
  diverging?: boolean;
}

/**
 * A starting style for a variable, judged from its name and unit. Ranges are fixed where the
 * physics give one (temperature, percentages, pressure), so the colors mean the same thing across
 * runs and models; elsewhere the panel samples the data.
 */
export function defaultVariableStyle(variable: DynamicalVariable): DynamicalVariableStyle {
  const name = variable.name.toLowerCase();
  const unit = variable.unit;
  if (unit === "degree_Celsius" || unit === "K") {
    if (name.includes("dew_point") || name.includes("temperature") || name.includes("tmp")) {
      return { colormap: "coolwarm", clim: unit === "K" ? [243.15, 313.15] : [-30, 40] };
    }
    return { colormap: "coolwarm" };
  }
  if (unit === "percent" || unit === "%") {
    if (name.includes("cloud")) return { colormap: "gray", clim: [0, 100] };
    if (name.includes("frozen")) return { colormap: "blues", clim: [0, 100] };
    return { colormap: "viridis", clim: [0, 100] };
  }
  if (unit === "1" && name.startsWith("categorical")) return { colormap: "blues", clim: [0, 1] };
  if (unit === "m s-1" || unit === "m/s") {
    if (/(^|_)wind_[uv]_/.test(name) || /_[uv]_component/.test(name)) {
      return { colormap: "coolwarm", clim: [-25, 25], diverging: true };
    }
    return { colormap: "viridis", clim: [0, 30] };
  }
  if (unit === "kg m-2 s-1" || unit === "mm/s") {
    // Roughly 0-7 mm/h: light rain to a downpour.
    return { colormap: "blues", clim: [0, 0.002] };
  }
  if (unit === "Pa") {
    if (name.includes("mean_sea_level")) return { colormap: "viridis", clim: [96000, 104000] };
    return { colormap: "viridis" };
  }
  if (unit === "W m-2") return { colormap: "inferno" };
  if (name.includes("precip") || name.includes("snow") || name.includes("rain")) {
    return { colormap: "blues" };
  }
  return { colormap: "viridis" };
}

/**
 * A value range from a sample of a variable: the 2nd to 98th percentile, so a few extreme cells
 * do not wash out the rest, rounded to two significant figures.
 *
 * Args:
 *   values: The sampled values; non-finite ones are skipped.
 *   diverging: Center the range on zero.
 *
 * Returns:
 *   `[min, max]`, or null when the sample holds fewer than two distinct finite values.
 */
export function sampleRange(values: ArrayLike<number>, diverging = false): [number, number] | null {
  const finite: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (Number.isFinite(value)) finite.push(value);
  }
  if (finite.length < 2) return null;
  finite.sort((a, b) => a - b);
  const at = (fraction: number) =>
    finite[Math.min(finite.length - 1, Math.max(0, Math.round(fraction * (finite.length - 1))))];
  let low = at(0.02);
  let high = at(0.98);
  if (diverging) {
    const reach = Math.max(Math.abs(low), Math.abs(high));
    low = -reach;
    high = reach;
  }
  if (!(high > low)) {
    if (finite[finite.length - 1] > finite[0]) {
      low = finite[0];
      high = finite[finite.length - 1];
    } else {
      return null;
    }
  }
  return [roundSignificant(low, Math.floor), roundSignificant(high, Math.ceil)];
}

/** Round outward to two significant figures, so the range still covers what it was given. */
function roundSignificant(value: number, round: (value: number) => number): number {
  if (value === 0) return 0;
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(value))) - 1);
  // The quotient is trimmed first: 0.3 / 0.01 is 29.999999999999996, which would floor to 29.
  return Number((round(Number((value / magnitude).toPrecision(12))) * magnitude).toPrecision(12));
}

/** Whether a `[west, south, east, north]` box holds a point; `west > east` crosses 180°. */
export function bboxContains(
  bbox: readonly [number, number, number, number],
  lng: number,
  lat: number,
): boolean {
  const [west, south, east, north] = bbox;
  if (lat < south || lat > north) return false;
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return west <= east ? wrapped >= west && wrapped <= east : wrapped >= west || wrapped <= east;
}

/** The centre of a `[west, south, east, north]` box, across 180° when `west > east`. */
export function bboxCenter(bbox: readonly [number, number, number, number]): [number, number] {
  const [west, south, east, north] = bbox;
  const span = west <= east ? east - west : east + 360 - west;
  const lng = west + span / 2;
  return [lng > 180 ? lng - 360 : lng, (south + north) / 2];
}

// --- Point time series -------------------------------------------------------

/**
 * Most decoded bytes one point time series may read. A point's series still decodes whole
 * chunks, so the window is cut to whole chunks around the chosen step ({@link seriesWindow}).
 */
export const POINT_SERIES_BUDGET_BYTES = 96 * 2 ** 20;

/** The dimension a point's series runs along: lead time for a forecast, time for an analysis. */
export function seriesDimension(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
): string | null {
  const dimensions = sliceDimensions(dataset, variable);
  return (
    dimensions.find(isLeadTimeDimension) ??
    dimensions.find((name) => isTemporalDimension(dataset, name)) ??
    null
  );
}

/** The ensemble dimension, whose members a point series reads all of. */
export function memberDimension(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
): string | null {
  return sliceDimensions(dataset, variable).find((name) => name === "ensemble_member") ?? null;
}

/**
 * The steps a point series reads: whole chunks along `dimension`, centred on the chunk holding
 * `index`, as many as the budget allows (at least one).
 *
 * Every member is read too, so an ensemble whose members span several chunks pays for each.
 *
 * Args:
 *   dataset: The dataset.
 *   variable: The variable.
 *   dimension: The series dimension ({@link seriesDimension}).
 *   index: The step the panel shows.
 *   length: How many steps the dimension has.
 *   budget: Decoded bytes the series may read.
 *
 * Returns:
 *   `[start, end)` step indices, holding `index`.
 */
export function seriesWindow(
  dataset: DynamicalDataset,
  variable: DynamicalVariable,
  dimension: string,
  index: number,
  length: number,
  budget: number = POINT_SERIES_BUDGET_BYTES,
): [number, number] {
  if (length <= 0) return [0, 0];
  const position = variable.dimensions.indexOf(dimension);
  const chunk = Math.max(1, variable.chunks[position] || length);
  const member = memberDimension(dataset, variable);
  const memberPosition = member ? variable.dimensions.indexOf(member) : -1;
  const memberChunks =
    memberPosition >= 0
      ? Math.ceil(
          (dataset.dimensions[member as string]?.size ?? variable.chunks[memberPosition] ?? 1) /
            Math.max(1, variable.chunks[memberPosition] || 1),
        )
      : 1;
  const bytes = Math.max(1, chunkBytes(variable)) * memberChunks;
  const allowed = Math.max(1, Math.floor(budget / bytes));
  const chunks = Math.ceil(length / chunk);
  const current = Math.min(chunks - 1, Math.max(0, Math.floor(index / chunk)));
  const first = Math.min(
    Math.max(0, current - Math.floor((allowed - 1) / 2)),
    Math.max(0, chunks - allowed),
  );
  const last = Math.min(chunks, first + allowed);
  return [first * chunk, Math.min(length, last * chunk)];
}

/**
 * The index of the coordinate nearest `value` in a monotonic coordinate array.
 *
 * Returns:
 *   The index, or null when `value` lies more than half a step outside the coordinates.
 */
export function nearestIndex(coordinates: ArrayLike<number>, value: number): number | null {
  const count = coordinates.length;
  if (!count || !Number.isFinite(value)) return null;
  if (count === 1) return 0;
  const ascending = coordinates[count - 1] >= coordinates[0];
  const at = (index: number) => (ascending ? coordinates[index] : -coordinates[index]);
  const target = ascending ? value : -value;
  const half = Math.abs(coordinates[1] - coordinates[0]) / 2;
  if (target < at(0) - half || target > at(count - 1) + half) return null;
  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (at(middle) <= target) low = middle;
    else high = middle;
  }
  return Math.abs(at(high) - target) < Math.abs(target - at(low)) ? high : low;
}

/**
 * {@link nearestIndex} on a longitude axis. An axis that goes the whole way round is periodic, so
 * a point in the half step past its last coordinate is next to the first one.
 *
 * Returns:
 *   The index, or null when the longitude lies off a regional axis.
 */
export function nearestLongitudeIndex(
  coordinates: ArrayLike<number>,
  longitude: number,
): number | null {
  const index = nearestIndex(coordinates, longitude);
  const count = coordinates.length;
  if (index !== null || count < 2) return index;
  const step = Math.abs(coordinates[1] - coordinates[0]);
  const span = Math.abs(coordinates[count - 1] - coordinates[0]) + step;
  if (Math.abs(span - 360) > step / 2) return null;
  return nearestIndex(coordinates, longitude - 360) ?? nearestIndex(coordinates, longitude + 360);
}

/** Bring a longitude into the convention of a longitude axis: [-180, 180) or [0, 360). */
export function wrapLongitude(longitude: number, coordinates: ArrayLike<number>): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < coordinates.length; index += 1) {
    max = Math.max(max, coordinates[index]);
  }
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return max > 180 && wrapped < 0 ? wrapped + 360 : wrapped;
}

/** One step of a point series: the value, or an ensemble's mean and spread. */
export interface SeriesStep {
  /** The step's time in epoch milliseconds (the valid time, for a forecast). */
  time: number;
  /** The value, or the ensemble mean; NaN where the data has none. */
  value: number;
  /** The smallest and largest member, for an ensemble. */
  min?: number;
  max?: number;
}

/**
 * Reduce each step's members to their mean and range, skipping missing members.
 *
 * Args:
 *   times: Each step's time in epoch milliseconds.
 *   members: Each step's member values (one value for a deterministic series).
 *
 * Returns:
 *   One step per time; `min`/`max` only when there is more than one member.
 */
export function summarizeSeries(
  times: readonly number[],
  members: ReadonlyArray<ArrayLike<number>>,
): SeriesStep[] {
  return times.map((time, step) => {
    const values = members[step] ?? [];
    let sum = 0;
    let count = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (!Number.isFinite(value)) continue;
      sum += value;
      count += 1;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const value = count ? sum / count : Number.NaN;
    return values.length > 1
      ? { time, value, min: count ? min : Number.NaN, max: count ? max : Number.NaN }
      : { time, value };
  });
}

/**
 * Clean value-axis ticks inside `[min, max]`: a step of 1, 2 or 5 times a power of ten, rounded
 * from `(max - min) / count` the way d3's `ticks` does.
 *
 * Returns:
 *   Ascending tick values, about `count` of them.
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const error = raw / magnitude;
  const factor =
    error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.SQRT2 ? 2 : 1;
  const step = factor * magnitude;
  const ticks: number[] = [];
  // Stepping by index always advances, where `tick += step` can stall on a step far smaller than
  // the tick; the cap guards a degenerate range all the same.
  const first = Math.ceil(min / step);
  for (let n = 0; n < 100; n += 1) {
    const tick = (first + n) * step;
    if (tick > max + step * 1e-9) break;
    ticks.push(Number(tick.toPrecision(12)));
  }
  return ticks;
}

const HOUR_MS = 3_600_000;
const TIME_STEPS_MS = [1, 3, 6, 12, 24, 48, 96, 168, 336, 720, 1440, 2160, 4320, 8760].map(
  (hours) => hours * HOUR_MS,
);

/**
 * Time-axis ticks on whole UTC hours or days: the smallest standard step (1 h to a year) that
 * gives at most `count` ticks across `[start, end]`.
 */
export function timeTicks(start: number, end: number, count = 4): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return Number.isFinite(start) ? [start] : [];
  }
  const step =
    TIME_STEPS_MS.find((candidate) => (end - start) / candidate <= count) ??
    TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  const ticks: number[] = [];
  for (let tick = Math.ceil(start / step) * step; tick <= end; tick += step) ticks.push(tick);
  return ticks;
}

/**
 * A point series as CSV: UTC time, then the value (or mean, min and max for an ensemble).
 *
 * Args:
 *   steps: The series.
 *   valueHeader: The value column's name, e.g. `temperature_2m (degree_Celsius)`.
 *
 * Returns:
 *   The CSV text, one row per step; missing values are empty cells.
 */
export function seriesCsv(steps: readonly SeriesStep[], valueHeader: string): string {
  const ensemble = steps.some((step) => step.min !== undefined);
  const quote = (text: string) => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const cell = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? String(value) : "";
  const header = ensemble
    ? ["time_utc", `${valueHeader} mean`, `${valueHeader} min`, `${valueHeader} max`]
    : ["time_utc", valueHeader];
  const rows = steps.map((step) =>
    [
      new Date(step.time).toISOString(),
      cell(step.value),
      ...(ensemble ? [cell(step.min), cell(step.max)] : []),
    ].join(","),
  );
  return [header.map(quote).join(","), ...rows].join("\n") + "\n";
}
