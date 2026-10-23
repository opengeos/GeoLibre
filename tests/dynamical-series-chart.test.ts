import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { renderSeriesChart } =
  await import("../packages/plugins/src/plugins/dynamical-series-chart");

const HOUR = 3_600_000;
const start = Date.UTC(2026, 9, 8, 0);

const labels = {
  value: "degree_Celsius",
  mean: "Ensemble mean",
  range: "Member range",
  shown: "The step shown on the map",
  description: "Time series of 2 metre temperature",
};

function mount(): HTMLElement {
  const container = document.createElement("div");
  // happy-dom does no layout: give the chart a width to draw at.
  Object.defineProperty(container, "clientWidth", { value: 320 });
  document.body.append(container);
  return container;
}

describe("renderSeriesChart", () => {
  it("draws a single series as one line, with no legend", () => {
    const container = mount();
    const steps = [10, 12, Number.NaN, 15].map((value, index) => ({
      time: start + index * HOUR,
      value,
    }));
    const stop = renderSeriesChart(container, { steps, currentIndex: 1, labels });
    const svg = container.querySelector("svg");
    assert.ok(svg);
    assert.equal(svg.getAttribute("aria-label"), labels.description);
    // The line breaks at the missing step: two subpaths.
    const line = [...svg.querySelectorAll("path")].find(
      (path) => path.getAttribute("stroke-width") === "2",
    );
    assert.equal(line?.getAttribute("d")?.match(/M/g)?.length, 2);
    // No range wash and no legend for one series.
    assert.equal(svg.querySelectorAll("path[fill-opacity]").length, 0);
    assert.equal(container.children.length, 1);
    stop();
    container.remove();
  });

  it("draws an ensemble's range under its mean, with a legend", () => {
    const container = mount();
    const steps = [0, 1, 2].map((index) => ({
      time: start + index * 6 * HOUR,
      value: index,
      min: index - 1,
      max: index + 1,
    }));
    renderSeriesChart(container, { steps, currentIndex: 0, labels });
    assert.equal(container.querySelectorAll("path[fill-opacity]").length, 1);
    const legend = container.children[1];
    assert.match(legend?.textContent ?? "", /Ensemble mean.*Member range/);
    container.remove();
  });

  it("reads values from the keyboard and picks a step with Enter", () => {
    const container = mount();
    const steps = [1.5, 2.5, 3.5].map((value, index) => ({ time: start + index * HOUR, value }));
    const picked: number[] = [];
    renderSeriesChart(container, {
      steps,
      currentIndex: 2,
      labels,
      onPick: (index) => picked.push(index),
    });
    const svg = container.querySelector("svg") as SVGSVGElement;
    svg.dispatchEvent(new Event("focus"));
    const tooltip = svg.nextElementSibling as HTMLElement;
    assert.equal(tooltip.style.display, "block");
    assert.match(tooltip.textContent ?? "", /3\.5/);
    svg.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    assert.match(tooltip.textContent ?? "", /2\.5/);
    svg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    assert.deepEqual(picked, [1]);
    container.remove();
  });
});
