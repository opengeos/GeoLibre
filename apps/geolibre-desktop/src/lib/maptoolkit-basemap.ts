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
 * True when a visible, fully opaque raster basemap from a *different*
 * provider is stacked on the basemap control's own layer (metadata
 * `sourceKind: "maplibre-basemap-control"`). Raster basemaps never replace
 * the underlying style — `registerRasterBasemap` only stacks them on top of
 * whatever style is already active — so picking e.g. plain OpenStreetMap
 * raster tiles over a Maptoolkit *style* leaves `basemapStyleUrl` pointed at
 * maptoolkit.org even though its tiles are now fully hidden underneath.
 * Only an opaque cover (opacity 1) counts: a translucent overlay (hillshade,
 * traffic) stacked on top still lets the Maptoolkit style show through.
 */
function isStyleObscuredByOtherRasterBasemap(layers: ReadonlyArray<GeoLibreLayer>): boolean {
  return layers.some(
    (layer) =>
      layer.visible &&
      layer.opacity >= 1 &&
      layer.metadata?.sourceKind === "maplibre-basemap-control" &&
      layer.metadata?.basemapProvider !== "maptoolkit",
  );
}

/**
 * Whether a Maptoolkit basemap is currently active — either the whole-map style
 * is served from maptoolkit.org (their style basemaps live at
 * `styles.maptoolkit.org`) and nothing opaque from another provider is
 * stacked on top of it (see isStyleObscuredByOtherRasterBasemap), or a
 * *visible* stacked raster basemap layer is itself tagged with the Maptoolkit
 * provider by the basemap control. Drives the Controls → Logos gating and the
 * automatic show/hide of the Maptoolkit logo as the active basemap changes
 * (see TopToolbar). Matches the host exactly (not a loose substring) and
 * ignores hidden layers, so the logo only tracks the basemap, not an
 * unrelated data layer that happens to point at the same host.
 */
export function isMaptoolkitBasemapActive(
  basemapStyleUrl: string,
  layers: ReadonlyArray<GeoLibreLayer>,
): boolean {
  return (
    (isMaptoolkitHost(basemapStyleUrl) && !isStyleObscuredByOtherRasterBasemap(layers)) ||
    layers.some((layer) => layer.visible && layer.metadata?.basemapProvider === "maptoolkit")
  );
}

/** The slice of a map engine the Maptoolkit logo sync drives. */
export interface MaptoolkitLogoEngine {
  setBuiltInControlVisible(control: "maptoolkit-logo", visible: boolean): unknown;
}

/**
 * Builds a function that gives each new map engine the Maptoolkit logo state.
 *
 * A renderer swap replaces the engine, and the new one starts without the
 * logo. The logo's own sync reacts only when the Maptoolkit basemap's active
 * state flips, which a swap does not do, and re-applying it on every map
 * readiness bump would also fire on each basemap style load and clobber a
 * manual toggle. So this applies the desired state once per engine instance:
 * a fresh engine gets it, the same engine is left alone.
 *
 * @returns A function taking the live engine (or null) and the logo's desired
 *   visibility, applying it when the engine has not received it yet.
 */
export function createMaptoolkitLogoEngineSync(): (
  engine: MaptoolkitLogoEngine | null | undefined,
  visible: boolean,
) => void {
  let synced: MaptoolkitLogoEngine | null = null;
  return (engine, visible) => {
    if (!engine || engine === synced) return;
    synced = engine;
    engine.setBuiltInControlVisible("maptoolkit-logo", visible);
  };
}
