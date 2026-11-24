import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adjustFrameBox,
  autoGridInterval,
  clampFrameBox,
  computeMapGrid,
  defaultInsetRect,
  findEdgeTicks,
  formatDecimalDegrees,
  formatDms,
  formatMgrsDigits,
  formatUtm,
  insetViewForBounds,
  insetRenderSize,
  insetFootprint,
  mercatorViewPx,
  mgrsSquareLabel,
  movedOffset,
  offsetBox,
  pointsToPagePx,
  rectToFrameBox,
  resizedOffset,
  utmProjector,
  utmZoneFor,
  wrapLongitude,
} from "../apps/geolibre-desktop/src/lib/print-layout-cartography";
import {
  drawLayout,
  mapBodyAspectRatio,
  type LayoutOptions,
} from "../apps/geolibre-desktop/src/lib/print-layout";
import type { CaptureGeoref } from "../apps/geolibre-desktop/src/lib/geopdf";
import type { CapturedMap } from "../apps/geolibre-desktop/src/lib/print-layout-export";
import { capturedBounds } from "../apps/geolibre-desktop/src/lib/print-capture-bounds";

const close = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, msg ?? `${actual} != ${expected} (±${tol})`);

describe("grid intervals", () => {
  it("snaps a DMS interval to whole seconds, minutes and degrees", () => {
    close(autoGridInterval(4, "dms"), 1, 1e-12);
    close(autoGridInterval(1, "dms"), 15 / 60, 1e-12);
    close(autoGridInterval(0.05, "dms"), 1 / 60, 1e-12);
    close(autoGridInterval(200, "dms"), 90, 1e-12);
  });

  it("uses a 1-2-5 step for decimal degrees and metres", () => {
    close(autoGridInterval(4, "decimal"), 1, 1e-12);
    close(autoGridInterval(0.7, "decimal"), 0.2, 1e-12);
    assert.equal(autoGridInterval(37_000, "utm"), 10_000);
    assert.equal(autoGridInterval(3_000, "utm"), 1_000);
  });

  it("keeps an MGRS grid at least one kilometre apart, since it labels km digits", () => {
    assert.equal(autoGridInterval(400, "mgrs"), 1000);
    assert.equal(autoGridInterval(400, "utm"), 100);
  });
});

describe("findEdgeTicks", () => {
  it("finds every multiple along a linear edge exactly once", () => {
    const ticks = findEdgeTicks((t) => -10 + 20 * t, 5);
    assert.deepEqual(
      ticks.map((tk) => tk.value),
      [-10, -5, 0, 5, 10],
    );
    close(ticks[2].t, 0.5, 1e-9);
  });

  it("handles a decreasing coordinate (latitude down a left edge)", () => {
    const ticks = findEdgeTicks((t) => 50 - 10 * t, 2.5);
    assert.deepEqual(
      ticks.map((tk) => tk.value),
      [50, 47.5, 45, 42.5, 40],
    );
    assert.ok(ticks.every((tk, i) => i === 0 || tk.t > ticks[i - 1].t));
  });

  it("unwraps longitude across the antimeridian", () => {
    // 170E to 170W across 180.
    const ticks = findEdgeTicks((t) => wrapLongitude(170 + 20 * t), 5, true);
    assert.deepEqual(
      ticks.map((tk) => wrapLongitude(tk.value)),
      [170, 175, -180, -175, -170],
    );
  });

  it("keeps a non-divisor longitude lattice identical in repeated worlds", () => {
    const base = findEdgeTicks((t) => 20 * t, 7, true);
    const repeated = findEdgeTicks((t) => 360 + 20 * t, 7, true);
    assert.deepEqual(
      base.map((tick) => tick.value),
      [0, 7, 14],
    );
    assert.deepEqual(
      repeated.map((tick) => tick.value - 360),
      [0, 7, 14],
    );
    base.forEach((tick, i) => close(repeated[i].t, tick.t, 1e-9));
  });

  it("skips gaps where the edge leaves the map", () => {
    const ticks = findEdgeTicks((t) => (t > 0.4 && t < 0.6 ? null : 100 * t), 10);
    assert.ok(!ticks.some((tk) => tk.value === 50));
    assert.ok(ticks.some((tk) => tk.value === 30));
    assert.ok(ticks.some((tk) => tk.value === 70));
  });

  it("returns nothing for a non-positive interval", () => {
    assert.deepEqual(
      findEdgeTicks((t) => t, 0),
      [],
    );
  });
});

describe("label formatting", () => {
  it("writes DMS with hemisphere letters and trims zero parts", () => {
    assert.equal(formatDms(45, "lat"), "45°N");
    assert.equal(formatDms(-122.5, "lon"), "122°30′W");
    assert.equal(formatDms(-12.2583333333, "lat"), "12°15′30″S");
    assert.equal(formatDms(0, "lon"), "0°");
    assert.equal(formatDms(180, "lon"), "180°");
    // A longitude past 180 is wrapped first.
    assert.equal(formatDms(190, "lon"), "170°W");
  });

  it("writes decimal degrees with the decimals the interval needs", () => {
    assert.equal(formatDecimalDegrees(45, "lat", 1), "45°N");
    assert.equal(formatDecimalDegrees(-122.25, "lon", 0.25), "122.25°W");
    assert.equal(formatDecimalDegrees(10.2, "lon", 0.2), "10.2°E");
  });

  it("writes UTM metres and MGRS kilometre digits", () => {
    assert.equal(formatUtm(345000, "lon"), "345000mE");
    assert.equal(formatUtm(4123000.4, "lat"), "4123000mN");
    assert.equal(formatMgrsDigits(345000), "45");
    assert.equal(formatMgrsDigits(4_107_000), "07");
    assert.equal(formatMgrsDigits(500_000), "00");
  });

  it("converts points to page pixels through the physical page width", () => {
    // A4 landscape at 150 dpi: 297 mm over 1754 px. 72 pt is one inch.
    close(pointsToPagePx(72, 1754, 297), (25.4 * 1754) / 297, 1e-9);
  });
});

describe("UTM and MGRS", () => {
  it("picks the standard zone and the Norway / Svalbard exceptions", () => {
    assert.deepEqual(utmZoneFor(-122.4, 37.8), { zone: 10, south: false });
    assert.deepEqual(utmZoneFor(151.2, -33.9), { zone: 56, south: true });
    assert.deepEqual(utmZoneFor(5, 60), { zone: 32, south: false });
    assert.deepEqual(utmZoneFor(15, 78), { zone: 33, south: false });
  });

  it("projects a zone's central meridian to a 500 km easting", () => {
    const project = utmProjector({ zone: 33, south: false });
    const [e, n] = project(15, 0);
    close(e, 500_000, 1e-3);
    close(n, 0, 1e-3);
    // A known point: Vienna (16.3738 E, 48.2082 N) in zone 33N.
    const [ve, vn] = project(16.3738, 48.2082);
    close(ve, 601_000, 1500);
    close(vn, 5_340_000, 1500);
  });

  it("labels the MGRS grid zone and 100 km square", () => {
    // The MGRS standard's own example area: 33U / 100 km square for Vienna.
    const label = mgrsSquareLabel(16.3738, 48.2082);
    assert.match(label ?? "", /^33U [A-Z]{2}$/);
    assert.equal(mgrsSquareLabel(0, 89.9), null);
  });
});

describe("computeMapGrid", () => {
  // A north-up equirectangular page: x = 100..900 maps to 10W..10E, y =
  // 100..500 maps to 50N..40N.
  const frame = { x: 100, y: 100, w: 800, h: 400 };
  const pageToLngLat = (x: number, y: number): [number, number] => [
    -10 + ((x - 100) / 800) * 20,
    50 - ((y - 100) / 400) * 10,
  ];

  it("ticks longitude on the top/bottom edges and latitude on the sides", () => {
    const grid = computeMapGrid({ frame, pageToLngLat, type: "dms", interval: 5 });
    assert.ok(grid);
    const top = grid.ticks.filter((tk) => tk.edge === "top");
    assert.deepEqual(
      top.map((tk) => tk.label),
      ["10°W", "5°W", "0°", "5°E", "10°E"],
    );
    close(top[2].x, 500, 1e-6);
    assert.equal(top[2].y, 100);
    const left = grid.ticks.filter((tk) => tk.edge === "left");
    assert.deepEqual(
      left.map((tk) => tk.label),
      ["50°N", "45°N", "40°N"],
    );
    assert.equal(grid.zoneLabel, null);
    // One line per longitude (top to bottom) and per latitude (left to right).
    assert.equal(grid.lines.length, 5 + 3);
  });

  it("picks an interval automatically when given 0", () => {
    const grid = computeMapGrid({ frame, pageToLngLat, type: "decimal", interval: 0 });
    assert.ok(grid);
    // The shorter span is 10 degrees of latitude: about four intervals.
    close(grid.interval, 5, 1e-12);
  });

  it("floors fixed intervals to the precision their labels can represent", () => {
    const small = (x: number, y: number): [number, number] => [
      10 + ((x - frame.x) / frame.w) * 0.01,
      45 + ((y - frame.y) / frame.h) * 0.01,
    ];
    const dms = computeMapGrid({ frame, pageToLngLat: small, type: "dms", interval: 0.0001 });
    assert.ok(dms && dms.interval >= 1 / 3600);
    const ticks = dms.ticks.filter((tick) => tick.edge === "top" && tick.axis === 0);
    assert.ok(ticks.length > 2);
    assert.equal(new Set(ticks.map((tick) => tick.label)).size, ticks.length);
    const utm = computeMapGrid({ frame, pageToLngLat: small, type: "utm", interval: 0.1 });
    assert.ok(utm && utm.interval >= 1);
  });

  it("draws a UTM grid in the centre's zone and labels the zone", () => {
    const small = (x: number, y: number): [number, number] => [
      14.5 + ((x - 100) / 800) * 1,
      48.5 - ((y - 100) / 400) * 0.5,
    ];
    const grid = computeMapGrid({ frame, pageToLngLat: small, type: "utm", interval: 10_000 });
    assert.ok(grid);
    assert.equal(grid.zoneLabel, "33N");
    const top = grid.ticks.filter((tk) => tk.edge === "top");
    assert.ok(top.length >= 5, `expected several easting ticks, got ${top.length}`);
    assert.ok(top.every((tk) => tk.value % 10_000 === 0 && tk.label.endsWith("mE")));
    const mgrs = computeMapGrid({
      frame,
      pageToLngLat: (x, y) => [
        14.8 + ((x - frame.x) / frame.w) * 0.1,
        48.2 - ((y - frame.y) / frame.h) * 0.05,
      ],
      type: "mgrs",
      interval: 1500,
    });
    assert.match(mgrs?.zoneLabel ?? "", /^33U [A-Z]{2}$/);
    assert.ok(mgrs && mgrs.ticks.length > 0);
    assert.equal(mgrs.interval, 2000);
    assert.ok(mgrs.ticks.every((tick) => tick.value % 2000 === 0));
    assert.ok(mgrs?.ticks.every((tk) => /^\d\d$/.test(tk.label)));
  });

  it("finds both axes when a quarter-turn puts longitude on the side edges", () => {
    const grid = computeMapGrid({
      frame,
      type: "decimal",
      interval: 5,
      pageToLngLat: (x, y) => [
        5 + ((y - frame.y) / frame.h) * 20,
        50 - ((x - frame.x) / frame.w) * 10,
      ],
    });
    assert.ok(grid);
    assert.equal(grid.lines.length, 8);
    assert.ok(grid.ticks.some((tick) => tick.edge === "top" && tick.axis === 1));
    assert.ok(grid.ticks.some((tick) => tick.edge === "left" && tick.axis === 0));
  });

  it("bounds the work for tiny fixed intervals", () => {
    const grid = computeMapGrid({ frame, pageToLngLat, type: "decimal", interval: 1e-12 });
    assert.ok(grid && grid.interval >= 0.1);
    assert.ok(grid.ticks.length < 2000);
    assert.ok(findEdgeTicks((t) => t * 80, 1e-12).length <= 4096);
  });

  it("reports multi-square MGRS frames instead of printing one misleading square id", () => {
    const grid = computeMapGrid({ frame, pageToLngLat, type: "mgrs", interval: 1000 });
    assert.equal(grid?.warning, "mgrs-multiple-squares");
    assert.deepEqual(grid?.ticks, []);
  });

  it("returns null when the frame centre is off the map", () => {
    assert.equal(
      computeMapGrid({ frame, pageToLngLat: () => null, type: "dms", interval: 0 }),
      null,
    );
  });
});

describe("inset view", () => {
  it("bounds extremely narrow and wide renders while keeping both sides positive", () => {
    assert.deepEqual(insetRenderSize(0.01 / 0.8), { width: 6, height: 480 });
    assert.deepEqual(insetRenderSize(80), { width: 480, height: 6 });
    assert.deepEqual(insetRenderSize(4 / 3), { width: 480, height: 360 });
    const tiny = insetRenderSize(1e-9);
    assert.equal(tiny.width, 1);
    assert.equal(tiny.height, 480);
  });
  it("draws one world boundary without an interior dateline seam", () => {
    const view = insetViewForBounds([-180, -50, 180, 50], 480, 360, 0);
    const ring = insetFootprint(view, [
      [-180, 50],
      [-90, 50],
      [0, 50],
      [90, 50],
      [180, 50],
      [180, -50],
      [90, -50],
      [0, -50],
      [-90, -50],
      [-180, -50],
    ]);
    assert.equal(ring.length, 4);
    assert.equal(new Set(ring.map((point) => point.x)).size, 2);
    assert.equal(new Set(ring.map((point) => point.y)).size, 2);
  });
  it("centres on the extent and zooms out by the offset", () => {
    const bounds: [number, number, number, number] = [-1, -1, 1, 1];
    const fitted = insetViewForBounds(bounds, 400, 400, 0);
    const out = insetViewForBounds(bounds, 400, 400, -3);
    close(fitted.center[0], 0, 1e-9);
    close(fitted.center[1], 0, 1e-6);
    close(out.zoom, fitted.zoom - 3, 1e-9);
    // At the fitted zoom the extent spans the (square) view along its longer
    // Mercator side (latitude stretches slightly), centred in it.
    const nw = mercatorViewPx(fitted, -1, 1);
    const se = mercatorViewPx(fitted, 1, -1);
    close(Math.max(se.x - nw.x, se.y - nw.y), 400, 1e-6);
    close((nw.x + se.x) / 2, 200, 1e-6);
    close((nw.y + se.y) / 2, 200, 1e-6);
  });

  it("places a point across the antimeridian on the near side", () => {
    const view = { center: [179, 0] as [number, number], zoom: 4, width: 200, height: 200 };
    const p = mercatorViewPx(view, -179, 0);
    assert.ok(p.x > 100, "east of the centre, not a world away to the west");
  });

  it("clamps the zoom at 0", () => {
    assert.equal(insetViewForBounds([-180, -80, 180, 80], 100, 100, -12).zoom, 0);
  });
});

describe("element offsets", () => {
  it("keeps moved and resized offsets within the persisted range", () => {
    assert.deepEqual(movedOffset(undefined, -1200, 1200, 1000, 700), { dx: -1, dy: 1, scale: 1 });
    const resized = resizedOffset(
      { x: 500, y: 500, w: 100, h: 100 },
      { x: 0, y: 0 },
      { dx: -0.9, dy: -0.9, scale: 1 },
      1000,
      1000,
      1000,
      700,
    );
    assert.ok(Math.abs(resized.dx) <= 1 && Math.abs(resized.dy) <= 1);
  });
  const natural = { x: 100, y: 50, w: 200, h: 100 };
  const anchor = { x: 100, y: 50 };
  const W = 1000;
  const H = 500;

  it("leaves an element without an offset where it is", () => {
    assert.deepEqual(offsetBox(natural, anchor, undefined, W, H), natural);
  });

  it("moves by page fractions, so every resolution agrees", () => {
    const off = movedOffset(undefined, 100, 50, W, H);
    assert.deepEqual(off, { dx: 0.1, dy: 0.1, scale: 1 });
    assert.deepEqual(offsetBox(natural, anchor, off, W, H), { x: 200, y: 100, w: 200, h: 100 });
    // The same offset on a page twice the size lands twice as far.
    const big = offsetBox(
      { x: 200, y: 100, w: 400, h: 200 },
      { x: 200, y: 100 },
      off,
      2 * W,
      2 * H,
    );
    assert.deepEqual(big, { x: 400, y: 200, w: 400, h: 200 });
  });

  it("resizes from the bottom-right corner, keeping the top-left fixed", () => {
    const moved = movedOffset(undefined, 30, 20, W, H);
    const before = offsetBox(natural, anchor, moved, W, H);
    const resized = resizedOffset(natural, anchor, moved, 200, 0, W, H);
    const after = offsetBox(natural, anchor, resized, W, H);
    close(resized.scale, 2, 1e-12);
    close(after.x, before.x, 1e-9);
    close(after.y, before.y, 1e-9);
    close(after.w, 400, 1e-9);
  });

  it("resizes about an anchor that is not the box corner", () => {
    // A scale bar anchors at its bottom-right corner.
    const barAnchor = { x: 300, y: 150 };
    const resized = resizedOffset(natural, barAnchor, undefined, -100, 0, W, H);
    const after = offsetBox(natural, barAnchor, resized, W, H);
    close(after.x, 100, 1e-9);
    close(after.y, 50, 1e-9);
    close(after.w, 100, 1e-9);
  });

  it("clamps the scale", () => {
    assert.equal(resizedOffset(natural, anchor, undefined, -10_000, 0, W, H).scale, 0.25);
    assert.equal(resizedOffset(natural, anchor, undefined, 10_000, 0, W, H).scale, 4);
  });
});

describe("frame boxes", () => {
  it("converts and keeps a moved frame on the page", () => {
    const box = rectToFrameBox({ x: 100, y: 50, w: 500, h: 250 }, 1000, 500);
    assert.deepEqual(box, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    assert.deepEqual(adjustFrameBox(box, "move", 0.8, -0.5), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  });

  it("resizes from the corner within the page and above the minimum", () => {
    const box = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    assert.deepEqual(adjustFrameBox(box, "resize", 0.2, 0.1), { x: 0.1, y: 0.1, w: 0.7, h: 0.6 });
    const big = adjustFrameBox(box, "resize", 5, 5);
    close(big.w, 0.9, 1e-12);
    close(big.h, 0.9, 1e-12);
    assert.equal(adjustFrameBox(box, "resize", -5, -5).w, 0.05);
    assert.deepEqual(clampFrameBox({ x: -1, y: 2, w: 3, h: 0 }), { x: 0, y: 0.95, w: 1, h: 0.05 });
  });

  it("lets a small saved edge frame grow by moving its opposite edge", () => {
    const grown = adjustFrameBox({ x: 0.98, y: 0.98, w: 0.02, h: 0.02 }, "resize", 0.2, 0.1);
    assert.ok(grown.w >= 0.05 && grown.h >= 0.05);
    close(grown.x + grown.w, 1, 1e-12);
    close(grown.y + grown.h, 1, 1e-12);
    close(grown.w, 0.22, 1e-12);
  });

  it("puts the default inset in the frame's lower-left corner", () => {
    const body = { x: 50, y: 80, w: 800, h: 500 };
    const r = defaultInsetRect(body, 5);
    assert.equal(r.x, 60);
    close(r.y + r.h, 570, 1e-9);
    close(r.w, 200, 1e-9);
    close(r.h, 150, 1e-9);
  });

  it("keeps the automatic inset inside a tiny frame at the page edge", () => {
    const body = { x: 950, y: 100, w: 50, h: 500 };
    const inset = defaultInsetRect(body, 10);
    assert.ok(inset.x >= body.x && inset.x + inset.w <= body.x + body.w);
    assert.ok(inset.y >= body.y && inset.y + inset.h <= body.y + body.h);
  });
});

// ---------------------------------------------------------------------------
// Drawing integration: the layout honours the new options.
// ---------------------------------------------------------------------------

/** A context stand-in recording text, images and transforms. */
function recordingCanvas(width = 1000, height = 700) {
  const fills: { text: string; x: number; y: number }[] = [];
  const images: { x: number; y: number; w: number; h: number }[] = [];
  const transforms: string[] = [];
  const paint: string[] = [];
  const state: Record<string, unknown> = { textAlign: "start", textBaseline: "alphabetic" };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "measureText") return (text: string) => ({ width: text.length * 5 });
      if (prop === "arcTo")
        return (_x: number, _y: number, _x2: number, _y2: number, radius: number) => {
          assert.ok(radius >= 0, "Canvas rejects a negative arc radius");
        };
      if (prop === "fillText") {
        return (text: string, x: number, y: number) => {
          paint.push(`text:${text}`);
          fills.push({ text, x, y });
        };
      }
      if (prop === "drawImage") {
        return (_img: unknown, x: number, y: number, w: number, h: number) => {
          paint.push("image");
          images.push({ x, y, w, h });
        };
      }
      if (prop === "stroke") return () => paint.push("stroke");
      if (prop === "translate" || prop === "scale" || prop === "rotate") {
        return (...args: number[]) => transforms.push(`${String(prop)}(${args.join(",")})`);
      }
      if (prop in target) return target[prop as string];
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  const canvas = { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, fills, images, transforms, paint };
}

/** An equirectangular georeference: 1000 x 500 image over 10W..10E, 50N..40N. */
const GEOREF: CaptureGeoref = {
  transform: [-10, 0.02, 0, 50, 0, -0.02],
  projection: {
    epsg: 4326,
    wkt: null,
    geographic: true,
    forward: (lng, lat) => [lng, lat],
    inverse: (x, y) => [x, y],
  },
};

function options(overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  return {
    title: "Map",
    subtitle: "",
    paperSize: "fullhd",
    orientation: "landscape",
    showTitle: true,
    showLegend: true,
    showScaleBar: true,
    showNorthArrow: true,
    showFooter: true,
    footerText: "Footer",
    legend: [{ id: "a", name: "Roads", swatches: [{ color: "#ff0000" }] }],
    legendTitle: "Legend",
    legendGroupByLayer: true,
    metersPerPixel: 100,
    bearingDeg: 0,
    mapImage: {} as CanvasImageSource,
    mapImageWidth: 1000,
    mapImageHeight: 500,
    mapGeoref: GEOREF,
    ...overrides,
  };
}

describe("captured inset bounds", () => {
  const capture = (west: number, span: number): CapturedMap => ({
    image: {} as HTMLCanvasElement,
    width: 1000,
    height: 500,
    metersPerPixel: 100,
    pixelRatio: 1,
    bearingDeg: 0,
    georef: {
      transform: [west, span / 1000, 0, 50, 0, -0.02],
      projection: {
        ...GEOREF.projection,
        inverse: (x, y) => [wrapLongitude(x), y],
      },
    },
  });
  it("preserves broad and full-world captures without collapsing them to the dateline", () => {
    const broad = capturedBounds(capture(-170, 340));
    const world = capturedBounds(capture(-180, 360));
    assert.ok(broad && Math.abs(broad[2] - broad[0] - 340) < 1e-7);
    assert.deepEqual(world, [-180, 40, 180, 50]);
  });
  it("keeps a narrow dateline crossing narrow", () => {
    assert.deepEqual(capturedBounds(capture(170, 20)), [170, 40, 190, 50]);
  });
  it("fits the visible cover crop rather than the whole capture", () => {
    const cropped = capturedBounds(
      capture(-10, 20),
      options({
        mapFrameBox: { x: 0, y: 0, w: 0.25, h: 1 },
      }),
    );
    assert.ok(cropped && cropped[2] - cropped[0] < 5);
    assert.equal(cropped[1], 40);
    assert.equal(cropped[3], 50);
  });
});

describe("drawLayout with the cartographic extras", () => {
  it("paints both map frames before title and footer furniture", () => {
    const { canvas, paint } = recordingCanvas();
    drawLayout(
      canvas,
      options({
        grid: { type: "decimal", interval: 5, fontSizePt: 7, lines: true },
        inset: {
          box: null,
          image: {} as CanvasImageSource,
          view: { center: [0, 0], zoom: 2, width: 480, height: 360 },
          extentColor: "#ff0000",
        },
      }),
    );
    const lastFrame = paint.lastIndexOf("image");
    assert.equal(paint.filter((item) => item === "image").length, 2);
    assert.ok(paint.slice(0, lastFrame).includes("stroke"), "grid strokes precede the inset");
    // Later furniture can stroke, so identify the grid through its labels too.
    const gridLabel = paint.findIndex((item) => /text:.*[°]/.test(item));
    assert.ok(gridLabel >= 0 && gridLabel < lastFrame);
    assert.ok(paint.indexOf("text:Map") > lastFrame);
    assert.ok(paint.indexOf("text:Footer") > lastFrame);
  });
  it("changes a resized scale bar's distance while a move preserves it", () => {
    const render = (scale: number, dx: number) => {
      const { canvas, fills } = recordingCanvas();
      drawLayout(canvas, options({ elementOffsets: { scaleBar: { dx, dy: 0, scale } } }));
      return fills.find((item) => /^\d+(?:\.\d+)? (?:km|m)$/.test(item.text))?.text;
    };
    const original = render(1, 0);
    assert.ok(original);
    assert.equal(render(1, 0.1), original);
    const resized = render(2, 0);
    assert.ok(resized);
    assert.notEqual(resized, original);
    const plain = drawLayout(recordingCanvas().canvas, options());
    const doubled = drawLayout(
      recordingCanvas().canvas,
      options({ elementOffsets: { scaleBar: { dx: 0, dy: 0, scale: 2 } } }),
    );
    close(doubled.scaleBar!.box.w, plain.scaleBar!.box.w * 2, 1e-9);
  });

  it("includes the rotated upright north label in its arrange box", () => {
    for (const bearingDeg of [0, 90, 180, 270]) {
      const entry = drawLayout(recordingCanvas().canvas, options({ bearingDeg })).northArrow;
      assert.ok(entry?.anchor);
      const angle = (bearingDeg * Math.PI) / 180;
      const x = entry.anchor.x - Math.sin(angle) * 7 * 4;
      const y = entry.anchor.y - Math.cos(angle) * 7 * 4;
      assert.ok(x - 2.5 >= entry.box.x - 1e-8 && x + 2.5 <= entry.box.x + entry.box.w + 1e-8);
      assert.ok(
        y - 7 * 1.2 >= entry.box.y - 1e-8 && y + 7 * 1.2 <= entry.box.y + entry.box.h + 1e-8,
      );
    }
  });
  it("keeps full-page grid labels inside the page", () => {
    const { canvas, fills, transforms } = recordingCanvas();
    drawLayout(
      canvas,
      options({
        mapFrameBox: { x: 0, y: 0, w: 1, h: 1 },
        showTitle: false,
        showFooter: false,
        grid: { type: "decimal", interval: 5, fontSizePt: 7, lines: true },
      }),
    );
    const labels = fills.filter((item) => item.text.includes("°"));
    assert.ok(labels.length);
    assert.ok(labels.every((item) => item.y >= 0 && item.y <= 700));
    assert.ok(!transforms.some((item) => /^translate\(-\d/.test(item)), transforms.join(" | "));
  });
  it("skips a table when a narrow map frame has no positive content width", () => {
    const { canvas, fills } = recordingCanvas();
    assert.doesNotThrow(() =>
      drawLayout(
        canvas,
        options({
          mapFrameBox: { x: 0, y: 0, w: 0.01, h: 1 },
          dataTable: { columns: ["name"], rows: [["parcel"]], position: "bottom-left" },
        }),
      ),
    );
    assert.ok(!fills.some((item) => item.text === "parcel"));
  });
  it("composes the inset's basemap attribution into the output", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      options({
        inset: {
          box: null,
          image: {} as CanvasImageSource,
          view: { center: [0, 0], zoom: 2, width: 480, height: 360 },
          extentColor: "#ff0000",
          attribution: "© OpenStreetMap contributors",
        },
      }),
    );
    assert.ok(fills.some((item) => item.text === "© OpenStreetMap contributors"));
  });
  it("reports a box for every drawn element, unchanged by default", () => {
    const { canvas } = recordingCanvas();
    const boxes = drawLayout(canvas, options());
    for (const id of ["map", "title", "legend", "scaleBar", "northArrow", "footer"] as const) {
      assert.ok(boxes[id], `expected a box for ${id}`);
    }
    assert.equal(boxes.inset, undefined);
    // Without offsets the drawn box is the natural one.
    assert.deepEqual(boxes.legend?.box, boxes.legend?.natural);
  });

  it("moves and scales an element by its stored offset", () => {
    const { canvas } = recordingCanvas();
    const plain = drawLayout(canvas, options());
    const moved = drawLayout(
      canvas,
      options({ elementOffsets: { legend: { dx: 0.1, dy: 0.2, scale: 2 } } }),
    );
    const a = plain.legend!.box;
    const b = moved.legend!.box;
    close(b.x, a.x + 0.1 * 1000, 1e-6);
    close(b.y, a.y + 0.2 * 700, 1e-6);
    close(b.w, a.w * 2, 1e-6);
  });

  it("places the map frame at its stored box, which drives the frame aspect", () => {
    const { canvas } = recordingCanvas();
    const mapFrameBox = { x: 0.2, y: 0.2, w: 0.6, h: 0.3 };
    const boxes = drawLayout(canvas, options({ mapFrameBox }));
    assert.deepEqual(boxes.map?.box, { x: 200, y: 140, w: 600, h: 210 });
    // FullHD is 1920 x 1080: 0.6 * 1920 / (0.3 * 1080).
    close(mapBodyAspectRatio(options({ mapFrameBox })), (0.6 * 1920) / (0.3 * 1080), 1e-9);
  });

  it("labels the frame border with the grid", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(canvas, options({ grid: { type: "dms", interval: 5, fontSizePt: 7, lines: true } }));
    const labels = fills.map((f) => f.text);
    assert.ok(labels.includes("0°"), `labels: ${labels.join(" | ")}`);
    assert.ok(labels.includes("45°N"));
  });

  it("reserves no grid margin without a georeference", () => {
    const plain = options({ mapGeoref: null });
    const grid = { type: "dms" as const, interval: 5, fontSizePt: 7, lines: true };
    assert.equal(mapBodyAspectRatio({ ...plain, grid }), mapBodyAspectRatio(plain));
  });

  it("draws no grid without a georeference (globe or tilted capture)", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      options({ mapGeoref: null, grid: { type: "dms", interval: 5, fontSizePt: 7, lines: false } }),
    );
    assert.ok(!fills.some((f) => f.text === "45°N"));
  });

  it("draws the inset frame and its image at the stored box", () => {
    const { canvas, images } = recordingCanvas();
    const insetBox = { x: 0.05, y: 0.6, w: 0.2, h: 0.2 };
    const boxes = drawLayout(
      canvas,
      options({
        inset: {
          box: insetBox,
          image: {} as CanvasImageSource,
          view: { center: [0, 45], zoom: 2, width: 200, height: 200 },
          extentColor: "#dc2626",
        },
      }),
    );
    assert.deepEqual(boxes.inset?.box, { x: 50, y: 420, w: 200, h: 140 });
    // Main map image, then the inset image cover-fitted into its frame.
    const insetImage = images[images.length - 1];
    close(insetImage.w, 200, 1e-6);
    close(insetImage.x, 50, 1e-6);
  });
});

it("rejects MGRS square labels outside the supported latitude range", () => {
  for (const lat of [-81, 84, 85, NaN]) assert.equal(mgrsSquareLabel(0, lat), null);
  assert.ok(mgrsSquareLabel(0, 83.9));
});
