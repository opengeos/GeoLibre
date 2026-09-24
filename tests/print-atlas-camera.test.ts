import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import type { MapEngine, MapViewState } from "@geolibre/map";
import {
  atlasCamera,
  fitCamera,
  paintAtlasMask,
} from "../apps/geolibre-desktop/src/lib/print-atlas-camera";

// The atlas drives the camera of any flat map. Off a Style Spec engine it
// frames a page itself (MapLibre's fitBounds arithmetic) and paints the mask
// onto the capture, which is what these tests cover.

const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

describe("fitCamera", () => {
  it("frames a box the way MapLibre's fitBounds does", () => {
    // The whole world across 512 px is zoom 0.
    const world = fitCamera([-180, -85.0511, 180, 85.0511], 512, 512, NO_PADDING);
    assert.ok(Math.abs(world.zoom) < 1e-6);
    assert.ok(Math.abs(world.center[0]) < 1e-9 && Math.abs(world.center[1]) < 1e-6);
    // A quarter of the world's width across 512 px is zoom 2, whichever axis
    // is tighter deciding.
    const quarter = fitCamera([0, -1, 90, 1], 512, 512, NO_PADDING);
    assert.ok(Math.abs(quarter.zoom - 2) < 1e-6, String(quarter.zoom));
    assert.ok(Math.abs(quarter.center[0] - 45) < 1e-9);
  });
  it("fits inside the padding and centres the box in the padded frame", () => {
    const padded = fitCamera([0, -1, 90, 1], 1024, 512, { top: 0, right: 0, bottom: 0, left: 512 });
    assert.ok(Math.abs(padded.zoom - 2) < 1e-6);
    // The box sits in the right half, so the camera looks 256 px to its west.
    const worldSize = 512 * 2 ** padded.zoom;
    assert.ok(Math.abs(padded.center[0] - (45 - (256 / worldSize) * 360)) < 1e-6);
  });
  it("keeps the centre on the world when the padding shifts it past 180 west", () => {
    // A box by the antimeridian with a wide left margin: the camera looks
    // west of -180 degrees, which wraps to the east.
    const west = fitCamera([-179, -1, -175, 1], 512, 512, {
      top: 0,
      right: 0,
      bottom: 0,
      left: 400,
    });
    assert.ok(west.center[0] > 170 && west.center[0] <= 180, String(west.center[0]));
  });
  it("frames a point page at the deepest zoom", () => {
    assert.equal(fitCamera([5, 5, 5, 5], 800, 600, NO_PADDING).zoom, 22);
  });
});

describe("paintAtlasMask", () => {
  it("fills everything outside the feature's rings, even-odd", () => {
    const calls: string[] = [];
    const context = {
      canvas: { width: 200, height: 100 },
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      beginPath: () => calls.push("begin"),
      rect: (...args: number[]) => calls.push(`rect ${args.join(",")}`),
      moveTo: (x: number, y: number) => calls.push(`move ${x},${y}`),
      lineTo: (x: number, y: number) => calls.push(`line ${x},${y}`),
      closePath: () => calls.push("close"),
      fill: (rule: string) => calls.push(`fill ${rule}`),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const square: Feature = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 0],
          ],
        ],
      },
    };
    // One degree is one CSS pixel; the capture is at 2x.
    paintAtlasMask(context, square, ([x, y]) => ({ x, y }), 2);
    assert.deepEqual(calls, [
      "save",
      "begin",
      "rect 0,0,200,100",
      "move 0,0",
      "line 20,0",
      "line 20,20",
      "line 0,0",
      "close",
      "fill evenodd",
      "restore",
    ]);
    assert.equal(context.fillStyle, "rgba(255, 255, 255, 0.7)");
  });
});

describe("atlasCamera", () => {
  const engine = (flatProjection: boolean, projection: "mercator" | "globe" = "mercator") => {
    const views: MapViewState[] = [];
    const canvas = { clientWidth: 800, clientHeight: 600, width: 1600, height: 1200 };
    const surface = {
      getCanvas: () => canvas,
      getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
      project: ([lng, lat]: [number, number]) => ({ x: lng, y: lat }),
      unproject: ([x, y]: [number, number]) => (x < 0 ? null : { lng: x, lat: y }),
    };
    const fake = {
      kind: "arcgis",
      capabilities: { flatProjection },
      readProjection: () => projection,
      getMap: () => null,
      getRenderSurface: () => surface,
      applyView: async (view: MapViewState) => {
        views.push(view);
      },
      readView: () => views.at(-1) ?? { center: [0, 0], zoom: 3, bearing: 0, pitch: 0 },
      whenDrawn: async () => {},
      getViewBounds: () => [1, 2, 3, 4],
    } as unknown as MapEngine;
    return { fake, views };
  };
  it("is unavailable without a flat map", () => {
    assert.equal(atlasCamera(engine(false).fake), null);
    assert.equal(atlasCamera(null), null);
    // An engine that can draw flat but shows a globe (the ArcGIS SceneView).
    assert.equal(atlasCamera(engine(true, "globe").fake), null);
  });
  it("drives another engine's camera north up and masks only the capture", async () => {
    const { fake, views } = engine(true);
    const camera = atlasCamera(fake)!;
    assert.equal(camera.pixelRatio, 2);
    assert.equal(camera.containMap, false);
    await camera.fit([0, -1, 90, 1], NO_PADDING);
    assert.equal(views.at(-1)?.bearing, 0);
    assert.equal(views.at(-1)?.pitch, 0);
    await camera.setZoom(5);
    assert.equal(camera.zoom(), 5);
    assert.equal(camera.unproject(-1, 0), null);
    assert.deepEqual(camera.bounds(), [1, 2, 3, 4]);
    // Only a polygon page is masked.
    let filled = 0;
    const context = {
      canvas: { width: 1, height: 1 },
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill: () => filled++,
    } as unknown as CanvasRenderingContext2D;
    camera.showMask({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [0, 0] },
    });
    camera.decorate?.(context, 1);
    assert.equal(filled, 0);
    camera.showMask({
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
    });
    camera.decorate?.(context, 1);
    assert.equal(filled, 1);
  });
});
