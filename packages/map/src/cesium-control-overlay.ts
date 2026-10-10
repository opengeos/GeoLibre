import type { Cartesian3 } from "@cesium/core";
import type { CustomDataSource, Entity } from "@cesium/engine";
import type { Geometry, Position } from "geojson";
import type { OverlayGraphic } from "./shadow-overlay";

/** The Cesium module namespace, injected so this file never imports the engine. */
type CesiumNs = typeof import("@cesium/engine");

type Rgba = [number, number, number, number];

/** A 0-255 RGB, 0-1 alpha colour as the overlay symbols carry it. */
function toColor(C: CesiumNs, value: unknown) {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [r, g, b, a] = value as Rgba;
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return new C.Color(r / 255, g / 255, b / 255, a);
}

/** A symbol size (`"3px"` or a number) in pixels. */
function pixels(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positions(C: CesiumNs, ring: Position[]) {
  return ring.map(([lng, lat]) => C.Cartesian3.fromDegrees(lng, lat));
}

/** A geometry's lines: a line's own paths, a polygon's rings. */
function paths(geometry: Geometry): Position[][] {
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates;
    case "MultiPolygon":
      return geometry.coordinates.flat();
    default:
      return [];
  }
}

function polygons(geometry: Geometry): Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function points(geometry: Geometry): Position[] {
  if (geometry.type === "Point") return [geometry.coordinates];
  if (geometry.type === "MultiPoint") return geometry.coordinates;
  return [];
}

/**
 * Whether a surface position faces the camera: on a 3D globe, a point whose
 * outward normal points away from the eye is past the horizon. Points and
 * labels draw through terrain (`disableDepthTestDistance`), which would
 * otherwise draw that far side through the Earth too. Approximates the
 * ellipsoid by its geocentric normal, which is within a fraction of a degree
 * of the horizon; flat scene modes show everything.
 */
export type FacingTest = (position: Cartesian3) => boolean;

/**
 * The {@link FacingTest} for a widget's live camera.
 *
 * @param C - The Cesium namespace.
 * @param scene - The scene whose camera and mode decide visibility.
 */
export function cameraFacingTest(
  C: CesiumNs,
  scene: { mode: unknown; camera: { positionWC: Cartesian3 } },
): FacingTest {
  const toEye = new C.Cartesian3();
  return (position) => {
    if (scene.mode !== C.SceneMode.SCENE3D) return true;
    C.Cartesian3.subtract(scene.camera.positionWC, position, toEye);
    return C.Cartesian3.dot(position, toEye) >= 0;
  };
}

/**
 * Draw a plugin control's overlay graphics (see `shadowOverlayGraphics`) into
 * a host-owned data source on the globe, replacing what it held.
 *
 * Every graphic is clamped to the ground, as the 2D map draws it: fills as
 * ground polygons, lines (and a fill's outline, which Cesium will not draw on
 * a terrain-clamped polygon) as rhumb-line ground polylines, circles as clamped points
 * that stay visible through terrain, and text as clamped labels. A degenerate
 * ring or path is skipped rather than handed to Cesium, which throws on it
 * mid-frame.
 *
 * @param C - The Cesium namespace.
 * @param source - The data source the overlay owns; its entities are replaced.
 * @param graphics - The graphics, bottom to top.
 * @param facing - Hides points and labels past the globe's horizon; every
 *   one shows without it.
 */
export function drawCesiumOverlayGraphics(
  C: CesiumNs,
  source: CustomDataSource,
  graphics: readonly OverlayGraphic[],
  facing?: FacingTest,
): void {
  const { entities } = source;
  const shown = (position: Cartesian3) =>
    facing ? new C.CallbackProperty(() => facing(position), false) : true;
  entities.suspendEvents();
  try {
    entities.removeAll();
    const add = (graphic: OverlayGraphic, options: Entity.ConstructorOptions) =>
      entities.add({
        ...options,
        properties: { layerId: graphic.layerId, featureId: graphic.featureId },
      });
    const line = (
      graphic: OverlayGraphic,
      path: Position[],
      color: InstanceType<CesiumNs["Color"]>,
      width: number,
      dashed: boolean,
    ) => {
      if (path.length < 2) return;
      add(graphic, {
        polyline: {
          positions: positions(C, path),
          width,
          clampToGround: true,
          // A MapLibre line is straight between vertices in Mercator, which is
          // a rhumb line; Cesium's default geodesic bows a sparse parallel off
          // its latitude, and a ground polyline spanning the globe that way
          // (a graticule parallel from -180 to 180) does not draw at all.
          arcType: C.ArcType.RHUMB,
          material: dashed
            ? new C.PolylineDashMaterialProperty({ color })
            : new C.ColorMaterialProperty(color),
        },
      });
    };
    for (const graphic of graphics) {
      const symbol = graphic.symbol;
      switch (symbol.type) {
        case "simple-fill": {
          const fill = toColor(C, symbol.color);
          if (fill && fill.alpha > 0) {
            for (const [outer, ...holes] of polygons(graphic.geometry)) {
              if (!outer || outer.length < 4) continue;
              add(graphic, {
                polygon: {
                  hierarchy: new C.PolygonHierarchy(
                    positions(C, outer),
                    holes
                      .filter((hole) => hole.length >= 4)
                      .map((hole) => new C.PolygonHierarchy(positions(C, hole))),
                  ),
                  material: new C.ColorMaterialProperty(fill),
                  // Edges straight in Mercator, as the outline above them.
                  arcType: C.ArcType.RHUMB,
                  classificationType: C.ClassificationType.TERRAIN,
                },
              });
            }
          }
          const outline = symbol.outline as { color?: unknown; width?: unknown } | undefined;
          const stroke = toColor(C, outline?.color);
          if (stroke && stroke.alpha > 0)
            for (const ring of paths(graphic.geometry))
              line(graphic, ring, stroke, pixels(outline?.width, 1), false);
          break;
        }
        case "simple-line": {
          const color = toColor(C, symbol.color);
          if (!color) break;
          for (const path of paths(graphic.geometry))
            line(graphic, path, color, pixels(symbol.width, 1), symbol.style === "dash");
          break;
        }
        case "simple-marker": {
          const color = toColor(C, symbol.color) ?? C.Color.TRANSPARENT;
          const outline = symbol.outline as { color?: unknown; width?: unknown } | undefined;
          const stroke = toColor(C, outline?.color) ?? C.Color.TRANSPARENT;
          for (const [lng, lat] of points(graphic.geometry)) {
            const position = C.Cartesian3.fromDegrees(lng, lat);
            add(graphic, {
              position,
              point: {
                show: shown(position),
                pixelSize: pixels(symbol.size, 10),
                color,
                outlineColor: stroke,
                outlineWidth: pixels(outline?.width, 0),
                heightReference: C.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
          }
          break;
        }
        case "text": {
          const text = typeof symbol.text === "string" ? symbol.text : "";
          if (!text) break;
          const font = symbol.font as { size?: unknown } | undefined;
          const halo = toColor(C, symbol.haloColor);
          const haloSize = pixels(symbol.haloSize, 0);
          for (const [lng, lat] of points(graphic.geometry)) {
            const position = C.Cartesian3.fromDegrees(lng, lat);
            add(graphic, {
              position,
              label: {
                show: shown(position),
                text,
                horizontalOrigin:
                  symbol.horizontalAlignment === "left"
                    ? C.HorizontalOrigin.LEFT
                    : symbol.horizontalAlignment === "right"
                      ? C.HorizontalOrigin.RIGHT
                      : C.HorizontalOrigin.CENTER,
                verticalOrigin:
                  symbol.verticalAlignment === "top"
                    ? C.VerticalOrigin.TOP
                    : symbol.verticalAlignment === "bottom"
                      ? C.VerticalOrigin.BOTTOM
                      : C.VerticalOrigin.CENTER,
                pixelOffset: new C.Cartesian2(
                  pixels(symbol.xoffset, 0),
                  -pixels(symbol.yoffset, 0),
                ),
                font: `${pixels(font?.size, 16)}px sans-serif`,
                fillColor: toColor(C, symbol.color) ?? C.Color.BLACK,
                outlineColor: halo ?? C.Color.TRANSPARENT,
                // The halo width as is, as the globe's store-layer labels
                // take it (cesium-labels.ts): doubling it to match MapLibre's
                // outward-only halo smears small text.
                outlineWidth: halo && haloSize > 0 ? haloSize : 0,
                style: halo && haloSize > 0 ? C.LabelStyle.FILL_AND_OUTLINE : C.LabelStyle.FILL,
                heightReference: C.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
          }
          break;
        }
      }
    }
  } finally {
    entities.resumeEvents();
  }
}
