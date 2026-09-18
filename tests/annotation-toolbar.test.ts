import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { IControl } from "maplibre-gl";
import {
  maplibreAnnotationsPlugin,
  setAnnotationLabels,
} from "../packages/plugins/src/plugins/maplibre-annotations";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("annotation toolbar collapse toggle", () => {
  let restoreGlobals: () => void;
  let control: IControl | null;
  let app: GeoLibreAppAPI;

  beforeEach(() => {
    const { document, window } = parseHTML("<html><body></body></html>");
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { document, window });
    restoreGlobals = () => {
      Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    };

    control = null;
    app = {
      addMapControl: (nextControl) => {
        control = nextControl;
        return true;
      },
      removeMapControl: (removedControl) => removedControl.onRemove(),
      getMap: () => null,
    } as GeoLibreAppAPI;

    setAnnotationLabels({ collapse: "Collapse toolbar", expand: "Expand toolbar" });
    maplibreAnnotationsPlugin.activate(app);
  });

  afterEach(() => {
    maplibreAnnotationsPlugin.deactivate(app);
    restoreGlobals();
  });

  it("folds to one accessible button and expands again", () => {
    assert.ok(control);
    const container = control.onAdd(null as never);
    const toggle = container.querySelector<HTMLButtonElement>(".geolibre-annotations-collapse");
    const tools = container.querySelector<HTMLElement>(".geolibre-annotations-tools");
    const textTool = container.querySelector<HTMLButtonElement>(".geolibre-annotations-tool");
    assert.ok(toggle);
    assert.ok(tools);
    assert.ok(textTool);

    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Collapse toolbar");
    assert.ok(tools.id, "Tools region must have an id");
    assert.equal(toggle.getAttribute("aria-controls"), tools.id);
    assert.equal(tools.hidden, false);

    textTool.click();
    assert.equal(textTool.classList.contains("is-active"), true);
    toggle.click();

    assert.equal(container.classList.contains("is-collapsed"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Expand toolbar");
    assert.equal(tools.hidden, true);
    assert.equal(textTool.classList.contains("is-active"), false);

    toggle.click();
    assert.equal(container.classList.contains("is-collapsed"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.getAttribute("aria-label"), "Collapse toolbar");
    assert.equal(tools.hidden, false);
  });
});
