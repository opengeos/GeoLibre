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
 * Most slices of the other dimensions one chunk may hold for the dataset to count as drawable.
 *
 * A map draws one slice, but the reader decodes whole chunks. dynamical.org's "time-optimized"
 * archives pack a forecast's lead times into each chunk (49-105 of them, so a global GFS slice is
 * ~70 MB), and the analyses and ensembles pack hundreds to thousands (1-6 GB per global slice).
 * The first group renders in seconds and steps lead times from cache; the second never finishes.
 */
export const MAX_SLICES_PER_CHUNK = 128;

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

/** Why a dataset can or cannot be drawn in the browser. */
export type DynamicalMapSupport = "supported" | "virtual" | "time-series";

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
  /** Whether chunks point into the producer's GRIB files rather than at Zarr chunks. */
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

/**
 * Whether the browser can draw a dataset.
 *
 * Virtual repositories reference the producer's GRIB2 files and decode them with the `gribberish`
 * codec, which has no JavaScript build; the others are judged on their chunk layout
 * ({@link MAX_SLICES_PER_CHUNK}).
 */
export function datasetMapSupport(dataset: DynamicalDataset): DynamicalMapSupport {
  if (dataset.virtual) return "virtual";
  // The worst variable decides: the panel offers every variable of a dataset it lists as ready.
  const worst = Math.max(
    1,
    ...dataset.variables.map((variable) => slicesPerChunk(dataset, variable)),
  );
  return worst > MAX_SLICES_PER_CHUNK ? "time-series" : "supported";
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
