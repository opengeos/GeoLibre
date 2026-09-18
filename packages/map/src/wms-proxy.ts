/**
 * The dev-server WMS proxy shared by the MapLibre and Mapbox layer compilers.
 *
 * WMS tile templates carry a `{bbox-epsg-3857}` placeholder and often point at
 * federal/government endpoints without permissive CORS headers, so `npm run
 * dev` routes them through a same-origin proxy (`vite.config.ts`). Production
 * builds and the desktop app fetch the tiles directly.
 */

export const WMS_PROXY_PATH = "/__geolibre_wms_proxy";

/** Whether the app is served by the Vite dev server (the only host with the proxy). */
export function isViteDevServer(): boolean {
  return Boolean(
    (
      import.meta as ImportMeta & {
        env?: { DEV?: boolean };
      }
    ).env?.DEV,
  );
}

/** Rewrite one absolute WMS tile template to go through the dev proxy. */
export function proxyWmsTileUrl(tileUrl: string): string {
  const encodedUrl = encodeURIComponent(tileUrl).replaceAll(
    "%7Bbbox-epsg-3857%7D",
    "{bbox-epsg-3857}",
  );
  return `${WMS_PROXY_PATH}?url=${encodedUrl}`;
}

/**
 * The tile templates a renderer should request for a raster layer: WMS tiles
 * are proxied while the dev server hosts the app, everything else is returned
 * untouched. `dev` is injectable so the rewrite is testable outside Vite.
 */
export function proxyWmsTiles(
  layerType: string,
  tiles: string[],
  dev: boolean = isViteDevServer(),
): string[] {
  if (layerType !== "wms" || !dev) return tiles;
  return tiles.map((tile) => (/^https?:\/\//i.test(tile) ? proxyWmsTileUrl(tile) : tile));
}
