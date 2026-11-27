import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { ComparePin } from "../packages/core/src/compare";
import { DEFAULT_COMPARE_TOOLTIP_LABELS } from "../packages/map/src/compare-tooltip";
import { createHoverTooltipElement } from "../packages/map/src/feature-popup";

const original = { window: globalThis.window, document: globalThis.document };
beforeEach(() => {
  const { window, document } = parseHTML('<html lang="en-US"><body></body></html>');
  Object.assign(globalThis, { window, document });
});
afterEach(() => {
  Object.assign(globalThis, original);
});

const pin: ComparePin = {
  layerId: "parcels",
  featureId: "12",
  properties: { lot: "12", use: "Residential", assessed: 250000, zone: "R-1" },
};
const compare = { pin, labels: DEFAULT_COMPARE_TOOLTIP_LABELS };

/** Each differing field's line as [label, value, difference]. */
function lines(root: HTMLElement): string[][] {
  return [...root.querySelectorAll(".grid")].map((line) =>
    [...line.children].map((cell) => cell.textContent ?? ""),
  );
}

describe("the compare hover tooltip", () => {
  it("shows the differing fields under what they are compared with", () => {
    const root = createHoverTooltipElement(
      "Parcels",
      { lot: "13", use: "Commercial", assessed: 292000, zone: "R-1" },
      { compare },
    )!;
    const text = [...root.children].map((child) => child.textContent);
    assert.equal(text[0], "Parcels");
    assert.equal(text[1], "Compared with the pinned feature");
    assert.deepEqual(lines(root), [
      ["lot", "13", "pinned: 12"],
      ["use", "Commercial", "pinned: Residential"],
      ["assessed", "292000", "+42,000"],
    ]);
    assert.equal(text.at(-1), "1 field the same");
  });

  it("names the pinned feature by the layer's popup title", () => {
    const root = createHoverTooltipElement(
      "Parcels",
      { lot: "13", use: "Residential", assessed: 250000, zone: "R-1" },
      { compare, popup: { titleField: "lot" } },
    )!;
    assert.equal(root.children[0].textContent, "13");
    assert.equal(root.children[1].textContent, "Compared with 12");
  });

  it("says so when the hovered feature matches in every field", () => {
    const root = createHoverTooltipElement("Parcels", { ...pin.properties }, { compare })!;
    assert.equal(lines(root).length, 0);
    assert.equal(root.lastElementChild?.textContent, "Same as the pinned feature in every field");
  });

  it("shows a comparison even where the layer has no hover fields", () => {
    // Without the pin, a layer with no hover fields shows no tip at all.
    assert.equal(
      createHoverTooltipElement("Parcels", { lot: "13" }, { popup: { hover: true } }),
      null,
    );
    assert.ok(
      createHoverTooltipElement("Parcels", { lot: "13" }, { popup: { hover: true }, compare }),
    );
  });

  it("marks a value one side lacks", () => {
    const root = createHoverTooltipElement(
      "Parcels",
      { ...pin.properties, note: "corner" },
      { compare },
    )!;
    assert.deepEqual(lines(root), [["note", "corner", "pinned: (none)"]]);
  });
});
