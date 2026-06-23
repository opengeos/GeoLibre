/**
 * Shared types for the Add Data dialog and its per-source subcomponents.
 */

export type AddDataKind =
  | "xyz"
  | "wms"
  | "wfs"
  | "wmts"
  | "gpx"
  | "georss"
  | "delimited-text"
  | "mbtiles"
  | "arcgis"
  | "postgres"
  | "deckgl-viz"
  | "video";

export type GpxMode = "url" | "file";
export type GpxLayerKind = "waypoints" | "tracks" | "routes";
export type GeoRssMode = "url" | "file";
export type DelimitedTextMode = "url" | "file";
export type DelimitedTextDelimiter =
  | "comma"
  | "tab"
  | "semicolon"
  | "pipe"
  | "custom";
