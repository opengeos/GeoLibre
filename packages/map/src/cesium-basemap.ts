import type { CesiumBasemapImagery } from "@geolibre/core";
import type { CesiumWidget, ImageryLayer, ImageryProvider } from "@cesium/engine";

// Draws the project basemap on the Cesium globe. `@geolibre/core`'s
// `basemapToCesiumImagery` decides *what* to show (it reads the basemap
// catalogs and stays engine-free); this module turns that decision into Cesium
// imagery layers. Splitting it out of CesiumCanvas keeps the component about
// the React/viewer lifecycle and makes the stacking rules testable against a
// fake Cesium, the way cesium-layer-sync is.
//
// The engine is injected (the `Cesium` namespace + a `CesiumWidget`) so this module
// carries only type-only Cesium imports and never pulls the engine into the
// build graph itself.

type CesiumNs = typeof import("@cesium/engine");

/** Keyless imagery for a basemap with no raster form when no Ion token is set. */
const KEYLESS_FALLBACK_URL = "https://tile.openstreetmap.org/";

/**
 * An imagery provider for one tile template. TMS row ordering is expressed by
 * swapping `{y}` for Cesium's `{reverseY}` placeholder: Cesium has no `scheme`
 * option the way MapLibre's raster source does, so the planetary mosaics (which
 * are TMS) would otherwise render with their rows flipped.
 */
function templateProvider(
  Cesium: CesiumNs,
  template: string,
  options: { attribution?: string; maximumLevel?: number; scheme?: "tms" },
): ImageryProvider {
  return new Cesium.UrlTemplateImageryProvider({
    url: options.scheme === "tms" ? template.replace("{y}", "{reverseY}") : template,
    maximumLevel: options.maximumLevel,
    // Cesium shows this in its own credit display, keeping the keyless raster
    // basemaps licence-clean the way the 2D map's attribution control does.
    credit: options.attribution,
  });
}

/**
 * Apply the project's basemap visibility and opacity to the layers drawing it.
 *
 * These are separate store fields from the style URL — the layer panel's
 * Background row hides the basemap and fades it with a slider — and the 2D map
 * honours both (`MapController` sets the style layers' visibility and scales
 * their paint opacity). A hybrid basemap's overlay fades with its imagery, which
 * matches the 2D map treating the pair as one background.
 *
 * @param layers - The basemap layers from {@link applyBasemapImagery}.
 * @param visible - The store's `basemapVisible`.
 * @param opacity - The store's `basemapOpacity`, 0–1.
 */
export function applyBasemapAppearance(
  layers: readonly ImageryLayer[],
  visible: boolean,
  opacity: number,
): void {
  for (const layer of layers) {
    layer.show = visible;
    layer.alpha = opacity;
  }
}

/**
 * Draw `imagery` at the bottom of the globe's imagery stack, replacing whatever
 * basemap is there.
 *
 * The returned layers are exactly the ones added, so the next basemap change
 * removes those and leaves the data layers `CesiumLayerSync` owns untouched.
 * Inserting at index 0 (and the hybrid overlay at 1) rather than appending is
 * what keeps the basemap below those data layers: the sync class appends and
 * raises to the top, and never touches the bottom of the stack.
 *
 * @param Cesium - The loaded Cesium namespace.
 * @param viewer - The globe to draw on.
 * @param previous - Basemap layers from the last call, removed first.
 * @param imagery - What to draw, from `basemapToCesiumImagery`.
 * @param ionToken - Ion token, when one is configured; selects the fallback
 *   imagery for a basemap with no raster form.
 * @returns The layers now drawing the basemap, to pass back as `previous`.
 */
export function applyBasemapImagery(
  Cesium: CesiumNs,
  viewer: CesiumWidget,
  previous: readonly ImageryLayer[],
  imagery: CesiumBasemapImagery,
  ionToken: string | undefined,
): ImageryLayer[] {
  for (const layer of previous) viewer.imageryLayers.remove(layer, true);

  // The blank basemap means the user wants no background at all: leave the
  // ellipsoid bare, as the 2D panes leave their canvas empty.
  if (imagery.kind === "none") return [];

  if (imagery.kind === "default") {
    // No raster equivalent for this basemap (a provider style, a custom URL).
    // Ion World Imagery when a token is configured — the globe's historical
    // default, kept so a project that relies on it is unchanged — and keyless
    // OpenStreetMap otherwise.
    const layer = ionToken
      ? Cesium.ImageryLayer.fromWorldImagery({})
      : Cesium.ImageryLayer.fromProviderAsync(
          Promise.resolve(new Cesium.OpenStreetMapImageryProvider({ url: KEYLESS_FALLBACK_URL })),
          {},
        );
    viewer.imageryLayers.add(layer, 0);
    return [layer];
  }

  const { template, attribution, maximumLevel, scheme, overlayTemplate } = imagery;
  const added = [
    viewer.imageryLayers.addImageryProvider(
      templateProvider(Cesium, template, { attribution, maximumLevel, scheme }),
      0,
    ),
  ];
  if (overlayTemplate) {
    // A hybrid basemap's roads-and-labels tiles sit directly above its imagery
    // and still below the data layers. The provider carries no credit: the
    // imagery below it already credits the same provider once.
    added.push(
      viewer.imageryLayers.addImageryProvider(
        templateProvider(Cesium, overlayTemplate, { maximumLevel, scheme }),
        1,
      ),
    );
  }
  return added;
}
