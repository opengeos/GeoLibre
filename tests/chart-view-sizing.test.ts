/**
 * Dashboard charts are drawn at their card's measured size rather than by
 * scaling a fixed 560×300 frame, so labels stay at 11px (issue #3455).
 */
import { act, render, stubLayout } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { approximateTextWidth } from "../apps/geolibre-desktop/src/components/panels/charts/chart-text";

const { ChartView, computeChart } =
  await import("../apps/geolibre-desktop/src/components/panels/charts/chart-view");

const LONG = "Riverside Commons Recreational Facility and Annex";

/** Rows with a categorical `kind` (one long name, an Arabic and a Japanese
 * name, some nulls) and a numeric `area`. */
function rows() {
  const kinds = ["Library", "School", "Park", LONG, "مركز المجتمع", "公民館", null];
  return Array.from({ length: 140 }, (_, i) => ({
    properties: { kind: kinds[i % kinds.length], area: 100 + ((i * 37) % 900) },
  }));
}

const barResult = () => computeChart(rows(), { type: "bar", category: "kind" });

/** Replace ResizeObserver with one whose callback the test can fire. */
function fakeResizeObserver() {
  const original = globalThis.ResizeObserver;
  const callbacks: ResizeObserverCallback[] = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return {
    resize(width: number, height: number) {
      const entry = { contentRect: { width, height } } as ResizeObserverEntry;
      for (const callback of callbacks) callback([entry], {} as ResizeObserver);
    },
    restore() {
      globalThis.ResizeObserver = original;
    },
  };
}

let restoreObserver: (() => void) | null = null;
afterEach(() => {
  restoreObserver?.();
  restoreObserver = null;
});

describe("ChartView sizing", () => {
  it("draws a fill chart at the measured size with 11px labels", () => {
    stubLayout(320, 140);
    const { container } = render(createElement(ChartView, { result: barResult(), fill: true }));
    const svg = container.querySelector("svg");
    assert.ok(svg, "chart svg rendered");
    assert.equal(svg.getAttribute("width"), "320");
    assert.equal(svg.getAttribute("height"), "140");
    assert.equal(svg.getAttribute("viewBox"), "0 0 320 140");
    assert.equal(svg.getAttribute("direction"), "ltr");

    const sizes = new Set(
      Array.from(svg.querySelectorAll("text"), (text) => text.getAttribute("font-size")),
    );
    assert.deepEqual([...sizes], ["11"]);
  });

  it("truncates a long category label and keeps the full label as a <title>", () => {
    stubLayout(320, 140);
    const { container } = render(createElement(ChartView, { result: barResult(), fill: true }));
    const titled = Array.from(container.querySelectorAll("svg text")).filter((text) =>
      text.querySelector("title"),
    );
    assert.ok(titled.length > 0, "some label was truncated");
    const long = titled.find((text) => text.querySelector("title")?.textContent === LONG);
    assert.ok(long, "the long label carries its full text as a tooltip");
    const drawn = long.firstChild?.textContent ?? "";
    assert.ok(drawn.endsWith("…"), `drawn label "${drawn}" ends with an ellipsis`);
    assert.ok(drawn.length < LONG.length);
  });

  it("redraws at the new size when the card is resized", () => {
    const observer = fakeResizeObserver();
    restoreObserver = observer.restore;
    stubLayout(320, 140);
    const { container } = render(createElement(ChartView, { result: barResult(), fill: true }));
    act(() => observer.resize(600.6, 220.2));
    const svg = container.querySelector("svg");
    assert.equal(svg?.getAttribute("viewBox"), "0 0 600 220");
    assert.equal(svg?.getAttribute("width"), "600");
  });

  it("renders no svg until the wrapper has a size", () => {
    stubLayout(0, 0);
    const { container } = render(createElement(ChartView, { result: barResult(), fill: true }));
    assert.equal(container.querySelectorAll("svg").length, 0);
    // The measured wrapper is still there, so the caption doesn't jump.
    assert.equal(container.querySelectorAll("div.flex-1").length, 1);
  });

  it("keeps the Charts dialog on the fixed 560×300 frame its export uses", () => {
    stubLayout(320, 140);
    const { container } = render(createElement(ChartView, { result: barResult() }));
    const svg = container.querySelector("svg");
    assert.equal(svg?.getAttribute("viewBox"), "0 0 560 300");
    assert.equal(svg?.getAttribute("width"), "100%");
  });

  it("sizes every chart type in fill mode", () => {
    stubLayout(280, 130);
    const data = rows();
    const specs = [
      { type: "histogram", field: "area", bins: 20 },
      { type: "scatter", xField: "area", yField: "area" },
      { type: "line", field: "area" },
      { type: "box", field: "area" },
      { type: "pie", category: "kind" },
    ] as const;
    for (const spec of specs) {
      const { container, unmount } = render(
        createElement(ChartView, { result: computeChart(data, spec), fill: true }),
      );
      const svg = container.querySelector("svg");
      assert.equal(svg?.getAttribute("viewBox"), "0 0 280 130", spec.type);
      const sizes = new Set(
        Array.from(svg?.querySelectorAll("text") ?? [], (text) => text.getAttribute("font-size")),
      );
      assert.deepEqual([...sizes], ["11"], spec.type);
      unmount();
    }
  });

  it("lays a clipped histogram's outlier bars inside a fill card", () => {
    stubLayout(320, 140);
    const data = rows();
    data.push({ properties: { kind: "Park", area: 1e12 } });
    data.push({ properties: { kind: "Park", area: -1e9 } });
    const { container } = render(
      createElement(ChartView, {
        result: computeChart(data, { type: "histogram", field: "area", bins: 10 }),
        fill: true,
      }),
    );
    const bars = Array.from(container.querySelectorAll("svg rect")).filter(
      (rect) => rect.closest("pattern") === null,
    );
    // 10 bins plus a hatched underflow and overflow bar at either end.
    assert.equal(bars.length, 12);
    assert.equal(bars[0].getAttribute("data-overflow"), "true");
    assert.equal(bars[11].getAttribute("data-overflow"), "true");
    for (const bar of bars) {
      const x = Number(bar.getAttribute("x"));
      const width = Number(bar.getAttribute("width"));
      assert.ok(x >= 0 && x + width <= 320 + 0.01, "bar stays inside the card");
    }
    const labels = Array.from(container.querySelectorAll("svg text"), (t) => t.textContent);
    assert.ok(
      labels.some((label) => label?.startsWith("< ")),
      "underflow axis label",
    );
  });

  it("keeps a fill pie's legend inside a narrow card", () => {
    stubLayout(160, 240);
    const { container } = render(
      createElement(ChartView, {
        result: computeChart(rows(), { type: "pie", category: "kind" }),
        fill: true,
      }),
    );
    const legend = Array.from(container.querySelectorAll("svg text"));
    assert.ok(legend.length > 0, "legend rendered");
    for (const text of legend) {
      const x = Number(text.getAttribute("x"));
      const drawn = text.firstChild?.textContent ?? "";
      // The text, share included, ends at the 4px inset from the right edge.
      assert.ok(x + approximateTextWidth(drawn) <= 156 + 0.01, `"${drawn}" overflows the card`);
    }
  });
});
