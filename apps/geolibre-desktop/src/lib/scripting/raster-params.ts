import type { GeoLibreCogLayerOptions, GeoLibreTileLayerOptions } from "@geolibre/plugins";

/**
 * Validate a raster source URL from an untrusted command payload.
 *
 * @param command - The command name, used in the error message.
 * @param url - The raw `url` param.
 * @returns The URL when it is an http(s) string.
 */
export function requireHttpUrl(command: string, url: unknown): string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error(`${command}: url must be an http(s) URL string`);
  }
  return url;
}

/**
 * Decode the base64 GeoTIFF a notebook sends with `addRasterBytes`.
 *
 * @param data - The base64 text.
 * @returns The decoded bytes.
 */
export function base64ToBytes(data: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new Error("addRasterBytes: data is not valid base64");
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Keep the well-typed COG display options from an untrusted command payload.
 *
 * @param value - The raw `options` param.
 * @returns The options to pass to the raster control; invalid fields are dropped.
 */
export function cogOptionsFromParams(value: unknown): GeoLibreCogLayerOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const options: GeoLibreCogLayerOptions = {};
  if (typeof raw.bands === "string") options.bands = raw.bands;
  if (typeof raw.colormap === "string") options.colormap = raw.colormap;
  if (typeof raw.zoomTo === "boolean") options.zoomTo = raw.zoomTo;
  if (typeof raw.beforeLayerId === "string") options.beforeLayerId = raw.beforeLayerId;
  if (
    raw.engine === "auto" ||
    raw.engine === "maplibre-gl-raster" ||
    raw.engine === "cog-tiler-wasm" ||
    raw.engine === "titiler"
  ) {
    options.engine = raw.engine;
  }
  for (const key of ["rescaleMin", "rescaleMax", "nodata", "opacity"] as const) {
    const number = raw[key];
    if (typeof number === "number" && Number.isFinite(number)) options[key] = number;
  }
  return options;
}

/**
 * Keep the tile source options from an untrusted command payload.
 *
 * The store spreads these over the validated URL, so anything else, such as
 * `tiles`, must not get through.
 *
 * @param value - The raw `options` param.
 * @returns The options to pass to the store; invalid fields are dropped.
 */
export function tileOptionsFromParams(value: unknown): GeoLibreTileLayerOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const options: GeoLibreTileLayerOptions = {};
  if (typeof raw.attribution === "string") options.attribution = raw.attribution;
  if (typeof raw.visible === "boolean") options.visible = raw.visible;
  if (raw.scheme === "xyz" || raw.scheme === "tms") options.scheme = raw.scheme;
  for (const key of ["tileSize", "minzoom", "maxzoom", "opacity"] as const) {
    const number = raw[key];
    if (typeof number === "number" && Number.isFinite(number)) options[key] = number;
  }
  const bounds = raw.bounds;
  if (
    Array.isArray(bounds) &&
    bounds.length === 4 &&
    bounds.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    options.bounds = bounds as [number, number, number, number];
  }
  return options;
}
