export const WMS_TILE_PROTOCOL = "geolibre-wms";

export function isHttpWmsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function nativeWmsTileUrl(url: string): string {
  if (url.startsWith(`${WMS_TILE_PROTOCOL}://`)) return url;
  if (!isHttpWmsUrl(url)) {
    throw new Error("Invalid WMS tile URL.");
  }
  // Leave MapLibre's WMS placeholder visible so it expands the bounding box
  // before handing the concrete request URL to the custom protocol.
  const encoded = encodeURIComponent(url).replaceAll("%7Bbbox-epsg-3857%7D", "{bbox-epsg-3857}");
  return `${WMS_TILE_PROTOCOL}://tile?url=${encoded}`;
}
