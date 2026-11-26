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
  | "focal"
  | "change-difference"
  | "ndvi-change"
  | "transition-matrix"
  | "sar-db"
  | "speckle-filter"
  | "sar-rgb"
  | "flood-map"
  | "building-shadows";

/** A native file-dialog filter (Tauri `open`/`save` shape). */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * A raster processing tool. The classic tools execute on the Python sidecar
 * (rasterio/GDAL) with a file path in and a file path out, and every tool also has an
 * in-browser implementation (`supportsClient`, see `raster-client.ts`), so the
 * toolbox degrades gracefully when no sidecar is running, mirroring the vector
 * tools. The tool only declares its operation parameters; the dialog always
 * renders the primary input/output file pickers from `inputFilters` /
 * `outputFilters` / `defaultOutputName`.
 */
export interface RasterTool {
  id: RasterToolId;
  name: string;
  description: string;
  group:
    | "Terrain"
    | "Reproject"
    | "Clip"
    | "Raster to Vector"
    | "Vector to Raster"
    | "Analysis"
    | "Change Detection"
    | "SAR"
    | "3D Terrain";
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
  /**
   * The tool runs only in the browser (the sidecar has no worker for it), so
   * the dialog offers no engine choice.
   */
  clientOnly?: boolean;
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
  supportsClient: true,
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
  supportsClient: true,
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
    {
      id: "minx",
      label: "Min X",
      type: "number",
      required: true,
      step: 0.0001,
    },
    {
      id: "miny",
      label: "Min Y",
      type: "number",
      required: true,
      step: 0.0001,
    },
    {
      id: "maxx",
      label: "Max X",
      type: "number",
      required: true,
      step: 0.0001,
    },
    {
      id: "maxy",
      label: "Max Y",
      type: "number",
      required: true,
      step: 0.0001,
    },
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
  supportsClient: true,
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
  supportsClient: true,
  parameters: [
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
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
  supportsClient: true,
  parameters: [
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
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
  supportsClient: true,
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
  supportsClient: true,
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
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
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
      options: SENSOR_IDS.map((id) => ({
        value: id,
        label: SENSOR_LABELS[id],
      })),
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
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
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
    "Combine up to five rasters (sharing a CRS) into a single raster covering their union. In the browser the rasters must also share a pixel grid.",
  group: "Analysis",
  outputKind: "raster",
  defaultOutputName: "mosaic.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
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
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
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

/** A required second-date raster for the change detection tools. */
const AFTER_RASTER_PARAM: AlgorithmParameter = {
  id: "after_path",
  label: "After raster",
  type: "path",
  required: true,
  fileFilters: GEOTIFF_INPUT,
  description:
    "The later image, on the same pixel grid as the before raster (reproject or resample it first if needed).",
};

const CHANGE_THRESHOLD_VISIBLE = { param: "output", in: ["classified"] };

export const bandDifferenceTool: RasterTool = {
  id: "change-difference",
  name: "Band difference",
  description:
    "Compare one band of two dates pixel by pixel: difference, percent change, ratio, or log ratio (dB), optionally thresholded into decrease / no change / increase classes.",
  group: "Change Detection",
  outputKind: "raster",
  defaultOutputName: "change.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputBefore",
  supportsClient: true,
  clientOnly: true,
  parameters: [
    AFTER_RASTER_PARAM,
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
    {
      id: "mode",
      label: "Change metric",
      type: "select",
      default: "difference",
      options: [
        { value: "difference", label: "Difference (after - before)" },
        { value: "percent", label: "Percent change" },
        { value: "ratio", label: "Ratio (after / before)" },
        { value: "log-ratio", label: "Log ratio (dB)" },
      ],
    },
    {
      id: "output",
      label: "Output",
      type: "select",
      default: "continuous",
      options: [
        { value: "continuous", label: "Continuous change" },
        {
          value: "classified",
          label: "Classes (-1 decrease, 0 none, 1 increase)",
        },
      ],
    },
    {
      id: "threshold",
      label: "Change threshold",
      type: "number",
      default: 0,
      min: 0,
      step: 0.1,
      visibleWhen: CHANGE_THRESHOLD_VISIBLE,
      description:
        "Minimum change counted as an increase or decrease, in the metric's units (a ratio is compared to 1).",
    },
  ],
};

export const ndviChangeTool: RasterTool = {
  id: "ndvi-change",
  name: "NDVI change",
  description:
    "Compute NDVI for two dates of a multiband image and their difference (after - before), optionally classified into vegetation loss / stable / gain with a threshold.",
  group: "Change Detection",
  outputKind: "raster",
  defaultOutputName: "ndvi-change.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputBefore",
  supportsClient: true,
  clientOnly: true,
  parameters: [
    AFTER_RASTER_PARAM,
    {
      id: "sensor",
      label: "Sensor / band layout",
      type: "select",
      default: SENSOR_IDS[0],
      options: SENSOR_IDS.map((id) => ({
        value: id,
        label: SENSOR_LABELS[id],
      })),
      description: "Preset red/NIR band numbers. Choose Custom to set them by hand.",
    },
    bandParam("red", "Red band number"),
    bandParam("nir", "NIR band number"),
    {
      id: "output",
      label: "Output",
      type: "select",
      default: "classified",
      options: [
        { value: "difference", label: "NDVI difference" },
        { value: "classified", label: "Classes (-1 loss, 0 stable, 1 gain)" },
      ],
    },
    {
      id: "threshold",
      label: "NDVI change threshold",
      type: "number",
      default: 0.2,
      min: 0,
      max: 2,
      step: 0.05,
      visibleWhen: CHANGE_THRESHOLD_VISIBLE,
      description: "Minimum NDVI difference counted as loss or gain.",
    },
  ],
};

export const transitionMatrixTool: RasterTool = {
  id: "transition-matrix",
  name: "Transition matrix",
  description:
    "Cross-tabulate two categorical (land cover) rasters: log the from/to class transition matrix and write a raster coding each pixel's transition as from x 10^n + to.",
  group: "Change Detection",
  outputKind: "raster",
  defaultOutputName: "transitions.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputBefore",
  supportsClient: true,
  clientOnly: true,
  parameters: [
    AFTER_RASTER_PARAM,
    {
      id: "band",
      label: "Band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
  ],
};

const SAR_UNITS_PARAM: AlgorithmParameter = {
  id: "units",
  label: "Input units",
  type: "select",
  default: "linear",
  options: [
    { value: "linear", label: "Linear power (sigma0 / gamma0)" },
    { value: "db", label: "Decibels (dB)" },
  ],
};

export const sarDbTool: RasterTool = {
  id: "sar-db",
  name: "Linear / dB conversion",
  description:
    "Convert SAR backscatter between linear units and decibels (10 log10 for power, 20 log10 for amplitude). When converting linear units to dB, values at or below zero have no dB value and become NoData.",
  group: "SAR",
  outputKind: "raster",
  defaultOutputName: "backscatter-db.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  clientOnly: true,
  parameters: [
    {
      id: "direction",
      label: "Direction",
      type: "select",
      default: "to-db",
      options: [
        { value: "to-db", label: "Linear to dB" },
        { value: "to-linear", label: "dB to linear" },
      ],
    },
    {
      id: "quantity",
      label: "Quantity",
      type: "select",
      default: "power",
      options: [
        { value: "power", label: "Power / intensity (10 log10)" },
        { value: "amplitude", label: "Amplitude (20 log10)" },
      ],
    },
  ],
};

export const speckleFilterTool: RasterTool = {
  id: "speckle-filter",
  name: "Speckle filter",
  description:
    "Reduce SAR speckle with the Lee filter or the edge-preserving refined Lee filter. Filtering runs on linear power; dB input is converted and converted back.",
  group: "SAR",
  outputKind: "raster",
  defaultOutputName: "despeckled.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  supportsClient: true,
  clientOnly: true,
  parameters: [
    {
      id: "method",
      label: "Filter",
      type: "select",
      default: "refined-lee",
      options: [
        { value: "refined-lee", label: "Refined Lee (7x7, edge-aligned)" },
        { value: "lee", label: "Lee" },
      ],
    },
    {
      id: "size",
      label: "Window size",
      type: "number",
      default: 7,
      min: 3,
      max: 15,
      step: 2,
      visibleWhen: { param: "method", in: ["lee"] },
      description: "Odd window size in pixels.",
    },
    {
      id: "enl",
      label: "Equivalent number of looks",
      type: "number",
      default: 4.4,
      min: 0.1,
      step: 0.1,
      description:
        "Speckle strength (noise variance = 1 / ENL). About 4.4 for Sentinel-1 IW GRD high resolution.",
    },
    SAR_UNITS_PARAM,
  ],
};

export const dualPolRgbTool: RasterTool = {
  id: "sar-rgb",
  name: "Dual-pol RGB composite",
  description:
    "Build a Sentinel-1 false-colour composite: red = VV, green = VH, blue = VV/VH ratio, each stretched over a dB range. VH comes from a second raster or from another band of the input.",
  group: "SAR",
  outputKind: "raster",
  defaultOutputName: "vv-vh-rgb.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputVv",
  supportsClient: true,
  clientOnly: true,
  parameters: [
    {
      id: "vh_path",
      label: "VH raster (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
      description:
        "A separate VH image on the same grid. Leave empty to read VH from a band of the input.",
    },
    SAR_UNITS_PARAM,
    {
      id: "vv_band",
      label: "VV band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
    {
      id: "vh_band",
      label: "VH band",
      type: "number",
      min: 1,
      max: 99,
      step: 1,
      description:
        "Leave blank for band 1 of a separate VH raster, or band 2 of the stacked input. Enter a band number to override.",
    },
    {
      id: "vv_min",
      label: "VV min (dB)",
      type: "number",
      default: -25,
      step: 1,
    },
    { id: "vv_max", label: "VV max (dB)", type: "number", default: 0, step: 1 },
    {
      id: "vh_min",
      label: "VH min (dB)",
      type: "number",
      default: -30,
      step: 1,
    },
    {
      id: "vh_max",
      label: "VH max (dB)",
      type: "number",
      default: -5,
      step: 1,
    },
    {
      id: "ratio_min",
      label: "VV/VH min (dB)",
      type: "number",
      default: 0,
      step: 1,
    },
    {
      id: "ratio_max",
      label: "VV/VH max (dB)",
      type: "number",
      default: 15,
      step: 1,
    },
  ],
};

export const floodMapTool: RasterTool = {
  id: "flood-map",
  name: "Flood mapping (SAR threshold)",
  description:
    "Map open water from VV backscatter with a dB threshold. With a pre-event image, separate new flooding from permanent water using the backscatter drop.",
  group: "SAR",
  outputKind: "raster",
  defaultOutputName: "flood.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputPostEvent",
  supportsClient: true,
  clientOnly: true,
  parameters: [
    {
      id: "pre_path",
      label: "Pre-event raster (optional)",
      type: "path",
      fileFilters: GEOTIFF_INPUT,
      description:
        "A pre-flood image on the same grid. Output: 0 neither permanent water nor new flooding, 1 permanent water, 2 new flooding. Without it: 0 not water, 1 water.",
    },
    SAR_UNITS_PARAM,
    {
      id: "band",
      label: "VV band",
      type: "number",
      default: 1,
      min: 1,
      max: 99,
      step: 1,
    },
    {
      id: "threshold_db",
      label: "Water threshold (dB)",
      type: "number",
      default: -18,
      step: 0.5,
      description: "VV backscatter below this is water. Typical values are -15 to -20 dB.",
    },
    {
      id: "change_db",
      label: "Minimum drop (dB)",
      type: "number",
      default: 3,
      min: 0,
      step: 0.5,
      description:
        "With a pre-event image: how much darker a pixel must get to count as new flooding.",
    },
  ],
};

const SHADOW_DAY_MODES = { param: "mode", in: ["sun-hours", "insolation"] };

export const buildingShadowsTool: RasterTool = {
  id: "building-shadows",
  name: "Building shadows and sun hours",
  description:
    "Cast shadows from extruded building footprints (a height or storey-count attribute) for a date and time, or simulate a whole day: hours of direct sun, or clear-sky direct insolation (kWh/m²), on the ground and on roofs.",
  group: "3D Terrain",
  outputKind: "raster",
  defaultOutputName: "building-shadows.tif",
  inputFilters: GEOJSON_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  inputLabel: "toolbar.rasterTool.inputBuildings",
  supportsClient: true,
  clientOnly: true,
  parameters: [
    {
      id: "mode",
      label: "Output",
      type: "select",
      default: "shadow",
      options: [
        { value: "shadow", label: "Shadows at a date and time" },
        { value: "sun-hours", label: "Hours of direct sun over the day" },
        { value: "insolation", label: "Clear-sky direct insolation over the day (kWh/m²)" },
      ],
    },
    {
      id: "date",
      label: "Date (YYYY-MM-DD)",
      type: "string",
      required: true,
      default: "2026-06-21",
    },
    {
      id: "time",
      label: "Local time (HH:MM)",
      type: "string",
      required: true,
      default: "15:00",
      visibleWhen: { param: "mode", in: ["shadow"] },
    },
    {
      id: "utc_offset",
      label: "UTC offset (hours)",
      type: "number",
      default: 0,
      min: -14,
      max: 14,
      step: 0.5,
      description: "Local time minus UTC, e.g. -4 for US Eastern daylight time or 2 for CEST.",
    },
    {
      id: "step_minutes",
      label: "Time step (minutes)",
      type: "number",
      default: 15,
      min: 1,
      max: 120,
      step: 1,
      visibleWhen: SHADOW_DAY_MODES,
      description: "How often the sun position is sampled across the day.",
    },
    {
      id: "height_field",
      label: "Height attribute",
      type: "string",
      default: "height",
      description: "Building height in metres.",
    },
    {
      id: "levels_field",
      label: "Storeys attribute",
      type: "string",
      default: "building:levels",
      description: "Used when a building has no height: storeys times the storey height.",
    },
    {
      id: "level_height",
      label: "Storey height (m)",
      type: "number",
      default: 3,
      min: 0.5,
      step: 0.1,
    },
    {
      id: "default_height",
      label: "Default height (m)",
      type: "number",
      default: 10,
      min: 0.5,
      step: 0.5,
      description: "Used when a building has neither attribute.",
    },
    {
      id: "cell_size",
      label: "Cell size (m)",
      type: "number",
      default: 2,
      min: 0.25,
      step: 0.25,
    },
    {
      id: "margin",
      label: "Ground margin (m)",
      type: "number",
      default: 100,
      min: 0,
      step: 10,
      description: "Open ground added around the buildings so their shadows have room to fall.",
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
  bandDifferenceTool,
  ndviChangeTool,
  transitionMatrixTool,
  sarDbTool,
  speckleFilterTool,
  dualPolRgbTool,
  floodMapTool,
  buildingShadowsTool,
];

export function getRasterTool(id: string): RasterTool | undefined {
  return RASTER_TOOLS.find((tool) => tool.id === id);
}
