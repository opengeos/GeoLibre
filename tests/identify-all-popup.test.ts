import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  createGlobalIdentifyPopupElement,
  DEFAULT_IDENTIFY_ALL_LABELS,
  type GlobalIdentifyHit,
} from "../packages/map/src/identify-all-popup";
import {
  createIdentifyEditActionsElement,
  type MapCanvasIdentifyEditActions,
} from "../packages/map/src/identify-edit-actions";
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

describe("Identify edit actions (#2932)", () => {
  function editActions(editable: Set<string>) {
    const calls: string[] = [];
    const actions: MapCanvasIdentifyEditActions = {
      canEditGeometry: (layer) => editable.has(layer.id),
      canEditAttributes: (layer) => editable.has(layer.id),
      editGeometry: ({ layer, featureId }) => calls.push(`geometry:${layer.id}:${featureId}`),
      editAttributes: ({ layer, featureId }) => calls.push(`attributes:${layer.id}:${featureId}`),
    };
    return { actions, calls };
  }

  it("offers edit buttons only on editable layers' features with an id", () => {
    withDocument();
    const cities = geojsonLayer({ id: "cities", name: "Cities" });
    const tiles = geojsonLayer({ id: "tiles", name: "Tiles" });
    const { actions, calls } = editActions(new Set(["cities"]));
    let closed = 0;
    const root = createGlobalIdentifyPopupElement(
      [
        { layer: cities, properties: { name: "Tulsa" }, featureId: "87" },
        { layer: cities, properties: { name: "Unknown" }, featureId: null },
        { layer: tiles, properties: { name: "Read-only" }, featureId: "3" },
      ],
      6,
      () => {},
      DEFAULT_IDENTIFY_ALL_LABELS,
      undefined,
      actions,
      () => {
        closed += 1;
      },
    );
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-identify-edit-action]")];
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ["Edit geometry", "Edit attributes"],
    );
    // The row sits above the attribute rows, so long attribute lists cannot
    // push it out of view.
    const editRow = buttons[0].parentElement!;
    assert.equal(editRow.previousElementSibling?.textContent, "Feature 1");
    assert.match(editRow.nextElementSibling?.textContent ?? "", /name\s*Tulsa/);
    buttons[0].dispatchEvent(new window.Event("click"));
    buttons[1].dispatchEvent(new window.Event("click"));
    assert.deepEqual(calls, ["geometry:cities:87", "attributes:cities:87"]);
    assert.equal(closed, 2);
  });

  it("draws no edit row when the host passes no actions", () => {
    withDocument();
    const cities = geojsonLayer({ id: "cities", name: "Cities" });
    const root = createGlobalIdentifyPopupElement(
      [{ layer: cities, properties: { name: "Tulsa" }, featureId: "87" }],
      6,
      () => {},
      DEFAULT_IDENTIFY_ALL_LABELS,
    );
    assert.equal(root.querySelector(".geolibre-identify-edit-actions"), null);
  });

  it("builds a single result's row with only the actions its layer allows", () => {
    withDocument();
    const cities = geojsonLayer({ id: "cities", name: "Cities" });
    const { actions } = editActions(new Set(["cities"]));
    const row = createIdentifyEditActionsElement(
      cities,
      "87",
      { ...actions, canEditGeometry: () => false },
      DEFAULT_IDENTIFY_ALL_LABELS,
    );
    assert.equal(row?.textContent, "Edit attributes");
    assert.equal(
      createIdentifyEditActionsElement(cities, null, actions, DEFAULT_IDENTIFY_ALL_LABELS),
      null,
    );
  });
});
