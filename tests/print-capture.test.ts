import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isFullViewportMapCanvas } from "../packages/map/src/capture/canvas-surfaces";
import { captureMapLibreViewport } from "../packages/map/src/capture/maplibre-capture";

describe("isFullViewportMapCanvas", () => {
  const base = { width: 1920, height: 1080 };

  it("always keeps the base canvas itself", () => {
    assert.equal(isFullViewportMapCanvas(base, base), true);
  });

  it("keeps a full-size deck.gl overlay canvas", () => {
    assert.equal(isFullViewportMapCanvas({ width: 1920, height: 1080 }, base), true);
  });

  it("keeps a canvas within the 90% size tolerance", () => {
    assert.equal(isFullViewportMapCanvas({ width: 1900, height: 1000 }, base), true);
  });

  it("keeps a canvas exactly at the 90% boundary", () => {
    // The threshold is inclusive (>=): 1920 * 0.9 = 1728, 1080 * 0.9 = 972.
    assert.equal(isFullViewportMapCanvas({ width: 1728, height: 972 }, base), true);
  });

  it("drops a canvas just below the 90% threshold in height", () => {
    // 1920 passes width; 971 < 972 (1080 * 0.9) fails height -> overall false.
    assert.equal(isFullViewportMapCanvas({ width: 1920, height: 971 }, base), false);
  });

  it("drops a small raster colorbar/colormap preview canvas", () => {
    // The raster control renders a horizontal colormap ramp into a small canvas
    // (createLinearGradient(0, 0, width, 0)); stretching it over the page was
    // the bug that filled the whole map with a rainbow gradient.
    assert.equal(isFullViewportMapCanvas({ width: 280, height: 24 }, base), false);
  });

  it("drops a canvas that is wide but short", () => {
    assert.equal(isFullViewportMapCanvas({ width: 1920, height: 24 }, base), false);
  });

  it("drops a canvas that is tall but narrow", () => {
    // 1727 < 1728 (1920 * 0.9) fails width; height passes -> overall false.
    assert.equal(isFullViewportMapCanvas({ width: 1727, height: 1080 }, base), false);
  });

  it("keeps only the base when the base size is unknown", () => {
    const unknownBase = { width: 0, height: 0 };
    // The base itself is still kept (by identity)...
    assert.equal(isFullViewportMapCanvas(unknownBase, unknownBase), true);
    // ...but other canvases are dropped, so a 0x0 base cannot reintroduce the
    // colorbar-clobbering bug.
    assert.equal(isFullViewportMapCanvas({ width: 280, height: 24 }, unknownBase), false);
  });
});

interface FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  readonly classList: { contains(name: string): boolean };
  readonly draws: unknown[][];
  readonly drawError?: Error;
  getContext(kind: "2d"): { drawImage(...args: unknown[]): void } | null;
}

function fakeCanvas(
  width: number,
  height: number,
  classNames: readonly string[] = [],
  drawError?: Error,
): FakeCanvas {
  const draws: unknown[][] = [];
  return {
    width,
    height,
    clientWidth: width / 2,
    clientHeight: height / 2,
    classList: { contains: (name) => classNames.includes(name) },
    draws,
    ...(drawError ? { drawError } : {}),
    getContext: () => ({
      drawImage: (...args: unknown[]) => {
        if ((args[0] as FakeCanvas).drawError) throw (args[0] as FakeCanvas).drawError;
        draws.push(args);
      },
    }),
  };
}

async function withFakeDocument<T>(run: (created: FakeCanvas[]) => Promise<T> | T): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const created: FakeCanvas[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, "canvas");
        const canvas = fakeCanvas(0, 0);
        created.push(canvas);
        return canvas;
      },
    },
  });
  try {
    return await run(created);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

it("viewport capture composites map surfaces and returns geographic metadata", async () => {
  await withFakeDocument((created) => {
    const base = fakeCanvas(200, 100);
    const deck = fakeCanvas(200, 100);
    const effects = fakeCanvas(200, 100, ["geolibre-effects-canvas"]);
    const colorbar = fakeCanvas(80, 20);
    const map = {
      redraw: () => undefined,
      getCanvas: () => base,
      getContainer: () => ({ querySelectorAll: () => [base, deck, effects, colorbar] }),
      project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10 }),
      unproject: ([x, y]: [number, number]) => ({ lng: x / 10, lat: y / 10 }),
      getBearing: () => 23,
    };

    const result = captureMapLibreViewport(map as never, { bounds: [1, 1, 5, 4] });

    assert.equal(result.width, 80);
    assert.equal(result.height, 60);
    assert.equal(result.bearing, 23);
    assert.ok(result.metersPerPixel > 0);
    assert.equal(created.length, 2);
    assert.deepEqual(
      created[0].draws.map((draw) => draw[0]),
      [base, deck],
    );
    assert.equal(created[1].draws.length, 1);
  });
});

it("viewport capture skips a failed optional overlay but rejects an offscreen clip", async () => {
  await withFakeDocument(() => {
    const base = fakeCanvas(200, 100);
    const brokenOverlay = fakeCanvas(200, 100, [], new Error("tainted overlay"));
    const map = {
      redraw: () => undefined,
      getCanvas: () => base,
      getContainer: () => ({ querySelectorAll: () => [base, brokenOverlay] }),
      project: ([lng, lat]: [number, number]) => ({ x: lng * 10, y: lat * 10 }),
      unproject: ([x, y]: [number, number]) => ({ lng: x / 10, lat: y / 10 }),
      getBearing: () => 0,
    };

    assert.doesNotThrow(() => captureMapLibreViewport(map as never));
    assert.throws(
      () => captureMapLibreViewport(map as never, { bounds: [50, 50, 60, 60] }),
      /outside the map viewport/,
    );
  });
});
