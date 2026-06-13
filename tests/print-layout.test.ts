import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  drawLayout,
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
} {
  const fills: { text: string; textAlign: string; textBaseline: string }[] = [];
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
      if (prop in target) return target[prop as string];
      // Any other method (save, restore, fillRect, beginPath, clip, ...) is a no-op.
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
  return { canvas, fills };
}

function baseOptions(overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  const legend: LegendEntry[] = [
    { id: "a", name: "Roads", swatches: [{ color: "#ff0000" }] },
  ];
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
