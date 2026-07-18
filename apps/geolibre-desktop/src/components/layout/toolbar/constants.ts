import type { ConversionToolKind, RasterToolKind, VectorToolKind } from "@geolibre/core";
import { type BuiltInMapControl, type MapController } from "@geolibre/map";
import type { GeoLibreMapControlPosition } from "@geolibre/plugins";
import type { ParseKeys } from "i18next";
import type { createAppAPI } from "../../../hooks/usePlugins";
import type { AddDataKind } from "../AddDataDialog";

/** The live app API surface plugins and panels are driven through. */
export type AppApi = ReturnType<typeof createAppAPI>;

/** A ref to the live MapController, shared across the toolbar pieces. */
export type MapControllerRef = React.RefObject<MapController | null>;

/** Built-in map controls that the Controls menu can toggle (all but the layer control). */
export type ToolbarMapControl = Exclude<BuiltInMapControl, "layer-control">;

/**
 * The appApi-backed "add layer" handlers shared by the Add Data menu and the
 * command palette, so each panel is opened the same way from both places.
 */
export interface AddLayerHandlers {
  vector: () => void;
  raster: () => void;
  stac: () => void;
  flatGeobuf: () => void;
  pmtiles: () => void;
  zarr: () => void;
  netcdf: () => void;
  lidar: () => void;
  splatting: () => void;
  threeDTiles: () => void;
  duckdb: () => void;
}

/** Shared styling/affordances passed to each toolbar menu's trigger button. */
export interface ToolbarChrome {
  buttonClass: string;
  secondaryButtonClass: string;
  buttonSize: "icon" | "sm";
  iconClassName: string;
  renderLabel: (label: string) => React.ReactNode;
}

export const MAP_CONTROL_ITEMS: Array<{
  id: ToolbarMapControl;
  labelKey: ParseKeys;
}> = [
  { id: "navigation", labelKey: "toolbar.mapControl.navigation" },
  { id: "fullscreen", labelKey: "toolbar.mapControl.fullscreen" },
  { id: "compass", labelKey: "toolbar.mapControl.compass" },
  { id: "geolocate", labelKey: "toolbar.mapControl.geolocate" },
  { id: "globe", labelKey: "toolbar.mapControl.globe" },
  { id: "terrain", labelKey: "toolbar.mapControl.terrain" },
  { id: "scale", labelKey: "toolbar.mapControl.scale" },
  { id: "attribution", labelKey: "toolbar.mapControl.attribution" },
  { id: "logo", labelKey: "toolbar.mapControl.logo" },
];

export const NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS = new Set<BuiltInMapControl>([
  "fullscreen",
  "compass",
  "globe",
  "layer-control",
]);

export const ALL_BUILT_IN_CONTROL_IDS: BuiltInMapControl[] = [
  ...MAP_CONTROL_ITEMS.map(({ id }) => id),
  "layer-control",
];

export const PLUGIN_POSITION_ITEMS: Array<{
  value: GeoLibreMapControlPosition;
  labelKey: ParseKeys;
}> = [
  { value: "top-left", labelKey: "toolbar.position.topLeft" },
  { value: "top-right", labelKey: "toolbar.position.topRight" },
  { value: "bottom-left", labelKey: "toolbar.position.bottomLeft" },
  { value: "bottom-right", labelKey: "toolbar.position.bottomRight" },
];

export const FEEDBACK_URL = "https://github.com/opengeos/GeoLibre/issues";
export const WEBSITE_URL = "https://geolibre.app";
export const GITHUB_URL = "https://github.com/opengeos/GeoLibre";
// A small (~350 KB) CORS-enabled Las Vegas Strip sample, so the URL field works
// out of the box on both the desktop and web builds.
export const DEFAULT_OSM_PBF_URL = "https://data.source.coop/giswqs/opengeos/LasVegas.osm.pbf";

// Static command metadata for the menus that map a single id to a label. These
// drive the command palette so it stays in sync with the menus without each
// action being defined twice. The `run` closures are built in the component
// where the store setters are in scope.
export const ADD_DATA_KIND_COMMANDS: Array<{
  kind: AddDataKind;
  titleKey: ParseKeys;
}> = [
  { kind: "delimited-text", titleKey: "toolbar.layerType.delimitedText" },
  { kind: "cad", titleKey: "toolbar.item.cadLayer" },
  { kind: "gpx", titleKey: "toolbar.layerType.gpx" },
  { kind: "mbtiles", titleKey: "toolbar.layerType.mbtiles" },
  { kind: "xyz", titleKey: "toolbar.layerType.xyz" },
  { kind: "wms", titleKey: "toolbar.layerType.wms" },
  { kind: "wfs", titleKey: "toolbar.layerType.wfs" },
  { kind: "wmts", titleKey: "toolbar.layerType.wmts" },
  { kind: "arcgis", titleKey: "toolbar.layerType.arcgis" },
  { kind: "video", titleKey: "toolbar.layerType.video" },
  { kind: "deckgl-viz", titleKey: "toolbar.layerType.deckglViz" },
  { kind: "postgres", titleKey: "toolbar.layerType.postgres" },
];

export const CONVERSION_COMMANDS: Array<{
  kind: ConversionToolKind;
  titleKey: ParseKeys;
}> = [
  {
    kind: "vector-to-geoparquet",
    titleKey: "toolbar.conversion.vectorToGeoparquet",
  },
  {
    kind: "vector-to-flatgeobuf",
    titleKey: "toolbar.conversion.vectorToFlatgeobuf",
  },
  {
    kind: "vector-to-shapefile",
    titleKey: "toolbar.conversion.vectorToShapefile",
  },
  {
    kind: "vector-to-geopackage",
    titleKey: "toolbar.conversion.vectorToGeopackage",
  },
  { kind: "csv-to-geoparquet", titleKey: "toolbar.conversion.csvToGeoparquet" },
  { kind: "vector-to-pmtiles", titleKey: "toolbar.conversion.vectorToPmtiles" },
  {
    kind: "raster-to-pmtiles",
    titleKey: "toolbar.conversion.rasterToPmtiles",
  },
  { kind: "raster-to-cog", titleKey: "toolbar.conversion.rasterToCog" },
];

export const VECTOR_TOOL_COMMANDS: Array<{
  kind: VectorToolKind;
  titleKey: ParseKeys;
}> = [
  { kind: "buffer", titleKey: "toolbar.vectorTool.buffer" },
  { kind: "centroids", titleKey: "toolbar.vectorTool.centroids" },
  { kind: "convex-hull", titleKey: "toolbar.vectorTool.convexHull" },
  { kind: "dissolve", titleKey: "toolbar.vectorTool.dissolve" },
  { kind: "bounding-box", titleKey: "toolbar.vectorTool.boundingBox" },
  { kind: "simplify", titleKey: "toolbar.vectorTool.simplify" },
  { kind: "clip", titleKey: "toolbar.vectorTool.clip" },
  { kind: "intersection", titleKey: "toolbar.vectorTool.intersection" },
  { kind: "difference", titleKey: "toolbar.vectorTool.difference" },
  { kind: "union", titleKey: "toolbar.vectorTool.union" },
  { kind: "spatial-join", titleKey: "toolbar.vectorTool.spatialJoin" },
  { kind: "attribute-join", titleKey: "toolbar.vectorTool.attributeJoin" },
  { kind: "select-by-value", titleKey: "toolbar.vectorTool.selectByValue" },
  {
    kind: "select-by-location",
    titleKey: "toolbar.vectorTool.selectByLocation",
  },
  { kind: "reproject", titleKey: "toolbar.vectorTool.reproject" },
  { kind: "explode", titleKey: "toolbar.vectorTool.explode" },
  { kind: "aggregate", titleKey: "toolbar.vectorTool.aggregate" },
  { kind: "smooth", titleKey: "toolbar.vectorTool.smooth" },
  { kind: "grid", titleKey: "toolbar.vectorTool.grid" },
  { kind: "voronoi", titleKey: "toolbar.vectorTool.voronoi" },
  { kind: "h3-grid", titleKey: "toolbar.vectorTool.h3Grid" },
  { kind: "h3-bin-points", titleKey: "toolbar.vectorTool.h3BinPoints" },
];

export const RASTER_TOOL_COMMANDS: Array<{
  kind: RasterToolKind;
  titleKey: ParseKeys;
}> = [
  { kind: "hillshade", titleKey: "toolbar.rasterTool.hillshade" },
  { kind: "slope", titleKey: "toolbar.rasterTool.slope" },
  { kind: "aspect", titleKey: "toolbar.rasterTool.aspect" },
  { kind: "reproject", titleKey: "toolbar.rasterTool.reproject" },
  { kind: "resample", titleKey: "toolbar.rasterTool.resample" },
  { kind: "clip-extent", titleKey: "toolbar.rasterTool.clipExtent" },
  { kind: "clip-mask", titleKey: "toolbar.rasterTool.clipMask" },
  { kind: "polygonize", titleKey: "toolbar.rasterTool.polygonize" },
  { kind: "contour", titleKey: "toolbar.rasterTool.contour" },
  { kind: "interpolate", titleKey: "toolbar.rasterTool.interpolate" },
  { kind: "zonal", titleKey: "toolbar.rasterTool.zonal" },
  { kind: "raster-calc", titleKey: "toolbar.rasterTool.rasterCalc" },
  { kind: "spectral-index", titleKey: "toolbar.rasterTool.spectralIndex" },
  { kind: "reclassify", titleKey: "toolbar.rasterTool.reclassify" },
  { kind: "mosaic", titleKey: "toolbar.rasterTool.mosaic" },
  { kind: "focal", titleKey: "toolbar.rasterTool.focal" },
];

// Re-exported so existing toolbar imports keep working; the shared helper
// guards the URL scheme and logs opener failures instead of rejecting.
export { openExternalLink } from "../../../lib/open-external";

/** Format a recent-project timestamp for display, or "" if unparseable. */
export function formatRecentProjectTime(openedAt: string): string {
  const openedDate = new Date(openedAt);
  if (Number.isNaN(openedDate.getTime())) return "";

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(openedDate);
}

/** Initial toolbar control visibility map applied when a new project is created. */
export function newProjectToolbarControlVisibility(): Record<ToolbarMapControl, boolean> {
  return MAP_CONTROL_ITEMS.reduce(
    (acc, { id }) => {
      acc[id] = NEW_PROJECT_VISIBLE_BUILT_IN_CONTROLS.has(id);
      return acc;
    },
    {} as Record<ToolbarMapControl, boolean>,
  );
}
