import type { AlgorithmParameter } from "./types";

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
  | "contour";

/** A native file-dialog filter (Tauri `open`/`save` shape). */
export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * A raster processing tool. Unlike `ProcessingAlgorithm`, raster tools never
 * run client-side: they always execute on the Python sidecar (rasterio/GDAL)
 * with a file path in and a file path out. The tool only declares its
 * operation parameters; the dialog always renders the primary input/output
 * file pickers from `inputFilters` / `outputFilters` / `defaultOutputName`.
 */
export interface RasterTool {
  id: RasterToolId;
  name: string;
  description: string;
  group: "Terrain" | "Reproject" | "Clip" | "Raster to Vector";
  /** Raster output writes a GeoTIFF; vector output writes a GeoJSON. */
  outputKind: "raster" | "vector";
  defaultOutputName: string;
  inputFilters: FileFilter[];
  outputFilters: FileFilter[];
  /** Operation knobs (not the primary input/output paths). */
  parameters: AlgorithmParameter[];
}

const GEOTIFF_INPUT: FileFilter[] = [
  { name: "GeoTIFF", extensions: ["tif", "tiff"] },
];
const GEOTIFF_OUTPUT: FileFilter[] = [
  { name: "GeoTIFF", extensions: ["tif", "tiff"] },
];
const GEOJSON_OUTPUT: FileFilter[] = [
  { name: "GeoJSON", extensions: ["geojson", "json"] },
];

const RESAMPLING_OPTIONS = [
  { value: "nearest", label: "Nearest neighbour" },
  { value: "bilinear", label: "Bilinear" },
  { value: "cubic", label: "Cubic" },
];

export const hillshadeTool: RasterTool = {
  id: "hillshade",
  name: "Hillshade",
  description:
    "Compute a shaded-relief (hillshade) raster from an elevation model.",
  group: "Terrain",
  outputKind: "raster",
  defaultOutputName: "hillshade.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
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
  description:
    "Compute aspect (compass direction of the steepest slope) from an elevation model.",
  group: "Terrain",
  outputKind: "raster",
  defaultOutputName: "aspect.tif",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOTIFF_OUTPUT,
  parameters: [
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
        "A GeoJSON file (in the raster's CRS) whose geometries define the clip region.",
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
  description:
    "Convert a raster band into vector polygons grouped by pixel value.",
  group: "Raster to Vector",
  outputKind: "vector",
  defaultOutputName: "polygons.geojson",
  inputFilters: GEOTIFF_INPUT,
  outputFilters: GEOJSON_OUTPUT,
  parameters: [
    { id: "band", label: "Band", type: "number", default: 1, min: 1, step: 1 },
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
    { id: "band", label: "Band", type: "number", default: 1, min: 1, step: 1 },
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
];

export function getRasterTool(id: string): RasterTool | undefined {
  return RASTER_TOOLS.find((tool) => tool.id === id);
}
