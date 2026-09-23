import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  createGlobalIdentifyPopupElement,
  DEFAULT_IDENTIFY_ALL_LABELS,
  type GlobalIdentifyHit,
} from "../packages/map/src/identify-all-popup";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The grouped "Identify visible layers" popup is shared by the MapLibre and
// Mapbox canvases, so both engines show the same chooser (#2475).
const original = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLAnchorElement: globalThis.HTMLAnchorElement,
  HTMLElement: globalThis.HTMLElement,
};
afterEach(() => {
  Object.assign(globalThis, original);
});

function withDocument() {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, {
    window,
    document,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLElement: window.HTMLElement,
  });
  return document;
}

describe("createGlobalIdentifyPopupElement", () => {
  it("groups hits by layer, counts them, and activates the clicked hit", () => {
    withDocument();
    const cities = geojsonLayer({ id: "cities", name: "Cities" });
    const countries = geojsonLayer({ id: "countries", name: "Countries" });
    const hits: GlobalIdentifyHit[] = [
      { layer: cities, properties: { name: "Tulsa" }, featureId: "87" },
      { layer: cities, properties: { name: "Broken Arrow" }, featureId: "88" },
      { layer: countries, properties: { name: "United States" }, featureId: "167" },
    ];
    const activated: GlobalIdentifyHit[] = [];
    const root = createGlobalIdentifyPopupElement(
      hits,
      6,
      (hit) => activated.push(hit),
      DEFAULT_IDENTIFY_ALL_LABELS,
    );
    assert.match(root.textContent ?? "", /Identified results \(3\)/);
    const summaries = [...root.querySelectorAll("summary")];
    assert.deepEqual(
      summaries.map((summary) => summary.textContent),
      ["Cities2 results", "Countries1 result"],
    );
    summaries[1].dispatchEvent(new window.Event("click"));
    assert.equal(activated[0]?.featureId, "167");
    const featureButtons = [...root.querySelectorAll("button")].filter((button) =>
      /^Feature \d$/.test(button.textContent ?? ""),
    );
    featureButtons[1].dispatchEvent(new window.Event("click"));
    assert.equal(activated[1]?.featureId, "88");
  });
});
