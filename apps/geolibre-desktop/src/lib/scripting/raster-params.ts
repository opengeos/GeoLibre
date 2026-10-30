import type { GeoLibreCogLayerOptions } from "@geolibre/plugins";

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
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
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
  for (const key of ["rescaleMin", "rescaleMax", "nodata", "opacity"] as const) {
    const number = raw[key];
    if (typeof number === "number" && Number.isFinite(number)) options[key] = number;
  }
  return options;
}
