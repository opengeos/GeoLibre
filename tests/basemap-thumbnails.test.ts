import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { BasemapControl, type BasemapDefinition } from "maplibre-gl-basemap-control";
import {
  BASEMAP_PANEL_SELECTOR,
  BASEMAP_ROW_ID_ATTR,
  BASEMAP_ROW_SELECTOR,
  rasterPreviewUrl,
  styleUrlOf,
} from "../packages/plugins/src/plugins/basemap-thumbnails";

function raster(tiles: string[]): BasemapDefinition {
  return {
    id: "osm",
    name: "OSM",
    provider: "osm",
    type: "raster",
    source: { type: "raster", tiles },
  };
}

function style(url: string): BasemapDefinition {
  return {
    id: "positron",
    name: "Positron",
    provider: "openfreemap",
    type: "style",
    source: { type: "style", url },
  };
}

describe("basemap preview urls", () => {
  it("fills z/x/y/s on a raster template", () => {
    assert.equal(
      rasterPreviewUrl(raster(["https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"])),
      "https://a.tile.openstreetmap.org/2/1/1.png",
    );
  });

  it("skips rasters that still need a key", () => {
    assert.equal(
      rasterPreviewUrl(raster(["https://tiles.example/{z}/{x}/{y}.png?key={api-key}"])),
      null,
    );
  });

  it("keeps a keyless style url and skips keyed ones", () => {
    assert.equal(
      styleUrlOf(style("https://tiles.openfreemap.org/styles/positron")),
      "https://tiles.openfreemap.org/styles/positron",
    );
    assert.equal(
      styleUrlOf(style("https://api.maptiler.com/maps/basic/style.json?key={key}")),
      null,
    );
  });

  it("skips any placeholder it does not substitute itself", () => {
    // The control substitutes {api-key}/{aws-region} from the user's
    // credentials; a preview must not request a URL that still carries one, nor
    // a tile scheme rasterPreviewUrl leaves unresolved.
    assert.equal(
      styleUrlOf(
        style("https://maps.geo.{aws-region}.amazonaws.com/v2/styles/Standard/descriptor"),
      ),
      null,
    );
    assert.equal(rasterPreviewUrl(raster(["https://tiles.example/{quadkey}.png"])), null);
    assert.equal(rasterPreviewUrl(raster(["https://tiles.example/{z}/{x}/{-y}.png"])), null);
  });

  it("ignores the other source kind", () => {
    assert.equal(rasterPreviewUrl(style("https://tiles.openfreemap.org/styles/positron")), null);
    assert.equal(styleUrlOf(raster(["https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"])), null);
  });
});

/**
 * `BASEMAP_PANEL_SELECTOR` / `BASEMAP_ROW_SELECTOR` / `BASEMAP_ROW_ID_ATTR`
 * mirror DOM that `maplibre-gl-basemap-control` renders but does not export, so
 * nothing but this file notices if a bump renames one — the queries would just
 * stop matching and thumbnails would silently stop appearing. Rather than
 * restate the strings, this builds a real `BasemapControl` and asks it for its
 * rendered panel.
 */
describe("the maplibre-gl-basemap-control DOM mirror", () => {
  let restoreGlobals: () => void;

  beforeEach(() => {
    const { document, window } = parseHTML("<html><body></body></html>");
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      requestAnimationFrame: globalThis.requestAnimationFrame,
    };
    // The control assigns `select.value`, which linkedom exposes as a getter
    // only. Give it a setter so its filter row renders.
    const selectValue = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    );
    Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
      configurable: true,
      get: selectValue?.get,
      set(next: string) {
        this.setAttribute("value", next);
      },
    });
    Object.assign(globalThis, {
      document,
      window,
      // linkedom ships no rAF; the control only uses it to position the panel.
      requestAnimationFrame: () => 0,
    });
    restoreGlobals = () => Object.assign(globalThis, previous);
  });

  afterEach(() => restoreGlobals());

  it("matches the panel, the rows and the row id attribute", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const control = new BasemapControl({ collapsed: false });
    control.onAdd({
      getContainer: () => container,
      on: () => {},
      off: () => {},
    } as never);

    const panel = container.querySelector(BASEMAP_PANEL_SELECTOR);
    assert.ok(panel, `no ${BASEMAP_PANEL_SELECTOR} — the control renamed its panel`);
    const rows = [...panel.querySelectorAll(BASEMAP_ROW_SELECTOR)];
    assert.ok(rows.length > 0, `no ${BASEMAP_ROW_SELECTOR} rows — the control renamed its rows`);

    // `enhance` joins a row back to its catalog entry through this attribute,
    // so the ids the rows carry must be ids `getBasemaps()` reports.
    const catalog = new Set(control.getBasemaps().map((basemap) => basemap.id));
    const ids = rows.map((row) => row.getAttribute(BASEMAP_ROW_ID_ATTR));
    assert.ok(
      ids.every((id) => id !== null && catalog.has(id)),
      `rows no longer join the catalog through ${BASEMAP_ROW_ID_ATTR}`,
    );
  });
});
