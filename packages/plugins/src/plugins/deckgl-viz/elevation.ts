import {
  type GeoLibreLayer,
  geojsonHasZCoordinates,
  styleValue,
  transformGeojsonElevation,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { FeatureCollection } from "geojson";
import type { GeoLibreDeckGL } from "../../types";
import { colorToRgba } from "../deck-style-utils";

/**
 * 3D Z-value rendering for ordinary vector (geojson) layers. When a layer's
 * style enables `elevation3dEnabled`, the map-side sync drops its flat
 * MapLibre rendering and the deck.gl overlay draws it instead, so coordinate
 * Z values (e.g. GPX track elevations) place features at their real altitude.
 */

/**
 * Whether a store layer should render through the deck.gl overlay's 3D
 * elevation path instead of MapLibre's 2D layers. Data without any real Z
 * coordinates (e.g. after a processing tool dropped them) renders 2D even if
 * the style flag is set, matching the Style panel and the map-side sync;
 * the Z scan is cached per GeoJSON object.
 *
 * @param layer - The store layer to test.
 */
export function isElevation3dLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    !!layer.geojson &&
    styleValue(layer.style, "elevation3dEnabled") === true &&
    geojsonHasZCoordinates(layer.geojson)
  );
}

// One entry per source FeatureCollection so the coordinate rescan only runs
// when the exaggeration/offset changes, not on every overlay rebuild (opacity
// toggles, other layers changing, animation frames). The transform always
// runs (even for the identity) so non-finite Z values are sanitized before
// they reach WebGL.
const elevationDataCache = new WeakMap<
  FeatureCollection,
  { verticalScale: number; offset: number; data: FeatureCollection }
>();

function elevationData(
  geojson: FeatureCollection,
  verticalScale: number,
  offset: number,
): FeatureCollection {
  const cached = elevationDataCache.get(geojson);
  if (
    cached &&
    cached.verticalScale === verticalScale &&
    cached.offset === offset
  ) {
    return cached.data;
  }
  const data = transformGeojsonElevation(geojson, verticalScale, offset);
  elevationDataCache.set(geojson, { verticalScale, offset, data });
  return data;
}

/**
 * Builds the deck.gl layer that renders a Z-enabled vector layer in 3D. The
 * layer's regular symbology (fill/stroke color, stroke width, circle radius,
 * fill opacity) drives the deck styling so the Style panel keeps working, and
 * lines/points are billboarded so they stay readable from tilted 3D views.
 *
 * @param deckGL - The host's deck.gl module bundle.
 * @param layer - The store layer to render (must satisfy
 *   {@link isElevation3dLayer}).
 */
export function buildElevation3dLayer(
  deckGL: GeoLibreDeckGL,
  layer: GeoLibreLayer,
): Layer {
  const style = layer.style;
  const rawScale = styleValue(style, "elevation3dVerticalScale");
  const rawOffset = styleValue(style, "elevation3dOffset");
  const verticalScale = Number.isFinite(rawScale) ? rawScale : 1;
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const geojson = layer.geojson as FeatureCollection;
  // GeoJsonLayer forwards getLineWidth/lineWidthUnits to the point sublayer's
  // circle outline too, but the Style panel treats point-only layers as
  // always pixel-stroked (its meters semantics only cover line/polygon
  // outlines, matching the 2D MapLibre render). Force pixels for point-only
  // data so a stale "meters" unit cannot render outlines at map scale.
  const pointOnly = geojson.features.every(
    (feature) =>
      feature.geometry?.type === "Point" ||
      feature.geometry?.type === "MultiPoint",
  );
  return new deckGL.layers.GeoJsonLayer({
    id: layer.id,
    data: elevationData(geojson, verticalScale, offset),
    filled: true,
    stroked: true,
    extruded: false,
    getFillColor: colorToRgba(
      styleValue(style, "fillColor"),
      styleValue(style, "fillOpacity"),
    ),
    getLineColor: colorToRgba(styleValue(style, "strokeColor"), 1),
    getLineWidth: styleValue(style, "strokeWidth"),
    lineWidthUnits:
      !pointOnly && styleValue(style, "strokeWidthUnit") === "meters"
        ? "meters"
        : "pixels",
    lineWidthMinPixels: 1,
    lineBillboard: true,
    getPointRadius: styleValue(style, "circleRadius"),
    pointRadiusUnits: "pixels",
    pointRadiusMinPixels: 1,
    pointBillboard: true,
    opacity: layer.opacity,
    pickable: true,
  });
}
