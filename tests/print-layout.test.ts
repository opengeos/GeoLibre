import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeScaleRatio,
  drawLayout,
  pageMm,
  pagePx,
  resolvePageSize,
  type LayoutOptions,
  type LegendEntry,
} from "../apps/geolibre-desktop/src/lib/print-layout";

/**
 * A minimal recording stand-in for a 2D canvas context. Every drawing method is
 * a no-op except `measureText` (returns a fixed width) and `fillText`, which
 * records the alignment in effect at the moment of the draw so tests can assert
 * how text was anchored.
 */
function recordingCanvas(): {
  canvas: HTMLCanvasElement;
  fills: { text: string; textAlign: string; textBaseline: string }[];
  fillRects: { w: number; h: number; fillStyle: string }[];
  arcs: number;
  polylines: number[];
} {
  const fills: { text: string; textAlign: string; textBaseline: string }[] = [];
  // Filled rectangles (swatches, chart bars), with the fill colour in effect.
  const fillRects: { w: number; h: number; fillStyle: string }[] = [];
  // Stroked polylines: one entry per beginPath..stroke sequence that used
  // lineTo, holding the segment count (the line chart's path).
  const polylines: number[] = [];
  const counters = { arcs: 0, pendingLines: 0 };
  const state: Record<string, unknown> = {
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "measureText") return () => ({ width: 10 });
      if (prop === "fillText") {
        return (text: string) =>
          fills.push({
            text,
            textAlign: String(target.textAlign),
            textBaseline: String(target.textBaseline),
          });
      }
      if (prop === "fillRect") {
        return (_x: number, _y: number, w: number, h: number) =>
          fillRects.push({ w, h, fillStyle: String(target.fillStyle) });
      }
      if (prop === "arc") {
        return () => {
          counters.arcs += 1;
        };
      }
      if (prop === "beginPath") {
        return () => {
          counters.pendingLines = 0;
        };
      }
      if (prop === "lineTo") {
        return () => {
          counters.pendingLines += 1;
        };
      }
      if (prop === "stroke") {
        return () => {
          if (counters.pendingLines > 0) polylines.push(counters.pendingLines);
          counters.pendingLines = 0;
        };
      }
      if (prop in target) return target[prop as string];
      // Any other method (save, restore, clip, ...) is a no-op.
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  const canvas = {
    width: 400,
    height: 400,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    fills,
    fillRects,
    get arcs() {
      return counters.arcs;
    },
    polylines,
  };
}

function baseOptions(overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  const legend: LegendEntry[] = [{ id: "a", name: "Roads", swatches: [{ color: "#ff0000" }] }];
  return {
    title: "Map",
    subtitle: "",
    paperSize: "a4",
    orientation: "landscape",
    showTitle: true,
    showLegend: true,
    showScaleBar: false,
    showNorthArrow: false,
    showFooter: false,
    footerText: "",
    legend,
    legendTitle: "Legend",
    legendGroupByLayer: true,
    metersPerPixel: 0,
    bearingDeg: 0,
    mapImage: null,
    mapImageWidth: 0,
    mapImageHeight: 0,
    ...overrides,
  };
}

describe("drawLayout legend rendering", () => {
  it("left-aligns legend row labels even when the legend title is empty", () => {
    // The title block draws centered text first; the legend must reset the
    // alignment for its rows regardless of whether it draws its own title.
    const { canvas, fills } = recordingCanvas();
    drawLayout(canvas, baseOptions({ legendTitle: "" }));

    const label = fills.find((f) => f.text === "Roads");
    assert.ok(label, "expected the legend row label to be drawn");
    assert.equal(label.textAlign, "left");
    assert.equal(label.textBaseline, "alphabetic");
  });

  it("renders the swatch label for an entry collapsed to one visible class", () => {
    // applyLegendConfig yields a single-swatch entry (layer name + the one
    // un-hidden class label) when the other classes are hidden; the label, not
    // the layer name, must be drawn.
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        legend: [
          { id: "pop", name: "Population", swatches: [{ color: "#00aa00", label: "High" }] },
        ],
      }),
    );
    assert.ok(
      fills.some((f) => f.text === "High"),
      "expected the surviving class label to be drawn",
    );
    assert.ok(
      !fills.some((f) => f.text === "Population"),
      "expected the layer name not to replace the class label",
    );
  });

  it("renders the layer name for a genuine single-symbol entry", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        legend: [{ id: "a", name: "Roads", swatches: [{ color: "#ff0000" }] }],
      }),
    );
    assert.ok(fills.some((f) => f.text === "Roads"));
  });

  it("left-aligns legend rows when a legend title is present", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(canvas, baseOptions({ legendTitle: "Key" }));

    assert.ok(
      fills.some((f) => f.text === "Key" && f.textAlign === "left"),
      "expected the legend title to be drawn left-aligned",
    );
    const label = fills.find((f) => f.text === "Roads");
    assert.ok(label, "expected the legend row label to be drawn");
    assert.equal(label.textAlign, "left");
  });
});

describe("resolvePageSize", () => {
  it("swaps width/height for landscape preset paper", () => {
    const portrait = resolvePageSize({ paperSize: "a4", orientation: "portrait" });
    assert.deepEqual(portrait, { width: 210, height: 297, unit: "mm" });
    const landscape = resolvePageSize({ paperSize: "a4", orientation: "landscape" });
    assert.deepEqual(landscape, { width: 297, height: 210, unit: "mm" });
  });

  it("resolves a pixel screen preset to its oriented pixel dimensions", () => {
    const landscape = resolvePageSize({ paperSize: "fullhd", orientation: "landscape" });
    assert.deepEqual(landscape, { width: 1920, height: 1080, unit: "px" });
  });

  it("takes custom dimensions verbatim, ignoring orientation", () => {
    const size = resolvePageSize({
      paperSize: "custom",
      orientation: "landscape",
      customSize: { width: 800, height: 600, unit: "px" },
    });
    assert.deepEqual(size, { width: 800, height: 600, unit: "px" });
  });

  it("falls back to a sane default for an incomplete custom size", () => {
    const size = resolvePageSize({
      paperSize: "custom",
      orientation: "portrait",
      customSize: { width: 0, height: 0, unit: "px" },
    });
    assert.deepEqual(size, { width: 1280, height: 720, unit: "px" });
  });
});

describe("pageMm / pagePx", () => {
  it("passes millimetre sizes through and scales by dpi for pixels", () => {
    assert.deepEqual(pageMm({ width: 210, height: 297, unit: "mm" }), {
      widthMm: 210,
      heightMm: 297,
    });
    assert.deepEqual(pagePx({ width: 1920, height: 1080, unit: "px" }, 150), {
      width: 1920,
      height: 1080,
    });
    // A4 portrait at 150 dpi: 210 mm * 150 / 25.4 ≈ 1240 px.
    assert.deepEqual(pagePx({ width: 210, height: 297, unit: "mm" }, 150), {
      width: 1240,
      height: 1754,
    });
  });

  it("treats screen pixels as 96-dpi millimetres", () => {
    const { widthMm } = pageMm({ width: 96, height: 96, unit: "px" });
    assert.ok(Math.abs(widthMm - 25.4) < 1e-6, "96 px at 96 dpi is one inch");
  });
});

describe("drawLayout cartographic furniture", () => {
  it("right-aligns the title when titleAlign is right", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(canvas, baseOptions({ title: "Atlas", titleAlign: "right" }));
    const title = fills.find((f) => f.text === "Atlas");
    assert.ok(title, "expected the title to be drawn");
    assert.equal(title.textAlign, "right");
  });

  it("draws the attribution and date in the footer row independently", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        showAttribution: true,
        showDate: true,
        dateText: "2026-06-19",
        showFooter: true,
        footerText: "My Org",
      }),
    );
    const attribution = fills.find((f) => f.text === "Created with GeoLibre");
    assert.ok(attribution, "expected the attribution to be drawn");
    assert.equal(attribution.textAlign, "left");
    const date = fills.find((f) => f.text === "2026-06-19");
    assert.ok(date, "expected the date to be drawn");
    assert.equal(date.textAlign, "right");
    const footer = fills.find((f) => f.text === "My Org");
    assert.ok(footer, "expected the custom footer text to be drawn");
    assert.equal(footer.textAlign, "center");
  });

  it("omits the attribution when showAttribution is false", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(canvas, baseOptions({ showAttribution: false }));
    assert.ok(!fills.some((f) => f.text === "Created with GeoLibre"));
  });

  it("draws a 1:N scale ratio for a millimetre paper size", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        showScaleBar: true,
        metersPerPixel: 10,
        mapImage: {} as CanvasImageSource,
        mapImageWidth: 400,
        mapImageHeight: 400,
      }),
    );
    assert.ok(
      fills.some((f) => /^1:/.test(f.text)),
      "expected a representative-fraction label",
    );
  });

  it("labels the scale bar in metric by default", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        showScaleBar: true,
        metersPerPixel: 10,
        mapImage: {} as CanvasImageSource,
        mapImageWidth: 400,
        mapImageHeight: 400,
      }),
    );
    assert.ok(
      fills.some((f) => /^\d[\d.]* (km|m|cm)$/.test(f.text)),
      "expected a metric distance label (km/m/cm)",
    );
    assert.ok(
      !fills.some((f) => /(mi|ft|nmi)$/.test(f.text)),
      "did not expect an imperial/nautical label under metric",
    );
  });

  it("labels the scale bar in imperial when scaleUnit is imperial", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        showScaleBar: true,
        scaleUnit: "imperial",
        metersPerPixel: 10,
        mapImage: {} as CanvasImageSource,
        mapImageWidth: 400,
        mapImageHeight: 400,
      }),
    );
    assert.ok(
      fills.some((f) => /^\d[\d.]* (mi|ft)$/.test(f.text)),
      "expected an imperial distance label (mi/ft)",
    );
    assert.ok(
      !fills.some((f) => /(km|nmi)$/.test(f.text) || / m$| cm$/.test(f.text)),
      "did not expect a metric/nautical label under imperial",
    );
  });

  it("labels the scale bar in nautical miles when scaleUnit is nautical", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        showScaleBar: true,
        scaleUnit: "nautical",
        metersPerPixel: 10,
        mapImage: {} as CanvasImageSource,
        mapImageWidth: 400,
        mapImageHeight: 400,
      }),
    );
    assert.ok(
      fills.some((f) => /^\d[\d.]* nmi$/.test(f.text)),
      "expected a nautical-mile distance label (nmi)",
    );
  });

  it("does not draw a scale ratio for a pixel screen size", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        paperSize: "fullhd",
        showScaleBar: true,
        metersPerPixel: 10,
        mapImage: {} as CanvasImageSource,
        mapImageWidth: 400,
        mapImageHeight: 400,
      }),
    );
    assert.ok(!fills.some((f) => /^1:/.test(f.text)));
  });

  it("draws the info block rows when showInfoBlock and fields are set", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        showInfoBlock: true,
        author: "Jane Cartographer",
        projectNumber: "PRJ-42",
        crs: "EPSG:28992",
        revision: "Rev 01",
        infoLabels: { author: "Author", project: "Project", crs: "CRS", revision: "Rev" },
      }),
    );
    for (const v of ["Jane Cartographer", "PRJ-42", "EPSG:28992", "Rev 01"]) {
      assert.ok(
        fills.some((f) => f.text === v),
        `expected the info block to draw "${v}"`,
      );
    }
  });

  it("omits the info block when showInfoBlock is false", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(canvas, baseOptions({ author: "Hidden Author" }));
    assert.ok(!fills.some((f) => f.text === "Hidden Author"));
  });
});

describe("computeScaleRatio", () => {
  const withMap = (overrides: Partial<LayoutOptions> = {}): LayoutOptions =>
    baseOptions({
      metersPerPixel: 10,
      mapImage: {} as CanvasImageSource,
      mapImageWidth: 400,
      mapImageHeight: 400,
      ...overrides,
    });

  it("returns 0 for a pixel/screen page (no physical scale)", () => {
    assert.equal(computeScaleRatio(withMap({ paperSize: "fullhd" })), 0);
  });

  it("returns 0 when there is no captured map", () => {
    assert.equal(computeScaleRatio(baseOptions({ metersPerPixel: 10, mapImage: null })), 0);
  });

  it("returns a positive representative fraction for a millimetre page", () => {
    const ratio = computeScaleRatio(withMap());
    assert.ok(ratio > 0 && Number.isFinite(ratio));
  });

  it("scales linearly with metres-per-pixel (the basis of the zoom math)", () => {
    // The scale denominator is linear in metres-per-pixel, which halves per zoom
    // level, so applyScale derives its zoom delta as log2(current / target).
    const a = computeScaleRatio(withMap({ metersPerPixel: 10 }));
    const b = computeScaleRatio(withMap({ metersPerPixel: 20 }));
    assert.ok(Math.abs(b / a - 2) < 1e-9, "doubling mpp doubles the ratio");
  });
});

/**
 * A recording context that captures every `strokeRect` with the stroke style and
 * line width in effect at the moment of the draw, so tests can assert how the
 * map frame border (GH #749) is rendered.
 */
function strokeRecordingCanvas(): {
  canvas: HTMLCanvasElement;
  strokes: { x: number; w: number; strokeStyle: string; lineWidth: number }[];
} {
  const strokes: {
    x: number;
    w: number;
    strokeStyle: string;
    lineWidth: number;
  }[] = [];
  const state: Record<string, unknown> = { strokeStyle: "", lineWidth: 0 };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "measureText") return () => ({ width: 10 });
      if (prop === "strokeRect") {
        return (x: number, _y: number, w: number) =>
          strokes.push({
            x,
            w,
            strokeStyle: String(target.strokeStyle),
            lineWidth: Number(target.lineWidth),
          });
      }
      if (prop in target) return target[prop as string];
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
  const canvas = {
    width: 400,
    height: 400,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, strokes };
}

describe("drawLayout map frame border (GH #749)", () => {
  // These constants follow directly from computeBodyRect on a 400×400 canvas
  // with the default "normal" margin: unit = min(400,400)/100 = 4, margin =
  // unit*5 = 20, so bodyX = 20 and bodyW = 400 - 40 = 360 (> 200). If the unit
  // formula or default margin changes, update these values.
  const isBodyBorder = (s: { x: number; w: number }) => s.x === 20 && s.w > 200;

  it("draws the frame in the chosen colour and thickness", () => {
    const { canvas, strokes } = strokeRecordingCanvas();
    drawLayout(canvas, baseOptions({ mapBorderColor: "#123456", mapBorderWidth: 5 }));
    const frame = strokes.find((s) => isBodyBorder(s) && s.strokeStyle === "#123456");
    assert.ok(frame, "expected the map frame to use the custom colour");
    assert.ok(frame.lineWidth > 1, "expected a thicker frame for width 5");
  });

  it("hides the frame when the thickness is 0", () => {
    const { canvas, strokes } = strokeRecordingCanvas();
    drawLayout(canvas, baseOptions({ mapBorderWidth: 0 }));
    assert.ok(!strokes.some(isBodyBorder), "expected no map frame stroke when width is 0");
  });
});

describe("drawLayout data blocks (GH #1324)", () => {
  it("renders the table title, headers, cells, and truncation note", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        dataTable: {
          title: "Cities",
          columns: ["name", "pop"],
          rows: [
            ["Springfield", "42000"],
            ["Shelbyville", "39000"],
          ],
          truncated: 3,
          formatNote: (count) => `+${count} more`,
          position: "bottom-left",
        },
      }),
    );
    for (const text of ["Cities", "name", "pop", "Springfield", "42000", "+3 more"]) {
      const fill = fills.find((f) => f.text === text);
      assert.ok(fill, `expected "${text}" to be drawn`);
      assert.equal(fill.textAlign, "left");
    }
  });

  it("drops rows that cannot fit the body height and folds them into the note", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`row${i}`]);
    const rec = recordingCanvas();
    drawLayout(
      rec.canvas,
      baseOptions({
        dataTable: {
          columns: ["name"],
          rows,
          truncated: 5,
          position: "bottom-left",
        },
      }),
    );
    // 50 rows cannot fit a 400px page body; the tail rows must be dropped...
    assert.ok(rec.fills.some((f) => f.text === "row0"));
    assert.ok(!rec.fills.some((f) => f.text === "row49"));
    // ...and the note must count both the dialog-truncated and height-hidden
    // rows (so it reads "+N more" with N > the dialog's own 5).
    const note = rec.fills.find((f) => /^\+\d+ more$/.test(f.text));
    assert.ok(note, "expected a truncation note to be drawn");
    assert.ok(Number(note.text.match(/\d+/)?.[0]) > 5);
  });

  it("skips a table with no rows or no columns", () => {
    const { canvas, fills } = recordingCanvas();
    drawLayout(
      canvas,
      baseOptions({
        dataTable: {
          columns: ["name"],
          rows: [],
          position: "bottom-left",
        },
      }),
    );
    assert.ok(!fills.some((f) => f.text === "name"));
  });

  it("renders bar chart labels, values, and one bar rect per category", () => {
    const rec = recordingCanvas();
    drawLayout(
      rec.canvas,
      baseOptions({
        dataChart: {
          title: "Population",
          position: "top-right",
          data: {
            kind: "bar",
            bars: [
              { label: "CA", value: 12, color: "#111111" },
              { label: "OR", value: 4, color: "#222222" },
            ],
            maxValue: 12,
            minValue: 0,
          },
        },
      }),
    );
    for (const text of ["Population", "CA", "OR", "12", "4"]) {
      assert.ok(
        rec.fills.some((f) => f.text === text),
        `expected "${text}" to be drawn`,
      );
    }
    // The bars themselves must be filled in each category's colour, with the
    // larger value producing the wider rect.
    const ca = rec.fillRects.find((r) => r.fillStyle === "#111111");
    const or = rec.fillRects.find((r) => r.fillStyle === "#222222");
    assert.ok(ca && or, "expected one filled bar rect per category");
    assert.ok(ca.w > or.w, "expected the larger value to draw a wider bar");
  });

  it("draws a truncation note for bar categories past the top-N cap", () => {
    const rec = recordingCanvas();
    drawLayout(
      rec.canvas,
      baseOptions({
        dataChart: {
          position: "top-right",
          data: {
            kind: "bar",
            bars: [{ label: "CA", value: 12, color: "#111111" }],
            maxValue: 12,
            minValue: 0,
            truncated: 7,
          },
          formatNote: (count) => `+${count} more`,
        },
      }),
    );
    assert.ok(
      rec.fills.some((f) => f.text === "+7 more"),
      "expected the dropped-category note to be drawn",
    );
  });

  it("renders pie slice labels, percentages, and slice arcs", () => {
    const rec = recordingCanvas();
    const before = rec.arcs;
    drawLayout(
      rec.canvas,
      baseOptions({
        dataChart: {
          position: "bottom-right",
          data: {
            kind: "pie",
            slices: [
              { label: "a", value: 3, color: "#111111" },
              { label: "b", value: 1, color: "#222222" },
            ],
            total: 4,
          },
        },
      }),
    );
    assert.ok(rec.fills.some((f) => f.text === "a (75%)"));
    assert.ok(rec.fills.some((f) => f.text === "b (25%)"));
    // One arc per slice plus the outline circle (the north arrow's backing
    // disc also uses arc, so require at least that many new arcs).
    assert.ok(rec.arcs - before >= 3, "expected slice arcs and the outline circle to be drawn");
    // Slice colours are also used for the legend swatch rects.
    assert.ok(rec.fillRects.some((r) => r.fillStyle === "#111111"));
    assert.ok(rec.fillRects.some((r) => r.fillStyle === "#222222"));
  });

  it("renders the line chart's axis labels and polyline path", () => {
    const rec = recordingCanvas();
    drawLayout(
      rec.canvas,
      baseOptions({
        dataChart: {
          position: "top-left",
          data: {
            kind: "line",
            points: [
              { index: 0, value: 5 },
              { index: 1, value: 7 },
              { index: 2, value: 9 },
            ],
            min: 5,
            max: 9,
            length: 3,
            color: "#111111",
          },
        },
      }),
    );
    assert.ok(rec.fills.some((f) => f.text === "9" && f.textAlign === "right"));
    assert.ok(rec.fills.some((f) => f.text === "5" && f.textAlign === "right"));
    // The path itself: one stroked polyline with a segment per point pair.
    assert.ok(rec.polylines.includes(2), "expected a stroked 2-segment polyline for the 3 points");
  });
});
