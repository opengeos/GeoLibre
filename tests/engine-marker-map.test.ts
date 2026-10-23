import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { engineMarkerMap } from "../apps/geolibre-desktop/src/lib/engine-style-map";
import type { MapEngine } from "@geolibre/map";

// Pixel Time Series and NetCDF sample markers pin DOM markers through
// `createAnnotationMarker`; on a renderer with no style map (ArcGIS, #2477)
// they get a stand-in over the engine's render surface.

function makeEngine() {
  const moves = new Set<() => void>();
  const idles = new Set<() => void>();
  const container = { tag: "container" };
  const engine = {
    kind: "arcgis",
    getMap: () => null,
    getRenderSurface: () => ({
      getContainer: () => container,
      project: ([lng, lat]: [number, number]) => {
        if (lng > 170) throw new Error("far side");
        return { x: lng * 2, y: lat * 2 };
      },
    }),
    onCameraMove: (listener: () => void) => {
      moves.add(listener);
      return () => moves.delete(listener);
    },
    onCameraIdle: (listener: () => void) => {
      idles.add(listener);
      return () => idles.delete(listener);
    },
  } as unknown as MapEngine;
  return { engine, moves, idles, container };
}

describe("engineMarkerMap", () => {
  it("stands in for a style map over the render surface, one per engine", () => {
    const { engine, moves, idles, container } = makeEngine();
    const host = engineMarkerMap(engine)!;
    assert.equal(engineMarkerMap(engine), host);
    assert.equal(host.getCanvasContainer(), container as unknown as HTMLElement);
    assert.deepEqual(host.project([1, 2]), { x: 2, y: 4 });
    // A point the globe cannot project is parked off screen, not thrown.
    assert.deepEqual(host.project([175, 0]), { x: -1e6, y: -1e6 });
    const listener = () => {};
    host.on("move", listener);
    host.on("moveend", listener);
    assert.equal(moves.size, 1);
    assert.equal(idles.size, 1);
    host.off("move", listener);
    host.off("moveend", listener);
    assert.equal(moves.size, 0);
    assert.equal(idles.size, 0);
  });
  it("answers null without an engine or a surface", () => {
    assert.equal(engineMarkerMap(null), null);
    const bare = { kind: "arcgis", getMap: () => null, getRenderSurface: () => null };
    assert.equal(engineMarkerMap(bare as unknown as MapEngine), null);
  });
});
