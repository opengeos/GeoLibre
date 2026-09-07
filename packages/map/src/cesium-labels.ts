import { compileFeatureExpression, DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { Cartesian3, CesiumWidget, DistanceDisplayCondition, Entity } from "@cesium/engine";
import { zoomToDisplayDistance } from "./cesium-camera";

/** Apply label graphics after Cesium has split multipart features into entities. */
export function createCesiumLabeler(
  C: typeof import("@cesium/engine"),
  viewer: CesiumWidget,
  layer: GeoLibreLayer,
): (entity: Entity, index: number) => void {
  const labels = { ...DEFAULT_LAYER_STYLE.labels, ...layer.style?.labels };
  if (!labels.enabled) return () => {};
  const expression = compileFeatureExpression(labels.expression);
  return (entity, index) => {
    const feature = layer.geojson?.features[index];
    if (!feature) return;
    let value: unknown = feature.properties?.[labels.field];
    if (expression.evaluate) {
      try {
        value = expression.evaluate(feature);
      } catch {
        value = undefined;
      }
    }
    if (value === undefined || value === null || value === "") return;
    let text = String(value);
    if (labels.transform === "uppercase") text = text.toUpperCase();
    if (labels.transform === "lowercase") text = text.toLowerCase();
    const time = viewer.clock.currentTime;
    let position = entity.position?.getValue(time);
    if (!position && entity.polygon) {
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
    const minZoom = Math.max(labels.minZoom, layer.style?.minZoom ?? 0);
    const maxZoom = Math.min(labels.maxZoom, layer.style?.maxZoom ?? 24);
    if (minZoom >= maxZoom) return;
    entity.label = new C.LabelGraphics({
      text,
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
      // the next style-triggered rebuild.
      distanceDisplayCondition: new C.CallbackProperty(
        (_time, result?: DistanceDisplayCondition) => {
          const condition = result ?? new C.DistanceDisplayCondition();
          condition.near = maxZoom >= 24 ? 0 : zoomToDisplayDistance(C, viewer, maxZoom, latitude);
          condition.far =
            minZoom <= 0
              ? Number.POSITIVE_INFINITY
              : zoomToDisplayDistance(C, viewer, minZoom, latitude);
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
