import {
  compileFeatureExpression,
  DEFAULT_LAYER_STYLE,
  formatLabelNumber,
  type GeoLibreLayer,
  documentLocale,
} from "@geolibre/core";
import type { Feature } from "geojson";
import type { Cartesian3, CesiumWidget, DistanceDisplayCondition, Entity } from "@cesium/engine";
import { readMapViewFromCamera, zoomToDisplayDistance } from "./cesium-camera";

/** Whether a label expression reads `["zoom"]`, so its text changes with the camera. */
const ZOOM_OPERAND = /\[\s*"zoom"\s*\]/;

/**
 * Apply label graphics after Cesium has split multipart features into entities.
 *
 * `readZoom` supplies the camera's MapLibre zoom for zoom-dependent label
 * expressions; it defaults to reading the live camera and is injectable for
 * tests.
 */
export function createCesiumLabeler(
  C: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  layer: GeoLibreLayer,
  readZoom: () => number = () => readMapViewFromCamera(C, viewer).zoom,
): (entity: Entity, index: number) => void {
  const labels = { ...DEFAULT_LAYER_STYLE.labels, ...layer.style?.labels };
  if (!labels.enabled) return () => {};
  const expression = compileFeatureExpression(labels.expression);
  // MapLibre's style engine evaluates a `["zoom"]` text expression live; here
  // the text is a per-frame property instead, re-evaluated when the camera
  // pose changes. Reading the zoom picks the globe, so it is memoised on the
  // pose and shared by every label of the layer.
  const zoomDependent = Boolean(expression.evaluate) && ZOOM_OPERAND.test(labels.expression);
  // The zoom also depends on the canvas size (a pane resize changes the zoom a
  // still camera shows), so that is part of the key alongside the camera pose.
  const pose = { position: new C.Cartesian3(), direction: new C.Cartesian3(), key: "" };
  let cachedZoom = NaN;
  /** The orthographic frustum width in 2D; NaN for a perspective frustum. */
  const frustumWidth = () => {
    const frustum = viewer.camera.frustum as { left?: number; right?: number };
    return frustum.left !== undefined && frustum.right !== undefined
      ? frustum.right - frustum.left
      : NaN;
  };
  // Everything a zoom-to-distance conversion depends on besides the label's own
  // latitude, so per-label distance conditions only recompute when this changes.
  const displayKey = () => {
    const { scene, camera } = viewer;
    const fovy = (camera.frustum as { fovy?: number }).fovy ?? "";
    return `${scene.mode}|${scene.canvas.clientWidth}|${scene.canvas.clientHeight}|${fovy}|${frustumWidth()}`;
  };
  const currentZoom = () => {
    const { camera } = viewer;
    const canvas = viewer.scene.canvas;
    const width = frustumWidth();
    const key = `${width}|${canvas.clientWidth}|${canvas.clientHeight}`;
    if (
      !Number.isNaN(cachedZoom) &&
      key === pose.key &&
      C.Cartesian3.equals(camera.positionWC, pose.position) &&
      C.Cartesian3.equals(camera.directionWC, pose.direction)
    )
      return cachedZoom;
    C.Cartesian3.clone(camera.positionWC, pose.position);
    C.Cartesian3.clone(camera.directionWC, pose.direction);
    pose.key = key;
    cachedZoom = readZoom();
    return cachedZoom;
  };
  // Read per call rather than closing over one value: a UI language switch does
  // not change the layer object, so it never rebuilds the data source and this
  // labeler outlives it. Capturing would leave "Match app language" labels on
  // the previous language's separators until some unrelated change rebuilt.
  const readText = (feature: Feature, zoom: number): string => {
    const locale = documentLocale();
    let value: unknown = feature.properties?.[labels.field];
    let fromExpression = false;
    if (expression.evaluate) {
      try {
        value = expression.evaluate(feature, zoom);
        fromExpression = true;
      } catch {
        value = undefined;
      }
    }
    if (value === undefined || value === null || value === "") return "";
    // Number formatting applies to the field only, matching the 2D map: an
    // expression formats its own output.
    let text = (fromExpression ? null : formatLabelNumber(value, labels, locale)) ?? String(value);
    if (labels.transform === "uppercase") text = text.toUpperCase();
    if (labels.transform === "lowercase") text = text.toLowerCase();
    return text;
  };
  return (entity, index) => {
    const feature = layer.geojson?.features[index];
    if (!feature) return;
    const text = readText(feature, zoomDependent ? currentZoom() : 0);
    // A zoom-dependent label may be empty now and non-empty at another zoom,
    // so it keeps its entity; a static empty label has nothing to show.
    if (!text && !zoomDependent) return;
    // Decided before the anchor work below: an entity that gets no label must
    // be left exactly as it was, and the anchor gives a polygon or line a
    // `position` it would not otherwise have.
    const minZoom = Math.max(labels.minZoom, layer.style?.minZoom ?? 0);
    const maxZoom = Math.min(labels.maxZoom, layer.style?.maxZoom ?? 24);
    if (minZoom >= maxZoom) return;
    const time = viewer.clock.currentTime;
    let position = entity.position?.getValue(time);
    if (!position && entity.polygon) {
      // The bounding-sphere centre dropped onto the ellipsoid: cheap, and inside
      // any convex shape, but it can land outside a concave one (a crescent, a
      // horseshoe). A pole-of-inaccessibility anchor, as MapLibre uses, is a
      // follow-up for the label-appearance work.
      const vertices = entity.polygon.hierarchy?.getValue(time)?.positions;
      if (vertices?.length) {
        position = viewer.scene.globe.ellipsoid.scaleToGeodeticSurface(
          C.BoundingSphere.fromPoints(vertices).center,
        );
      }
    }
    if (!position && entity.polyline) {
      const vertices = entity.polyline.positions?.getValue(time);
      if (vertices?.length) {
        let remaining = polylineLength(C, vertices) / 2;
        position = vertices[0];
        for (let i = 1; i < vertices.length; i++) {
          const segment = C.Cartesian3.distance(vertices[i - 1], vertices[i]);
          if (remaining <= segment && segment > 0) {
            position = C.Cartesian3.lerp(
              vertices[i - 1],
              vertices[i],
              remaining / segment,
              new C.Cartesian3(),
            );
            break;
          }
          remaining -= segment;
        }
      }
    }
    if (!position) return;
    if (!entity.position) entity.position = new C.ConstantPositionProperty(position);
    const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(position);
    if (!cartographic) return;
    const latitude = C.Math.toDegrees(cartographic.latitude);
    let lastZoom = NaN;
    let lastText = text;
    let conditionKey = "";
    let near = 0;
    let far = Number.POSITIVE_INFINITY;
    entity.label = new C.LabelGraphics({
      text: zoomDependent
        ? new C.CallbackProperty(() => {
            const zoom = currentZoom();
            if (zoom !== lastZoom) {
              lastZoom = zoom;
              lastText = readText(feature, zoom);
            }
            return lastText;
          }, false)
        : text,
      font: `${labels.size}px sans-serif`,
      fillColor: C.Color.fromCssColorString(labels.color),
      outlineColor: C.Color.fromCssColorString(labels.haloColor),
      outlineWidth: labels.haloWidth,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new C.Cartesian2(labels.offsetX * labels.size, labels.offsetY * labels.size),
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      // Near/far are metre distances, and the distance a zoom level maps to
      // depends on the canvas size and the scene mode (2D compares against the
      // orthographic frustum, not a camera distance), so evaluate them per frame
      // rather than baking them in at load time: a pane resize or a scene-mode
      // switch would otherwise leave the label switching at the wrong zoom until
      // the next style-triggered rebuild. Memoised on `displayKey`, so a frame
      // with an unchanged view costs a string compare per label.
      distanceDisplayCondition: new C.CallbackProperty(
        (_time, result?: DistanceDisplayCondition) => {
          const key = displayKey();
          if (key !== conditionKey) {
            conditionKey = key;
            near = maxZoom >= 24 ? 0 : zoomToDisplayDistance(C, viewer, maxZoom, latitude);
            far =
              minZoom <= 0
                ? Number.POSITIVE_INFINITY
                : zoomToDisplayDistance(C, viewer, minZoom, latitude);
          }
          const condition = result ?? new C.DistanceDisplayCondition();
          condition.near = near;
          condition.far = far;
          return condition;
        },
        false,
      ),
    });
  };
}

function polylineLength(C: typeof import("@cesium/engine"), vertices: Cartesian3[]): number {
  let length = 0;
  for (let i = 1; i < vertices.length; i++)
    length += C.Cartesian3.distance(vertices[i - 1], vertices[i]);
  return length;
}

/**
 * The entity that carries a split multipart feature's single label.
 *
 * `GeoJsonDataSource` turns a MultiPolygon / MultiLineString / MultiPoint into
 * one entity per part. MapLibre labels every part too, but its collision pass
 * drops the overlapping copies; Cesium has no such pass, so an island chain
 * would repeat its name once per islet. Label the largest polygon or longest
 * line instead (the first point of a MultiPoint), which is where a reader
 * expects the name to sit.
 */
export function pickLabelPart(
  C: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  entities: Entity[],
): Entity {
  if (entities.length === 1) return entities[0];
  const time = viewer.clock.currentTime;
  let best = entities[0];
  let bestSize = -1;
  for (const entity of entities) {
    let size = 0;
    const ring = entity.polygon?.hierarchy?.getValue(time)?.positions;
    if (ring?.length) size = C.BoundingSphere.fromPoints(ring).radius;
    const line = entity.polyline?.positions?.getValue(time);
    if (line?.length) size = polylineLength(C, line);
    if (size > bestSize) {
      best = entity;
      bestSize = size;
    }
  }
  return best;
}
