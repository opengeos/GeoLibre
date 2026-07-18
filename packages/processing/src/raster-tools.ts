import type { AlgorithmParameter } from "./types";
import { SENSOR_IDS, SPECTRAL_INDICES } from "./spectral-indices";

/**
 * Identifiers of the raster processing tools. Kept in sync by hand with the
 * `RasterToolKind` union in `@geolibre/core` (`store.ts`).
 */
export type RasterToolId =
  | "hillshade"
  | "slope"
  | "aspect"
  | "reproject"
  | "resample"
  | "clip-extent"
  | "clip-mask"
  | "polygonize"
  | "contour"
  | "interpolate"
  | "zonal"
  | "raster-calc"
  | "spectral-index"
  | "reclassify"
  | "mosaic"
  | "focal";

/** A native file-dialog filter (Tauri `open`/`save` shape). */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * A raster processing tool. Most raster tools execute on the Python sidecar
 * (rasterio/GDAL) with a file path in and a file path out. A subset also has an
 * in-browser implementation (`supportsClient`) backed by `geotiff.js`, so the
 * toolbox degrades gracefully when no sidecar is running, mirroring the vector
 * tools. The tool only declares its operation parameters; the dialog always
 * renders the primary input/output file pickers from `inputFilters` /
 * `outputFilters` / `defaultOutputName`.
 */
export interface RasterTool {
  id: RasterToolId;
  name: string;
  description: string;
  group: "Terrain" | "Reproject" | "Clip" | "Raster to Vector" | "Vector to Raster" | "Analysis";
  /** Raster output writes a GeoTIFF; vector output writes a GeoJSON. */
  outputKind: "raster" | "vector";
  defaultOutputName: string;
  inputFilters: FileFilter[];
  outputFilters: FileFilter[];
  /**
   * i18n key for the primary input file picker label. Defaults to
   * `toolbar.rasterTool.inputRaster`; tools that take a vector input (e.g.
   * interpolation reads a point GeoJSON) override it so the dialog reads
   * correctly.
   */
  inputLabel?: string;
  /**
   * Whether the tool also runs entirely in the browser (no sidecar required),
   * via the `geotiff.js` client engine. The dialog shows an engine selector for
   * these tools and adds the computed raster straight to the map.
   */
  supportsClient?: boolean;
  /** Operation knobs (not the primary input/output paths). */
  parameters: AlgorithmParameter[];
}

const GEOTIFF_INPUT: FileFilter[] = [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }];
const GEOTIFF_OUTPUT: FileFilter[] = [{ name: "GeoTIFF", extensions: ["tif", "tiff"] }];
const GEOJSON_OUTPUT: FileFilter[] = [{ name: "GeoJSON", extensions: ["geojson", "json"] }];
const GEOJSON_INPUT: FileFilter[] = [{ name: "GeoJSON", extensions: ["geojson", "json"] }];

const RESAMPLING_OPTIONS = [
  { value: "nearest", label: "Nearest neighbour" },
  { value: "bilinear", label: "Bilinear" },
  { value: "cubic", label: "Cubic" },
];

export const hillshadeTool: RasterTool = {
  id: "hillshade",
  name: "Hillshade",
  description: "Compute a shaded-relief (hillshade) raster from an elevation model.",
  group: "Terrain",
  outputKind: "raster",
  defaultOutputName: "hillshade.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  parameters: [
    {
      id: "azimuth",
      label: "Azimuth (degrees)",
      type: "number",
      default: 315,
      min: 0,
      max: 360,
      step: 1,
    },
    {
      id: "altitude",
      label: "Altitude (degrees)",
      type: "number",
      default: 45,
      min: 0,
      max: 90,
      step: 1,
    },
    {
      id: "z_factor",
      label: "Z factor",
      type: "number",
      default: 1,
      min: 0,
      step: 0.1,
    },
  ],
};

export const slopeTool: RasterTool = {
  id: "slope",
  name: "Slope",
  description: "Compute slope (steepness) from an elevation model.",
  group: "Terrain",
  outputKind: "raster",
  defaultOutputName: "slope.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  parameters: [
    {
      id: "units",
      label: "Units",
      type: "select",
      default: "degrees",
      options: [
        { value: "degrees", label: "Degrees" },
        { value: "percent", label: "Percent" },
      ],
    },
    {
      id: "z_factor",
      label: "Z factor",
      type: "number",
      default: 1,
      min: 0,
      step: 0.1,
    },
  ],
};

export const aspectTool: RasterTool = {
  id: "aspect",
  name: "Aspect",
  description: "Compute aspect (compass direction of the steepest slope) from an elevation model.",
  group: "Terrain",
  outputKind: "raster",
  defaultOutputName: "aspect.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  // Aspect is a direction, so a z_factor would have no effect on the result.
  parameters: [],
};

export const reprojectTool: RasterTool = {
  id: "reproject",
  name: "Reproject",
  description: "Warp a raster to a different coordinate reference system.",
  group: "Reproject",
  outputKind: "raster",
  defaultOutputName: "reprojected.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  parameters: [
    {
      id: "dst_crs",
      label: "Target CRS",
      type: "string",
      required: true,
      default: "EPSG:3857",
      description: "An authority code such as EPSG:3857 or EPSG:4326.",
    },
    {
      id: "resampling",
      label: "Resampling",
      type: "select",
      default: "nearest",
      options: RESAMPLING_OPTIONS,
    },
  ],
};

export const resampleTool: RasterTool = {
  id: "resample",
  name: "Resample",
  description: "Resample a raster to a different pixel size (resolution).",
  group: "Reproject",
  outputKind: "raster",
  defaultOutputName: "resampled.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  parameters: [
    {
      id: "resolution",
      label: "Target pixel size",
      type: "number",
      required: true,
      min: 0.0001,
      step: 0.0001,
      description: "Output pixel size in the raster's CRS units.",
    },
    {
      id: "resampling",
      label: "Resampling",
      type: "select",
      default: "bilinear",
      options: RESAMPLING_OPTIONS,
    },
  ],
};

export const clipExtentTool: RasterTool = {
  id: "clip-extent",
  name: "Clip by extent",
  description: "Crop a raster to a bounding box (in the raster's CRS).",
  group: "Clip",
  outputKind: "raster",
  defaultOutputName: "clipped.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  parameters: [
    { id: "minx", label: "Min X", type: "number", required: true, step: 0.0001 },
    { id: "miny", label: "Min Y", type: "number", required: true, step: 0.0001 },
    { id: "maxx", label: "Max X", type: "number", required: true, step: 0.0001 },
    { id: "maxy", label: "Max Y", type: "number", required: true, step: 0.0001 },
  ],
};

export const clipMaskTool: RasterTool = {
  id: "clip-mask",
  name: "Clip by mask layer",
  description: "Clip a raster to the geometries of a vector mask file.",
  group: "Clip",
  outputKind: "raster",
  defaultOutputName: "masked.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  parameters: [
    {
      id: "mask_path",
      label: "Mask layer",
      type: "path",
      required: true,
      fileFilters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
      description:
        "A GeoJSON file whose geometries define the clip region. It is reprojected to the raster's CRS automatically (a GeoJSON with no CRS is assumed to be WGS84).",
    },
    {
      id: "crop",
      label: "Crop to mask extent",
      type: "boolean",
      default: true,
    },
    {
      id: "all_touched",
      label: "Include all touched pixels",
      type: "boolean",
      default: false,
    },
  ],
};

export const polygonizeTool: RasterTool = {
  id: "polygonize",
  name: "Polygonize",
  description: "Convert a raster band into vector polygons grouped by pixel value.",
  group: "Raster to Vector",
  outputKind: "vector",
  defaultOutputName: "polygons.geojson",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOJSON_OUTPUT,
  parameters: [
    { id: "band", label: "Band", type: "number", default: 1, min: 1, max: 99, step: 1 },
    {
      id: "connectivity",
      label: "Connectivity",
      type: "select",
      default: "4",
      options: [
        { value: "4", label: "4-connected" },
        { value: "8", label: "8-connected" },
      ],
    },
    {
      id: "field",
      label: "Value field name",
      type: "string",
      default: "value",
    },
  ],
};

export const contourTool: RasterTool = {
  id: "contour",
  name: "Contour",
  description: "Generate contour lines from an elevation model.",
  group: "Raster to Vector",
  outputKind: "vector",
  defaultOutputName: "contours.geojson",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOJSON_OUTPUT,
  parameters: [
    { id: "band", label: "Band", type: "number", default: 1, min: 1, max: 99, step: 1 },
    {
      id: "interval",
      label: "Interval",
      type: "number",
      required: true,
      min: 0.1,
      step: 0.1,
      description: "Elevation difference between successive contour lines.",
    },
    { id: "base", label: "Base", type: "number", default: 0, step: 0.1 },
    {
      id: "attribute",
      label: "Elevation field name",
      type: "string",
      default: "elev",
    },
  ],
};

export const interpolateTool: RasterTool = {
  id: "interpolate",
  name: "Interpolation (IDW / Kriging)",
  description:
    "Interpolate a point layer's numeric attribute into a continuous raster surface using inverse distance weighting or ordinary kriging.",
  group: "Vector to Raster",
  outputKind: "raster",
  defaultOutputName: "interpolated.tif",
  inputFilters: GEOJSON_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputPoints",
  parameters: [
    {
      id: "field",
      label: "Value field",
      type: "string",
      required: true,
      description:
        "Name of the numeric point attribute to interpolate (e.g. elevation, temperature).",
    },
    {
      id: "method",
      label: "Method",
      type: "select",
      default: "idw",
      options: [
        { value: "idw", label: "Inverse distance weighting (IDW)" },
        { value: "kriging", label: "Ordinary kriging" },
      ],
    },
    {
      id: "resolution",
      label: "Output pixel size",
      type: "number",
      required: true,
      min: 0.000001,
      step: 0.0001,
      description:
        "Cell size in the layer's CRS units (degrees for WGS84). The grid covers the points' extent.",
    },
    {
      id: "power",
      label: "IDW power",
      type: "number",
      default: 2,
      min: 0.1,
      step: 0.1,
      visibleWhen: { param: "method", in: ["idw"] },
      description: "Higher values give nearby points more influence.",
    },
    {
      id: "variogram_model",
      label: "Variogram model",
      type: "select",
      default: "spherical",
      options: [
        { value: "spherical", label: "Spherical" },
        { value: "exponential", label: "Exponential" },
        { value: "gaussian", label: "Gaussian" },
        { value: "linear", label: "Linear" },
      ],
      visibleWhen: { param: "method", in: ["kriging"] },
      description:
        "Theoretical model fitted to the empirical semivariogram. Kriging is capped at 1500 points.",
    },
  ],
};

export const zonalStatisticsTool: RasterTool = {
  id: "zonal",
  name: "Zonal statistics",
  description:
    "Summarize raster values within each polygon of a vector layer (count, min, max, mean, sum, std, median).",
  group: "Analysis",
  outputKind: "vector",
  defaultOutputName: "zonal-stats.geojson",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOJSON_OUTPUT,
  parameters: [
    {
      id: "zones_path",
      label: "Zones layer",
      type: "path",
      required: true,
      fileFilters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
      description:
        "A GeoJSON polygon layer defining the zones. It is reprojected to the raster's CRS automatically (a GeoJSON with no CRS is assumed to be WGS84).",
    },
    { id: "band", label: "Band", type: "number", default: 1, min: 1, max: 99, step: 1 },
    {
      id: "prefix",
      label: "Field prefix",
      type: "string",
      default: "",
      description:
        "Prepended to each statistic field name (e.g. 'dem_' → 'dem_mean'). Leave blank for bare 'mean', 'min', …",
    },
  ],
};

export const rasterCalculatorTool: RasterTool = {
  id: "raster-calc",
  name: "Raster calculator",
  description:
    "Evaluate a NumPy band-math expression. Reference band 1 of each input as A, B, C and specific bands as A1, A2, …; e.g. NDVI is (A2 - A1) / (A2 + A1).",
  group: "Analysis",
  outputKind: "raster",
  defaultOutputName: "calc.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputRasterA",
  supportsClient: true,
  parameters: [
    {
      id: "expression",
      label: "Expression",
      type: "string",
      required: true,
      description:
        "A NumPy expression over A, B, C (and A1, A2, …). Functions: where, log, exp, sqrt, abs, clip, minimum, maximum, sin, cos, tan.",
    },
    {
      id: "b_path",
      label: "Raster B (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
      description: "A second raster, referenced as B / B1, B2, …. Must match A's dimensions.",
    },
    {
      id: "c_path",
      label: "Raster C (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
      description: "A third raster, referenced as C / C1, C2, …. Must match A's dimensions.",
    },
  ],
};

const SENSOR_LABELS: Record<(typeof SENSOR_IDS)[number], string> = {
  sentinel2: "Sentinel-2 (B2, B3, B4, B8, B11, B12)",
  landsat89: "Landsat 8/9 (B1–B7)",
  naip: "NAIP (R, G, B, NIR)",
  custom: "Custom (set band numbers below)",
};

/** A custom-only band-number input, gated on the "custom" sensor. */
function bandParam(id: string, label: string): AlgorithmParameter {
  return {
    id,
    label,
    type: "number",
    min: 1,
    step: 1,
    visibleWhen: { param: "sensor", in: ["custom"] },
  };
}

export const spectralIndexTool: RasterTool = {
  id: "spectral-index",
  name: "Spectral index",
  description:
    "Compute a named spectral index (NDVI, NDWI, EVI, …) from a multiband raster. Pick a sensor preset for the band layout, or set band numbers manually with the Custom sensor.",
  group: "Analysis",
  outputKind: "raster",
  defaultOutputName: "index.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  parameters: [
    {
      id: "index",
      label: "Index",
      type: "select",
      default: SPECTRAL_INDICES[0].id,
      options: SPECTRAL_INDICES.map((index) => ({
        value: index.id,
        label: index.name,
      })),
    },
    {
      id: "sensor",
      label: "Sensor / band layout",
      type: "select",
      default: SENSOR_IDS[0],
      options: SENSOR_IDS.map((id) => ({ value: id, label: SENSOR_LABELS[id] })),
      description:
        "Preset band numbers for common sensors. Choose Custom to map bands by hand for a differently stacked GeoTIFF.",
    },
    bandParam("red", "Red band number"),
    bandParam("green", "Green band number"),
    bandParam("blue", "Blue band number"),
    bandParam("nir", "NIR band number"),
    bandParam("swir1", "SWIR1 band number"),
    bandParam("swir2", "SWIR2 band number"),
    {
      id: "L",
      label: "Soil factor (L)",
      type: "number",
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.1,
      visibleWhen: { param: "index", in: ["savi"] },
      description: "SAVI soil-brightness correction (0 dense cover → 1 bare soil).",
    },
    {
      id: "scale",
      label: "Reflectance scale",
      type: "number",
      default: 1,
      // Must stay > 0 to match buildSpectralIndexExpression's guard; a tiny
      // floor still permits sub-0.0001 scales (e.g. Landsat C2's 0.0000275).
      min: 0.000001,
      step: 0.0001,
      description:
        "Multiplier converting pixel values to reflectance (0–1). Leave at 1 for normalized-difference indices; set it for EVI/SAVI on integer-DN imagery (e.g. 0.0001 for Sentinel-2 L2A).",
    },
  ],
};

export const reclassifyTool: RasterTool = {
  id: "reclassify",
  name: "Reclassify",
  description: "Remap value ranges to new class values using a rule table.",
  group: "Analysis",
  outputKind: "raster",
  defaultOutputName: "reclassified.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  parameters: [
    { id: "band", label: "Band", type: "number", default: 1, min: 1, max: 99, step: 1 },
    {
      id: "table",
      label: "Rules",
      type: "string",
      required: true,
      description:
        "Comma- or newline-separated 'min:max:newvalue' rules, e.g. '0:10:1, 10:20:2, 20:max:3'. Ranges are half-open [min, max); blank/min/max mean ±∞.",
    },
    {
      id: "unmatched",
      label: "Unmatched values",
      type: "select",
      default: "nodata",
      options: [
        { value: "nodata", label: "Set to NoData" },
        { value: "original", label: "Keep original value" },
      ],
    },
  ],
};

export const mosaicTool: RasterTool = {
  id: "mosaic",
  name: "Mosaic / merge",
  description:
    "Combine up to five rasters (sharing a CRS) into a single raster covering their union.",
  group: "Analysis",
  outputKind: "raster",
  defaultOutputName: "mosaic.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputRaster1",
  parameters: [
    {
      id: "raster_2",
      label: "Second raster",
      type: "path",
      required: true,
      fileFilters: GEOTIFF_INPUT,
    },
    {
      id: "raster_3",
      label: "Third raster (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
    },
    {
      id: "raster_4",
      label: "Fourth raster (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
    },
    {
      id: "raster_5",
      label: "Fifth raster (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
    },
    {
      id: "method",
      label: "Overlap method",
      type: "select",
      default: "first",
      options: [
        { value: "first", label: "First" },
        { value: "last", label: "Last" },
        { value: "min", label: "Minimum" },
        { value: "max", label: "Maximum" },
      ],
      description: "Which value wins where inputs overlap.",
    },
  ],
};

export const focalStatisticsTool: RasterTool = {
  id: "focal",
  name: "Focal statistics",
  description: "Apply a moving-window (neighbourhood) statistic to a raster band.",
  group: "Analysis",
  outputKind: "raster",
  defaultOutputName: "focal.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  parameters: [
    { id: "band", label: "Band", type: "number", default: 1, min: 1, max: 99, step: 1 },
    {
      id: "statistic",
      label: "Statistic",
      type: "select",
      default: "mean",
      options: [
        { value: "mean", label: "Mean" },
        { value: "median", label: "Median" },
        { value: "min", label: "Minimum" },
        { value: "max", label: "Maximum" },
        { value: "sum", label: "Sum" },
        { value: "std", label: "Standard deviation" },
        { value: "range", label: "Range (max − min)" },
      ],
    },
    {
      id: "size",
      label: "Window size",
      type: "number",
      default: 3,
      min: 3,
      max: 25,
      step: 2,
      description: "Odd neighbourhood size in pixels (3 = 3×3). Capped at 25.",
    },
  ],
};

/** Every raster tool, in display order (grouped by `group`). */
export const RASTER_TOOLS: RasterTool[] = [
  hillshadeTool,
  slopeTool,
  aspectTool,
  reprojectTool,
  resampleTool,
  clipExtentTool,
  clipMaskTool,
  polygonizeTool,
  contourTool,
  interpolateTool,
  zonalStatisticsTool,
  rasterCalculatorTool,
  spectralIndexTool,
  reclassifyTool,
  mosaicTool,
  focalStatisticsTool,
];

export function getRasterTool(id: string): RasterTool | undefined {
  return RASTER_TOOLS.find((tool) => tool.id === id);
}
