import type { GeoLibreLayer } from "@geolibre/core";

/** True when `url`'s host is `maptoolkit.org` or a subdomain of it. */
function isMaptoolkitHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "maptoolkit.org" || host.endsWith(".maptoolkit.org");
  } catch {
    // Not an absolute URL (an offline/planetary sentinel, a relative path):
    // treat as not-Maptoolkit rather than throwing inside a store selector.
    return false;
  }
}

/**
 * Whether a Maptoolkit basemap is currently active — either the whole-map style
 * is served from maptoolkit.org (their style basemaps live at
 * `styles.maptoolkit.org`), or a *visible* stacked raster basemap layer is
 * tagged with the Maptoolkit provider by the basemap control. Drives the
 * Controls → Logos gating and the auto-removal of the Maptoolkit logo when the
 * basemap changes away. Matches the host exactly (not a loose substring) and
 * ignores hidden layers, so the logo only shows while Maptoolkit tiles do.
 */
export function isMaptoolkitBasemapActive(
  basemapStyleUrl: string,
  layers: ReadonlyArray<GeoLibreLayer>,
): boolean {
  return (
    isMaptoolkitHost(basemapStyleUrl) ||
    layers.some((layer) => layer.visible && layer.metadata?.basemapProvider === "maptoolkit")
  );
}
