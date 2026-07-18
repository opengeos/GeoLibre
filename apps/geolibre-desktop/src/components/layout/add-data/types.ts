/**
 * Shared types for the Add Data dialog and its per-source subcomponents.
 */

export type AddDataKind =
  | "xyz"
  | "wms"
  | "wfs"
  | "wmts"
  | "ogc-vector-tiles"
  | "gpx"
  | "georss"
  | "delimited-text"
  | "cad"
  | "gdb"
  | "photos"
  | "mbtiles"
  | "arcgis"
  | "postgres"
  | "deckgl-viz"
  | "video";

/** A data source loadable either from a remote URL or a local file. */
export type FeedMode = "url" | "file";
export type GpxMode = FeedMode;
export type GpxLayerKind = "waypoints" | "tracks" | "trackPoints" | "routes" | "routePoints";
export type GeoRssMode = FeedMode;
export type DelimitedTextMode = FeedMode;
export type DelimitedTextDelimiter = "comma" | "tab" | "semicolon" | "pipe" | "custom";
