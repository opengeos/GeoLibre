/**
 * Helpers for treating a remote PMTiles archive URL as a styled basemap.
 *
 * The basemap pickers (New Project and Change Basemap) accept a custom URL. A
 * `.pmtiles` archive isn't a MapLibre style.json, so entering one lets the user
 * pick a Protomaps flavor; we then generate an inline Protomaps style pointing
 * at that archive and register it as an offline-basemap sentinel (the same
 * mechanism the extract panel uses). The archive is fetched directly over HTTP
 * range requests by the pmtiles protocol — nothing is downloaded up front.
 */
import {
  buildProtomapsBasemapStyle,
  ensureRemotePMTilesArchive,
  registerOfflineBasemapStyle,
  type ProtomapsFlavor,
} from "@geolibre/map";

/** True when `url` points at a PMTiles archive (a `.pmtiles` HTTP(S) URL or a
 * `pmtiles://…` URL), i.e. something to style rather than load as a style.json. */
export function isPmtilesStyleUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("pmtiles://")) return true;
  try {
    return /\.pmtiles$/i.test(new URL(trimmed).pathname);
  } catch {
    return false;
  }
}

/**
 * Builds and registers a Protomaps basemap style for a remote PMTiles URL and
 * returns the sentinel URL to set as the basemap style (`setBasemapStyleUrl`).
 */
export function buildRemotePmtilesBasemap(
  url: string,
  flavor: ProtomapsFlavor,
): string {
  const sourceUrl = url.trim();
  // Register the pmtiles:// protocol + a FetchSource for this archive so the
  // style's `pmtiles://<url>` source can fetch tiles (a raw basemap style never
  // hits the layer-sync path that would otherwise register the protocol).
  ensureRemotePMTilesArchive(sourceUrl);
  const style = buildProtomapsBasemapStyle({
    sourceUrl,
    flavor,
    // Resolve bundled glyphs/sprites against the deployment base so labels/icons
    // survive a sub-path deployment (GEOLIBRE_APP_BASE) — a bare
    // "/basemaps-assets" would 404. Mirrors BasemapExtractPanel's BASEMAP_ASSETS_BASE.
    assetsBaseUrl: `${import.meta.env.BASE_URL}basemaps-assets`,
  });
  // The percent-encoded URL is the registry id: the same URL reuses one entry
  // (a flavor change replaces it) and distinct URLs never collide — a fixed-
  // width hash could, silently evicting one basemap when another is applied.
  return registerOfflineBasemapStyle(
    `remote-pmtiles-${encodeURIComponent(sourceUrl)}`,
    style,
  );
}
