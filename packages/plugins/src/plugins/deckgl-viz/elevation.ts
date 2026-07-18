import {
  type GeoLibreLayer,
  geojsonHasZCoordinates,
  styleValue,
  transformGeojsonElevation,
} from "@geolibre/core";
import type { Layer } from "@deck.gl/core";
import type { Feature, FeatureCollection, Geometry, GeometryCollection, Position } from "geojson";
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

const DOT_ICON_SIZE = 64;
const DOT_ICON_ATLAS = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DOT_ICON_SIZE}" height="${DOT_ICON_SIZE}" viewBox="0 0 ${DOT_ICON_SIZE} ${DOT_ICON_SIZE}"><circle cx="32" cy="32" r="30" fill="white"/></svg>`,
)}`;
const DOT_ICON_MAPPING = {
  dot: {
    x: 0,
    y: 0,
    width: DOT_ICON_SIZE,
    height: DOT_ICON_SIZE,
    anchorX: DOT_ICON_SIZE / 2,
    anchorY: DOT_ICON_SIZE / 2,
    mask: true,
  },
};

interface PointDatum {
  position: [number, number, number];
}

function elevationData(
  geojson: FeatureCollection,
  verticalScale: number,
  offset: number,
): FeatureCollection {
  const cached = elevationDataCache.get(geojson);
  if (cached && cached.verticalScale === verticalScale && cached.offset === offset) {
    return cached.data;
  }
  const data = transformGeojsonElevation(geojson, verticalScale, offset);
  elevationDataCache.set(geojson, { verticalScale, offset, data });
  return data;
}

function isPointGeometry(geometry: Geometry): boolean {
  return geometry.type === "Point" || geometry.type === "MultiPoint";
}

function pointDatum(position: Position): PointDatum {
  const [lng = 0, lat = 0, z = 0] = position;
  return {
    position: [lng, lat, Number.isFinite(z) ? z : 0],
  };
}

function collectPointPositions(geometry: Geometry, points: PointDatum[]): void {
  if (geometry.type === "Point") {
    points.push(pointDatum(geometry.coordinates));
    return;
  }
  if (geometry.type === "MultiPoint") {
    for (const position of geometry.coordinates) points.push(pointDatum(position));
    return;
  }
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) collectPointPositions(child, points);
  }
}

function geometryWithoutPoints(geometry: Geometry): Geometry | null {
  if (isPointGeometry(geometry)) return null;
  if (geometry.type !== "GeometryCollection") return geometry;

  const geometries = geometry.geometries
    .map((child) => geometryWithoutPoints(child))
    .filter((child): child is Geometry => child !== null);

  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];
  return { type: "GeometryCollection", geometries } satisfies GeometryCollection;
}

function splitPointFeatures(data: FeatureCollection): {
  nonPointData: FeatureCollection;
  pointData: PointDatum[];
} {
  const pointData: PointDatum[] = [];
  const nonPointFeatures: Feature[] = [];

  for (const feature of data.features) {
    const geometry = feature.geometry;
    if (!geometry) {
      nonPointFeatures.push(feature);
      continue;
    }

    collectPointPositions(geometry, pointData);
    const nonPointGeometry = geometryWithoutPoints(geometry);
    if (nonPointGeometry) {
      nonPointFeatures.push({ ...feature, geometry: nonPointGeometry });
    }
  }

  if (pointData.length === 0) {
    return { nonPointData: data, pointData };
  }

  return {
    nonPointData: { ...data, features: nonPointFeatures },
    pointData,
  };
}

/**
 * Builds the deck.gl layers that render a Z-enabled vector layer in 3D. The
 * layer's regular symbology (fill/stroke color, stroke width, circle radius,
 * fill opacity) drives the deck styling so the Style panel keeps working, and
 * lines/points are billboarded so they stay readable from tilted 3D views.
 * Points use an IconLayer dot instead of GeoJsonLayer's ScatterplotLayer
 * sublayer because ScatterplotLayer can lose its fill at real GPS altitudes in
 * an interleaved MapboxOverlay, leaving only hollow rings.
 *
 * @param deckGL - The host's deck.gl module bundle.
 * @param layer - The store layer to render (must satisfy
 *   {@link isElevation3dLayer}).
 */
export function buildElevation3dLayers(deckGL: GeoLibreDeckGL, layer: GeoLibreLayer): Layer[] {
  const style = layer.style;
  const rawScale = styleValue(style, "elevation3dVerticalScale");
  const rawOffset = styleValue(style, "elevation3dOffset");
  const verticalScale = Number.isFinite(rawScale) ? rawScale : 1;
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const geojson = layer.geojson as FeatureCollection;
  const data = elevationData(geojson, verticalScale, offset);
  const { nonPointData, pointData } = splitPointFeatures(data);
  const fillColor = colorToRgba(styleValue(style, "fillColor"), styleValue(style, "fillOpacity"));
  const deckLayers: Layer[] = [];

  if (nonPointData.features.length > 0) {
    deckLayers.push(
      new deckGL.layers.GeoJsonLayer({
        id: layer.id,
        data: nonPointData,
        filled: true,
        stroked: true,
        extruded: false,
        getFillColor: fillColor,
        getLineColor: colorToRgba(styleValue(style, "strokeColor"), 1),
        getLineWidth: styleValue(style, "strokeWidth"),
        lineWidthUnits: styleValue(style, "strokeWidthUnit") === "meters" ? "meters" : "pixels",
        lineWidthMinPixels: 1,
        lineBillboard: true,
        opacity: layer.opacity,
        pickable: true,
      }),
    );
  }

  if (pointData.length > 0) {
    deckLayers.push(
      new deckGL.layers.IconLayer<PointDatum>({
        id: `${layer.id}-points`,
        data: pointData,
        getPosition: (datum: PointDatum) => datum.position,
        getIcon: () => "dot",
        iconAtlas: DOT_ICON_ATLAS,
        iconMapping: DOT_ICON_MAPPING,
        getSize: Math.max(1, styleValue(style, "circleRadius") * 2),
        getColor: fillColor,
        sizeUnits: "pixels",
        sizeMinPixels: 1,
        billboard: true,
        opacity: layer.opacity,
        pickable: true,
      }),
    );
  }

  return deckLayers;
}
