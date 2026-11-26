import {
  compileFeatureExpression,
  extrusionBaseValue,
  extrusionColorValue,
  extrusionFloorHeightValue,
  type LayerStyle,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import { isSlicedPolarGeometry, slicePoleWrappingPolygons } from "./cesium-polar-polygons";
import type { Color } from "@cesium/core";
import type { CesiumWidget, DataSource, Entity } from "@cesium/engine";

type CesiumNs = typeof import("@cesium/engine");

// --- GeoJSON entities -------------------------------------------------------
// The per-entity passes behind CesiumLayerSync.createGeoJson.

/**
 * The private property that carries a feature's index onto its entities.
 * Cesium splits multipart geometries into several entities. A private
 * property survives that split; feature ids alone do not (Cesium suffixes them).
 */
export const FEATURE_INDEX_KEY = "__geolibre_cesium_feature_index";

/**
 * A copy of `collection` without the legacy GeoJSON 2008 `crs` member.
 *
 * Layer GeoJSON is always longitude/latitude WGS 84 (the 2D engines draw it
 * as such and ignore `crs`), but files often keep the member their writer
 * added. Cesium's GeoJsonDataSource only knows three spellings of it and
 * throws "Unknown crs name" on the rest, so a layer naming
 * `urn:ogc:def:crs:OGC::CRS84` (GDAL's spelling) failed to load on the globe
 * (#3476). Dropping it makes Cesium read the coordinates as lon/lat, exactly
 * as the 2D map does.
 *
 * @param collection - The layer's FeatureCollection.
 * @returns The collection itself when it has no `crs`, else a shallow copy without it.
 */
export function withoutGeoJsonCrs(collection: FeatureCollection): FeatureCollection {
  if (!("crs" in collection)) return collection;
  const copy: FeatureCollection & { crs?: unknown } = { ...collection };
  delete copy.crs;
  return copy;
}

/**
 * A copy of `collection` whose features carry a stable id and their index
 * (under {@link FEATURE_INDEX_KEY}), so each entity maps back to its feature.
 * The legacy `crs` member is dropped (see {@link withoutGeoJsonCrs}), and a
 * polygon that goes round a pole is cut into slices Cesium can triangulate
 * (see {@link slicePoleWrappingPolygons}).
 */
export function indexedFeatureCollection(
  layerId: string,
  collection: FeatureCollection,
): FeatureCollection {
  return {
    ...withoutGeoJsonCrs(collection),
    features: collection.features.map((feature, index) => ({
      ...slicePoleWrappingPolygons(feature),
      id: JSON.stringify([layerId, index]),
      properties: { ...feature.properties, [FEATURE_INDEX_KEY]: index },
    })),
  };
}

/**
 * Turn off the outline of every polygon entity cut from a pole-wrapping
 * polygon. Each slice is its own polygon, so its outline would also trace the
 * cut meridians from the coast to the pole, lines that are not in the data.
 * (A ground-clamped polygon has no outline anyway; this matters for extruded
 * or Z-carrying layers.)
 *
 * @param viewer The globe, for reading entity properties.
 * @param dataSource The loaded data source.
 * @param loaded The collection handed to Cesium (see {@link indexedFeatureCollection}).
 */
export function hideSlicedPolygonOutlines(
  viewer: CesiumWidget,
  dataSource: DataSource,
  loaded: FeatureCollection,
): void {
  const sliced = new Set<number>();
  loaded.features.forEach((feature, index) => {
    // Only real slices: a polygon merely pulled off the pole keeps its outline.
    if (isSlicedPolarGeometry(feature.geometry)) sliced.add(index);
  });
  if (sliced.size === 0) return;
  for (const entity of dataSource.entities.values) {
    if (!entity.polygon || !sliced.has(entityFeatureIndex(viewer, entity))) continue;
    entity.polygon.outline = false as never;
  }
}

/** The feature index an entity carries (see {@link indexedFeatureCollection}). */
export function entityFeatureIndex(viewer: CesiumWidget, entity: Entity): number {
  const propIndex = entity.properties?.[FEATURE_INDEX_KEY];
  return typeof propIndex?.getValue === "function"
    ? propIndex.getValue(viewer.clock?.currentTime)
    : propIndex;
}

/** How the height passes write entity graphics properties. */
interface EntityHeightWriters {
  /** `HeightReference.RELATIVE_TO_GROUND`. */
  heightRef: number;
  /** Wraps a value in a `ConstantProperty` when Cesium provides one. */
  makeProp: (v: unknown) => unknown;
  /** Wraps a colour in a `ColorMaterialProperty` when Cesium provides one. */
  makeMat: (c: unknown) => unknown;
  /** Whether a polygon keeps each vertex's own height (see below). */
  perPositionHeight: (polygon: { perPositionHeight?: unknown }) => boolean;
}

/**
 * The property writers the extrusion and 3D-elevation passes share.
 *
 * Cesium flags a polygon whose ring carries Z as perPositionHeight and then
 * ignores height/heightReference on it (with a one-time console warning),
 * keeping each vertex's own ellipsoid height. Only flat polygons take the
 * terrain-relative references.
 */
export function entityHeightWriters(Cesium: CesiumNs, viewer: CesiumWidget): EntityHeightWriters {
  const heightRef = (Cesium.HeightReference?.RELATIVE_TO_GROUND ?? 2) as number;
  const ConstantProperty = (Cesium as { ConstantProperty?: new (v: unknown) => unknown })
    .ConstantProperty;
  const ColorMaterialProperty = (
    Cesium as {
      ColorMaterialProperty?: new (c: unknown) => unknown;
    }
  ).ColorMaterialProperty;
  const makeProp = (v: unknown) => (ConstantProperty ? new ConstantProperty(v) : v);
  const makeMat = (c: unknown) =>
    ColorMaterialProperty ? new ColorMaterialProperty(c) : { color: c };
  const perPositionHeight = (polygon: { perPositionHeight?: unknown }): boolean => {
    const prop = polygon.perPositionHeight as
      | { getValue?: (time: unknown) => unknown }
      | boolean
      | undefined;
    return Boolean(
      typeof prop === "object" && typeof prop.getValue === "function"
        ? prop.getValue(viewer.clock?.currentTime)
        : prop,
    );
  };
  return { heightRef, makeProp, makeMat, perPositionHeight };
}

/** Highest Z on a polygon feature's rings (0 when none carries a height). */
function ringTopAltitude(feature: Feature | null): number {
  const geometry = feature?.geometry;
  const polygons =
    geometry?.type === "Polygon"
      ? [geometry.coordinates]
      : geometry?.type === "MultiPolygon"
        ? geometry.coordinates
        : [];
  let top = Number.NEGATIVE_INFINITY;
  for (const rings of polygons)
    for (const ring of rings)
      for (const position of ring) {
        const z = position[2];
        if (typeof z === "number" && Number.isFinite(z) && z > top) top = z;
      }
  return Number.isFinite(top) ? top : 0;
}

/**
 * The extrusion's optional per-feature height, base and colour expressions,
 * compiled once per layer; each is undefined when unset or invalid.
 */
function compileExtrusionEvaluators(
  style: LayerStyle,
  extColorVal: ReturnType<typeof extrusionColorValue>,
  baseVal: ReturnType<typeof extrusionBaseValue>,
): {
  heightEvaluator: ((f: Feature) => unknown) | undefined;
  baseEvaluator: ((f: Feature) => unknown) | undefined;
  colorEvaluator: ((f: Feature) => unknown) | undefined;
} {
  let heightEvaluator: ((f: Feature) => unknown) | undefined;
  if (style.extrusionAdvancedStyleEnabled && style.extrusionHeightExpression) {
    const res = compileFeatureExpression(style.extrusionHeightExpression, {
      expectedType: "number",
    });
    if (res.ok && res.evaluate) heightEvaluator = res.evaluate;
  }

  let colorEvaluator: ((f: Feature) => unknown) | undefined;
  let colorExprStr: string | null = null;
  if (typeof extColorVal !== "string") {
    colorExprStr = JSON.stringify(extColorVal);
  } else if (style.extrusionAdvancedStyleEnabled && style.extrusionColorExpression) {
    colorExprStr = style.extrusionColorExpression;
  }
  if (colorExprStr) {
    const res = compileFeatureExpression(colorExprStr, {
      expectedType: "color",
    });
    if (res.ok && res.evaluate) colorEvaluator = res.evaluate;
  }

  let baseEvaluator: ((f: Feature) => unknown) | undefined;
  if (Array.isArray(baseVal)) {
    const res = compileFeatureExpression(JSON.stringify(baseVal), { expectedType: "number" });
    if (res.ok && res.evaluate) baseEvaluator = res.evaluate;
  }
  return { heightEvaluator, baseEvaluator, colorEvaluator };
}

/**
 * Extrude every polygon entity: its roof height from the height expression
 * or property, its floor from the base (flat, or per feature from the base
 * property or expression), its colour from the colour expression or the flat
 * extrusion colour, faded by the extrusion opacity. As on the 2D map the
 * height is the roof's altitude, not a thickness above the base.
 */
export function applyGeoJsonExtrusion(
  Cesium: CesiumNs,
  viewer: CesiumWidget,
  dataSource: DataSource,
  style: LayerStyle,
  features: FeatureCollection["features"],
  extOpacity: number,
  writers: EntityHeightWriters,
): void {
  const { heightRef, makeProp, makeMat, perPositionHeight } = writers;
  const heightProp = style.extrusionHeightProperty?.trim() || "height";
  const heightScale = Number.isFinite(style.extrusionHeightScale)
    ? (style.extrusionHeightScale as number)
    : 1;
  const baseVal = extrusionBaseValue(style);
  // The flat base, which is also the fallback when a base expression throws
  // for a feature (as a throwing height expression falls back to the
  // property): with a base property it is the property's offset.
  const flatBaseValue = typeof baseVal === "number" ? baseVal : style.extrusionBase;
  const flatBase = Number.isFinite(flatBaseValue) ? Math.max(0, flatBaseValue as number) : 0;
  const floorHeight = extrusionFloorHeightValue(style);
  const extColorVal = extrusionColorValue(style);
  const extColorStr =
    typeof extColorVal === "string"
      ? extColorVal
      : style.extrusionColor || style.fillColor || "#3b82f6";
  const { heightEvaluator, baseEvaluator, colorEvaluator } = compileExtrusionEvaluators(
    style,
    extColorVal,
    baseVal,
  );

  // Parsed once: a full 3D-buildings layer would otherwise re-parse the
  // same CSS string per polygon. withAlpha() below returns a fresh Color.
  const baseColor = Cesium.Color.fromCssColorString(extColorStr);
  for (const entity of dataSource.entities.values) {
    if (!entity.polygon) continue;
    const index = entityFeatureIndex(viewer, entity);
    const feat = Number.isInteger(index) && features ? features[index] : null;

    const top = extrusionFeatureHeight(
      viewer,
      entity,
      feat,
      heightEvaluator,
      heightProp,
      heightScale,
    );
    const base = extrusionFeatureBase(feat, baseEvaluator, flatBase);
    // A floor height makes the roof relative to this feature's base, as
    // `extrusionHeightValue` does on the 2D map.
    const roof = floorHeight > 0 ? base + floorHeight : top;

    // Never below the base: a negative height property or expression would
    // otherwise put the roof under the floor.
    const relativeTop = Math.max(base, roof);
    // With perPositionHeight Cesium takes each vertex's own height as the
    // base (so neither a flat nor a data-driven base moves the floor of a
    // polygon with Z coordinates) but reads extrudedHeight as an absolute
    // altitude, so lift the roof by the ring's highest vertex; otherwise it
    // would extrude down to `relativeTop` metres above the ellipsoid.
    const extrudedHeight = perPositionHeight(entity.polygon)
      ? ringTopAltitude(feat) + relativeTop
      : relativeTop;

    const resolvedColor = extrusionFeatureColor(Cesium, baseColor, feat, colorEvaluator);

    entity.polygon.extrudedHeight = makeProp(extrudedHeight) as never;
    if (!perPositionHeight(entity.polygon)) {
      entity.polygon.height = makeProp(base) as never;
      entity.polygon.heightReference = makeProp(heightRef) as never;
      entity.polygon.extrudedHeightReference = makeProp(heightRef) as never;
    }
    entity.polygon.material = makeMat(resolvedColor.withAlpha(extOpacity)) as never;
  }
}

/**
 * A polygon entity's roof altitude in metres, as `extrusionHeightValue` gives
 * it on the 2D map: the height expression's value as written, else the
 * feature's height property (or, for an entity that maps to no feature, the
 * entity's own property) times `heightScale`; 0 when none is a number. An
 * expression that throws falls back to the scaled property.
 */
function extrusionFeatureHeight(
  viewer: CesiumWidget,
  entity: Entity,
  feat: Feature | null,
  heightEvaluator: ((f: Feature) => unknown) | undefined,
  heightProp: string,
  heightScale: number,
): number {
  let rawHeight: unknown;
  let scale = heightScale;
  if (feat && heightEvaluator) {
    try {
      rawHeight = heightEvaluator(feat);
      scale = 1;
    } catch {
      rawHeight = feat.properties?.[heightProp];
    }
  } else if (feat) {
    rawHeight = feat.properties?.[heightProp];
  } else {
    const prop = entity.properties?.[heightProp];
    rawHeight =
      typeof prop?.getValue === "function" ? prop.getValue(viewer.clock?.currentTime) : prop;
  }

  const num =
    typeof rawHeight === "number" && Number.isFinite(rawHeight) ? rawHeight : Number(rawHeight);
  return Number.isFinite(num) ? num * scale : 0;
}

/**
 * A polygon entity's extrusion base in metres: the per-feature base
 * expression's value (clamped to the ground, as MapLibre clamps
 * `fill-extrusion-base`), else the flat base, which is also the fallback when
 * the expression throws for this feature.
 */
function extrusionFeatureBase(
  feat: Feature | null,
  baseEvaluator: ((f: Feature) => unknown) | undefined,
  flatBase: number,
): number {
  if (!feat || !baseEvaluator) return flatBase;
  let value: number;
  try {
    value = Number(baseEvaluator(feat));
  } catch {
    return flatBase;
  }
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** A polygon entity's extrusion colour: the colour expression's, else `baseColor`. */
function extrusionFeatureColor(
  Cesium: CesiumNs,
  baseColor: Color,
  feat: Feature | null,
  colorEvaluator: ((f: Feature) => unknown) | undefined,
): Color {
  let resolvedColor = baseColor;
  if (feat && colorEvaluator) {
    try {
      const colVal = colorEvaluator(feat);
      if (typeof colVal === "string") {
        resolvedColor = Cesium.Color.fromCssColorString(colVal);
      } else if (colVal && typeof (colVal as { toString?: () => string }).toString === "function") {
        resolvedColor = Cesium.Color.fromCssColorString(
          (colVal as { toString: () => string }).toString(),
        );
      }
    } catch {
      // fallback to extColorStr
    }
  }
  return resolvedColor;
}

/**
 * Give Z-carrying (or 3D-elevated) entities their terrain-relative height
 * reference, which an unclamped load leaves unset. Extruded polygons were
 * already handled by {@link applyGeoJsonExtrusion}.
 */
export function applyElevationHeightReferences(
  dataSource: DataSource,
  style: LayerStyle,
  writers: EntityHeightWriters,
): void {
  const { heightRef, makeProp, perPositionHeight } = writers;
  for (const entity of dataSource.entities.values) {
    if (entity.polygon && !style.extrusionEnabled && !perPositionHeight(entity.polygon)) {
      entity.polygon.heightReference = makeProp(heightRef) as never;
    }
    if (entity.billboard) {
      entity.billboard.heightReference = makeProp(heightRef) as never;
    }
    if (entity.point) {
      entity.point.heightReference = makeProp(heightRef) as never;
    }
    if (entity.polyline) {
      (entity.polyline as { clampToGround?: unknown }).clampToGround = makeProp(false);
    }
  }
}
