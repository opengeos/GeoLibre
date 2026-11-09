import assert from "node:assert/strict";
import test from "node:test";
import {
  paintRender,
  parseRenderTileUrl,
  pickOverview,
  renderTileUrl,
  specFromTileUrl,
  stretchFor,
  withRenderStyle,
  type RenderBand,
  type RenderStyle,
  type StacRenderSpec,
} from "../packages/plugins/src/plugins/stac-render";

const band = (name: string, extra: Partial<RenderBand> = {}): RenderBand => ({
  href: `https://x.test/${name}.tif`,
  index: 1,
  scale: 1,
  offset: 0,
  ...extra,
});

const rgb: StacRenderSpec = { kind: "rgb", bands: [band("r"), band("g"), band("b")] };
const ndvi: StacRenderSpec = {
  kind: "index",
  formula: "(nir - red) / (nir + red)",
  bands: [band("nir"), band("red")],
};

const tile = (spec: StacRenderSpec) =>
  renderTileUrl(spec).replace("{z}", "10").replace("{x}", "3").replace("{y}", "4");

test("a rendering's tile URL round-trips through the parser", () => {
  for (const spec of [rgb, ndvi]) {
    assert.deepEqual(parseRenderTileUrl(tile(spec)), { z: 10, x: 3, y: 4, spec });
  }
});

test("the parser refuses a recipe that is not safe to fetch or evaluate", () => {
  const url = (spec: unknown) =>
    `stacrender://tile/1/0/0?s=${encodeURIComponent(JSON.stringify(spec))}`;
  const http = { ...rgb, bands: rgb.bands.map((b) => ({ ...b, href: "http://x.test/a.tif" })) };
  assert.equal(parseRenderTileUrl(url(http)), null, "plain http");
  const file = { ...rgb, bands: rgb.bands.map((b) => ({ ...b, href: "file:///etc/passwd" })) };
  assert.equal(parseRenderTileUrl(url(file)), null, "file URL");
  assert.equal(
    parseRenderTileUrl(url({ ...rgb, bands: rgb.bands.slice(0, 2) })),
    null,
    "two bands",
  );
  assert.equal(parseRenderTileUrl(url({ ...ndvi, formula: "alert(nir)" })), null, "code");
  assert.equal(
    parseRenderTileUrl(url({ ...ndvi, formula: "nir / red / green" })),
    null,
    "band count",
  );
  assert.equal(
    parseRenderTileUrl(url({ ...rgb, bands: rgb.bands.map((b) => ({ ...b, scale: 0 })) })),
    null,
    "zero scale",
  );
  assert.equal(parseRenderTileUrl("stacrender://tile/1/0/0?s=not-json"), null);
  assert.equal(parseRenderTileUrl("https://x.test/1/0/0"), null);
});

test("stretchFor reads a scaled band as reflectance and an unscaled one by its sample size", () => {
  assert.deepEqual(stretchFor(band("a", { scale: 0.0001, offset: -0.1 }), 16), {
    low: 0,
    high: 0.3,
  });
  assert.deepEqual(stretchFor(band("a"), 8), { low: 0, high: 255 });
  assert.deepEqual(stretchFor(band("a"), 16), { low: 0, high: 3000 });
});

test("paintRender stretches colour channels and clears pixels with no data", () => {
  const stretch = { low: 0, high: 100 };
  const out = new Uint8ClampedArray(8);
  paintRender(
    rgb,
    [
      [40, NaN],
      [100, 0],
      [0, 0],
    ],
    [stretch, stretch, stretch],
    out,
  );
  assert.deepEqual([...out.slice(0, 4)], [102, 255, 0, 255]);
  assert.equal(out[7], 0, "a NaN band leaves the pixel transparent");
});

test("paintRender draws an index on its ramp, clamped to -1..1", () => {
  const out = new Uint8ClampedArray(12);
  // NDVI of (nir, red): 1 (all nir), 0 (equal), and 0/0 which is not a number.
  paintRender(
    ndvi,
    [
      [1, 1, 0],
      [0, 1, 0],
    ],
    [],
    out,
  );
  assert.deepEqual([...out.slice(0, 4)], [0x01, 0x66, 0x5e, 255], "full vegetation end");
  assert.deepEqual([...out.slice(4, 8)], [0xf5, 0xf5, 0xf5, 255], "zero is the pale middle");
  assert.equal(out[11], 0, "a result that is not a number is transparent");
});

test("pickOverview takes the coarsest image still fine enough for the tile", () => {
  assert.equal(pickOverview([10, 20, 40, 80], 50), 2);
  assert.equal(pickOverview([10, 20, 40, 80], 5), 0);
  assert.equal(pickOverview([10, 20, 40, 80], 1000), 3);
});

test("a style round-trips through the tile URL, and a reset gives back the plain URL", () => {
  const styled = withRenderStyle(ndvi, { ramp: "RdYlGn", min: -0.2, max: 0.8 });
  assert.deepEqual(styled.style, { ramp: "RdYlGn", min: -0.2, max: 0.8 });
  assert.deepEqual(specFromTileUrl(renderTileUrl(styled)), styled);
  // Defaults are left out, so resetting is the original recipe and the original URL.
  const reset = withRenderStyle(styled, { gain: 1, gamma: 1, ramp: "BrBG", min: -1, max: 1 });
  assert.equal(reset.style, undefined);
  assert.equal(renderTileUrl(reset), renderTileUrl(ndvi));
});

test("the parser refuses a style that could not be drawn", () => {
  const url = (style: unknown) =>
    `stacrender://tile/1/0/0?s=${encodeURIComponent(JSON.stringify({ ...ndvi, style }))}`;
  assert.notEqual(parseRenderTileUrl(url({ ramp: "Spectral", min: 0, max: 1 })), null);
  assert.equal(parseRenderTileUrl(url({ ramp: "nonsense" })), null, "unknown ramp");
  assert.equal(parseRenderTileUrl(url({ min: 1, max: 1 })), null, "empty window");
  assert.equal(parseRenderTileUrl(url({ min: 2, max: 1 })), null, "backwards window");
  assert.equal(parseRenderTileUrl(url({ gain: 0 })), null, "zero gain");
  assert.equal(parseRenderTileUrl(url({ gamma: Infinity })), null, "infinite gamma");
  assert.equal(parseRenderTileUrl(url("bright")), null, "not an object");
});

test("brightness and gamma change a colour composite, and the default leaves it alone", () => {
  const stretch = { low: 0, high: 100 };
  const paint = (style?: RenderStyle) => {
    const out = new Uint8ClampedArray(4);
    paintRender(
      { ...rgb, ...(style ? { style } : {}) },
      [[20], [20], [20]],
      [stretch, stretch, stretch],
      out,
    );
    return out[0];
  };
  assert.equal(paint(), 51, "20 of 100 is a fifth of the way");
  assert.equal(paint({ gain: 2 }), 102, "double the gain doubles it");
  assert.ok(paint({ gamma: 2 }) > paint(), "a higher gamma lifts mid-tones");
  assert.ok(paint({ gamma: 0.5 }) < paint(), "a lower gamma deepens them");
});

test("an index follows its ramp and value window", () => {
  const paint = (value: number, style?: RenderStyle) => {
    const out = new Uint8ClampedArray(4);
    // nir = value, red = 0, so NDVI is 1 for any positive value; use a formula-free pair instead.
    paintRender(
      {
        kind: "index",
        formula: "a - b",
        bands: [band("a"), band("b")],
        ...(style ? { style } : {}),
      },
      [[value], [0]],
      [],
      out,
    );
    return [...out];
  };
  // The window's middle is the pale stop whatever its ends are.
  assert.deepEqual(paint(0.5, { min: 0, max: 1 }).slice(0, 3), [0xf5, 0xf5, 0xf5]);
  // The low end of the window is the low colour, the high end the high one.
  assert.deepEqual(paint(0, { min: 0, max: 1 }).slice(0, 3), [0x8c, 0x51, 0x0a]);
  assert.deepEqual(paint(1, { min: 0, max: 1 }).slice(0, 3), [0x01, 0x66, 0x5e]);
  // Another ramp changes the colours, not where they fall.
  assert.deepEqual(paint(1, { ramp: "Greys" }).slice(0, 3), [255, 255, 255]);
  // Past the window is clamped to its end.
  assert.deepEqual(paint(5, { min: 0, max: 1 }).slice(0, 3), [0x01, 0x66, 0x5e]);
});
