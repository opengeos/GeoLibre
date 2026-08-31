export const WMS_TILE_PROTOCOL = "geolibre-wms";

export function nativeWmsTileUrl(url: string): string {
  if (url.startsWith(`${WMS_TILE_PROTOCOL}://`)) return url;
  // Leave MapLibre's WMS placeholder visible so it expands the bounding box
  // before handing the concrete request URL to the custom protocol.
  const encoded = encodeURIComponent(url).replaceAll("%7Bbbox-epsg-3857%7D", "{bbox-epsg-3857}");
  return `${WMS_TILE_PROTOCOL}://tile?url=${encoded}`;
}
