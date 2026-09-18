import type { Entity } from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { NativeProfileMap } from "./core/native";

/** Native profile geometry and unexaggerated samples from the active terrain. */
export function cesiumProfileMap(
  handle: CesiumSceneHandle,
  fitBounds?: (bounds: [number, number, number, number]) => void,
): NativeProfileMap {
  const { Cesium: C, viewer } = handle;
  let line: Entity | undefined;
  let hover: Entity | undefined;
  const remove = (entity: Entity | undefined) => {
    if (entity && !viewer.isDestroyed()) viewer.entities.remove(entity);
  };
  return {
    setLine(coords) {
      remove(line);
      line = undefined;
      if (coords.length < 2 || viewer.isDestroyed()) return;
      line = viewer.entities.add({
        polyline: {
          positions: C.Cartesian3.fromDegreesArray(coords.flat()),
          width: 3,
          material: C.Color.fromCssColorString("#f97316"),
          clampToGround: true,
        },
      });
      handle.requestRender();
    },
    setHover(coord) {
      remove(hover);
      hover = undefined;
      if (!coord || viewer.isDestroyed()) return;
      hover = viewer.entities.add({
        position: C.Cartesian3.fromDegrees(...coord),
        point: {
          pixelSize: 12,
          color: C.Color.RED,
          outlineColor: C.Color.WHITE,
          outlineWidth: 2,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Infinity,
        },
      });
      handle.requestRender();
    },
    clear() {
      remove(line);
      remove(hover);
      line = hover = undefined;
      if (!viewer.isDestroyed()) handle.requestRender();
    },
    async sample(coords) {
      if (viewer.isDestroyed()) throw new Error("The globe was closed.");
      const terrain = viewer.terrainProvider;
      const points = coords.map(([lng, lat]) => C.Cartographic.fromDegrees(lng, lat));
      const sampled = terrain.availability
        ? await C.sampleTerrainMostDetailed(terrain, points)
        : await C.sampleTerrain(terrain, 14, points);
      if (viewer.isDestroyed() || viewer.terrainProvider !== terrain)
        throw new Error("The terrain source changed. Draw the profile again.");
      if (sampled.some((point) => !Number.isFinite(point.height)))
        throw new Error("Terrain elevations are unavailable along this line.");
      return sampled.map((point) => point.height);
    },
    fit(coords) {
      if (!coords.length) return;
      const rectangle = C.Rectangle.fromCartographicArray(
        coords.map(([lng, lat]) => C.Cartographic.fromDegrees(lng, lat)),
      );
      const west = C.Math.toDegrees(rectangle.west),
        east = C.Math.toDegrees(rectangle.east);
      fitBounds?.([
        west,
        C.Math.toDegrees(rectangle.south),
        east < west ? east + 360 : east,
        C.Math.toDegrees(rectangle.north),
      ]);
    },
  };
}
