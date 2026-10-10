import {
  compileFeatureExpression,
  DEFAULT_LAYER_STYLE,
  formatLabelNumber,
  type GeoLibreLayer,
  documentLocale,
} from "@geolibre/core";
import type { Feature } from "geojson";
import type { Cartesian3, Color, DistanceDisplayCondition } from "@cesium/core";
import type { CesiumWidget, Entity } from "@cesium/engine";
import { readMapViewFromCamera, zoomToDisplayDistance } from "./cesium-camera";
import { horizonDepthDistance } from "./cesium-horizon";

/**
 * A label's colours before the layer opacity, and the opacity override that
 * replaces the layer opacity for it, if any. The in-place restyle (an opacity
 * drag, a story fade) rescales these rather than repainting every label in
 * the layer's one label colour, which would discard per-feature overrides.
 */
export interface LabelBaseColors {
  fill: Color;
  outline: Color;
  /** A data-defined opacity, which replaces the layer opacity as on the 2D map. */
  opacity?: number;
}

/** {@link LabelBaseColors} for each labelled entity. */
export const labelBaseColors = new WeakMap<Entity, LabelBaseColors>();

/** The average glyph advance in ems, for wrapping where no canvas can measure. */
const FALLBACK_CHAR_EMS = 0.6;

/**
 * Wrap label text the way MapLibre's `text-max-width` does: break at spaces
 * so no line runs past `maxWidth` ems, keeping a single long word whole.
 * Explicit line breaks are kept.
 *
 * @param text - The label text.
 * @param maxWidth - The maximum line width in ems.
 * @param measure - The width of a string in ems.
 * @returns The text with line breaks inserted.
 */
export function wrapLabelText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string {
  if (!(maxWidth > 0)) return text;
  return text
    .split("\n")
    .map((paragraph) => {
      const lines: string[] = [];
      let line = "";
      for (const word of paragraph.split(/ +/)) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && measure(candidate) > maxWidth) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      if (line) lines.push(line);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * A text measurer in ems for one font size: a 2D canvas where there is one,
 * else an average glyph advance.
 */
function emMeasurer(size: number): (value: string) => number {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = globalThis.document?.createElement("canvas").getContext("2d") ?? null;
  } catch {
    context = null;
  }
  if (!context || typeof context.measureText !== "function")
    return (value) => value.length * FALLBACK_CHAR_EMS;
  context.font = `${size}px sans-serif`;
  return (value) => context.measureText(value).width / size;
}

/** A compiled data-defined label override, or null when unset or invalid. */
function labelOverride(source: string, expectedType: "number" | "color" | "boolean") {
  const compiled = compileFeatureExpression(source, { expectedType });
  return compiled.ok && compiled.evaluate ? compiled.evaluate : null;
}

/** An override's value for a feature, or undefined when it throws. */
function evaluateOverride(
  evaluate: ((feature: Feature, zoom?: number) => unknown) | null,
  feature: Feature,
  zoom: number,
): unknown {
  if (!evaluate) return undefined;
  try {
    return evaluate(feature, zoom);
  } catch {
    return undefined;
  }
}

/** A style-spec colour value (a `Color` object or a CSS string) as CSS. */
function cssColor(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "r" in value) {
    const { r, g, b, a } = value as { r: number; g: number; b: number; a: number };
    // The style-spec Color holds premultiplied channels.
    const un = (channel: number) => Math.round(a > 0 ? (channel / a) * 255 : 0);
    return `rgba(${un(r)},${un(g)},${un(b)},${a})`;
  }
  return undefined;
}

/**
 * Cesium's origins for a MapLibre `text-anchor`: the side of the text that
 * sits on the point (`"top"` puts the text below it).
 */
function anchorOrigins(C: typeof import("@cesium/engine"), anchor: string) {
  return {
    horizontalOrigin: anchor.includes("left")
      ? C.HorizontalOrigin.LEFT
      : anchor.includes("right")
        ? C.HorizontalOrigin.RIGHT
        : C.HorizontalOrigin.CENTER,
    verticalOrigin: anchor.includes("top")
      ? C.VerticalOrigin.TOP
      : anchor.includes("bottom")
        ? C.VerticalOrigin.BOTTOM
        : C.VerticalOrigin.CENTER,
  };
}

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
  // The 2D map's data-defined overrides (gl-style-compiler), evaluated per
  // feature when its label is built. An invalid one falls back to the control.
  const sizeOverride = labelOverride(labels.sizeExpression, "number");
  const colorOverride = labelOverride(labels.colorExpression, "color");
  const opacityOverride = labelOverride(labels.opacityExpression, "number");
  const visibilityOverride = labelOverride(labels.visibilityExpression, "boolean");
  const measurers = new Map<number, (value: string) => number>();
  const wrap = (text: string, size: number) => {
    let measure = measurers.get(size);
    if (!measure) measurers.set(size, (measure = emMeasurer(size)));
    return wrapLabelText(text, Math.max(1, labels.maxWidth), measure);
  };
  const horizon = horizonDepthDistance(C, viewer);
  const origins = anchorOrigins(C, labels.placement === "line" ? "center" : labels.anchor);
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
    const zoomNow = zoomDependent ? currentZoom() : 0;
    if (evaluateOverride(visibilityOverride, feature, zoomNow) === false) return;
    const text = readText(feature, zoomNow);
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
    const sizeValue = evaluateOverride(sizeOverride, feature, zoomNow);
    const size =
      typeof sizeValue === "number" && Number.isFinite(sizeValue) && sizeValue > 0
        ? sizeValue
        : Math.max(1, labels.size);
    const opacityValue = evaluateOverride(opacityOverride, feature, zoomNow);
    const fixedOpacity =
      typeof opacityValue === "number" && Number.isFinite(opacityValue)
        ? Math.max(0, Math.min(1, opacityValue))
        : undefined;
    const fillCss = cssColor(evaluateOverride(colorOverride, feature, zoomNow)) ?? labels.color;
    let fill: Color;
    try {
      fill = C.Color.fromCssColorString(fillCss) ?? C.Color.fromCssColorString(labels.color);
    } catch {
      fill = C.Color.fromCssColorString(labels.color);
    }
    const outline = C.Color.fromCssColorString(labels.haloColor);
    const base: LabelBaseColors = { fill, outline, opacity: fixedOpacity };
    labelBaseColors.set(entity, base);
    const alpha = fixedOpacity ?? layer.opacity ?? 1;
    let near = 0;
    let far = Number.POSITIVE_INFINITY;
    entity.label = new C.LabelGraphics({
      text: zoomDependent
        ? new C.CallbackProperty(() => {
            const zoom = currentZoom();
            if (zoom !== lastZoom) {
              lastZoom = zoom;
              lastText = wrap(readText(feature, zoom), size);
            }
            return lastText;
          }, false)
        : wrap(text, size),
      font: `${size}px sans-serif`,
      fillColor: fill.withAlpha(fill.alpha * alpha),
      outlineColor: outline.withAlpha(outline.alpha * alpha),
      outlineWidth: labels.haloWidth,
      style: C.LabelStyle.FILL_AND_OUTLINE,
      ...origins,
      pixelOffset: new C.Cartesian2(labels.offsetX * size, labels.offsetY * size),
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
      // Over terrain on the near side, hidden by the Earth on the far side.
      disableDepthTestDistance: horizon.property,
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
