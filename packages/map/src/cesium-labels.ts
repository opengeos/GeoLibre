import { compileFeatureExpression, DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { CesiumWidget, DistanceDisplayCondition, Entity } from "@cesium/engine";
import { cameraFovy, canvasHeight, zoomToRange } from "./cesium-camera";

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
        let length = 0;
        for (let i = 1; i < vertices.length; i++)
          length += C.Cartesian3.distance(vertices[i - 1], vertices[i]);
        let remaining = length / 2;
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
      // depends on the canvas height, so evaluate them per frame rather than
      // baking in the size at load time: a pane resize would otherwise leave the
      // label switching at the wrong zoom until the next style-triggered rebuild.
      distanceDisplayCondition: new C.CallbackProperty(
        (_time, result?: DistanceDisplayCondition) => {
          const height = canvasHeight(viewer);
          const fovy = cameraFovy(viewer);
          const condition = result ?? new C.DistanceDisplayCondition();
          condition.near = maxZoom >= 24 ? 0 : zoomToRange(maxZoom, latitude, height, fovy);
          condition.far =
            minZoom <= 0 ? Number.POSITIVE_INFINITY : zoomToRange(minZoom, latitude, height, fovy);
          return condition;
        },
        false,
      ),
    });
  };
}
