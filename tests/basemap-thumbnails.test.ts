import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { BasemapControl, type BasemapDefinition } from "maplibre-gl-basemap-control";
import {
  BASEMAP_PANEL_SELECTOR,
  BASEMAP_ROW_ID_ATTR,
  BASEMAP_ROW_SELECTOR,
  advances,
  installBasemapThumbnails,
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

function tmsRaster(tiles: string[]): BasemapDefinition {
  return { ...raster(tiles), source: { type: "raster", tiles, scheme: "tms" } };
}

function styleBasemap(url: string): BasemapDefinition {
  return {
    id: "positron",
    name: "Positron",
    provider: "openfreemap",
    type: "style",
    source: { type: "style", url },
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

  it("flips the row index for a tms source", () => {
    // Tencent's basemaps number rows from the bottom; an xyz row index would
    // preview the vertically mirrored tile.
    assert.equal(
      rasterPreviewUrl(tmsRaster(["https://tiles.example/tile?z={z}&x={x}&y={y}"])),
      "https://tiles.example/tile?z=2&x=1&y=2",
    );
  });

  it("skips a style url carrying any placeholder at all", () => {
    // A style URL is fetched verbatim, so even a tile token nothing substitutes
    // for it makes the URL unusable.
    assert.equal(styleUrlOf(style("https://{s}.example.com/style.json")), null);
  });

  it("never previews a url carrying a configured credential", () => {
    // Previews fire on scroll, not on an explicit pick, so they must never
    // reach a keyed endpoint and spend the user's quota. The control keeps the
    // catalog's raw `{api-key}`/`{aws-region}` templates and only substitutes
    // when a basemap is actually applied, so `hasUnresolvedPlaceholder` rejects
    // every keyed entry. This fails if that ever stops being true.
    const secrets = {
      mapboxAccessToken: "SECRET-MAPBOX",
      maptilerApiKey: "SECRET-MAPTILER",
      googleMapsApiKey: "SECRET-GOOGLE",
      tomtomApiKey: "SECRET-TOMTOM",
      hereApiKey: "SECRET-HERE",
      stadiaApiKey: "SECRET-STADIA",
      tiandituApiKey: "SECRET-TIANDITU",
      amazonApiKey: "SECRET-AMAZON",
      protomapsApiKey: "SECRET-PROTOMAPS",
    };
    const control = new BasemapControl({ ...secrets, amazonRegion: "us-east-1" } as never);
    for (const basemap of control.getBasemaps()) {
      const url = rasterPreviewUrl(basemap) ?? styleUrlOf(basemap);
      if (!url) continue;
      for (const secret of Object.values(secrets)) {
        assert.ok(!url.includes(secret), `${basemap.id} would preview with a credential: ${url}`);
      }
    }
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
describe("the preview state rank", () => {
  it("only ever moves a row forward", () => {
    // The swatch and the snapshot resolve independently, so a slow flat-colour
    // swatch must not overwrite a row already showing the real render.
    assert.equal(advances("ready", "loaded"), true);
    assert.equal(advances("loaded", "ready"), false);
    assert.equal(advances("pending", "ready"), true);
    assert.equal(advances("ready", "pending"), false);
    assert.equal(advances("loaded", "loaded"), false, "a repaint at the same state is a no-op");
  });

  it("paints a row that has no state yet, and can revive a skipped one", () => {
    assert.equal(advances(null, "pending"), true);
    // markSkipped drops a row that produced nothing; a snapshot arriving later
    // still gets to fill it in.
    assert.equal(advances("skip", "loaded"), true);
    assert.equal(advances("skip", "ready"), true);
  });
});

describe("the maplibre-gl-basemap-control DOM mirror", () => {
  let restoreGlobals: () => void;

  beforeEach(() => {
    const { document, window } = parseHTML("<html><body></body></html>");
    const previous = {
      document: globalThis.document,
      window: globalThis.window,
      MutationObserver: globalThis.MutationObserver,
      IntersectionObserver: globalThis.IntersectionObserver,
      requestAnimationFrame: globalThis.requestAnimationFrame,
      CSS: (globalThis as { CSS?: unknown }).CSS,
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
      MutationObserver: window.MutationObserver,
      // linkedom ships no rAF; the control only uses it to position the panel.
      requestAnimationFrame: () => 0,
      // Nor `CSS.escape`, which `rowSelector` uses to build its attribute
      // selector. Basemap ids are kebab-case, so escaping anything else is
      // enough for these tests.
      CSS: { escape: (value: string) => value.replace(/[^\w-]/g, (ch) => `\\${ch}`) },
    });
    restoreGlobals = () => Object.assign(globalThis, previous);
  });

  afterEach(() => restoreGlobals());

  /** A map stub with the surface `BasemapControl.onAdd`/`onRemove` touch. */
  function fakeMap(container: HTMLElement) {
    return { getContainer: () => container, on: () => {}, off: () => {} } as never;
  }

  it("matches the panel, the rows and the row id attribute", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const control = new BasemapControl({ collapsed: false });
    control.onAdd(fakeMap(container));

    const panel = container.querySelector(BASEMAP_PANEL_SELECTOR);
    assert.ok(panel, `no ${BASEMAP_PANEL_SELECTOR} — the control renamed its panel`);
    // `watchForPanel` observes the panel's parent to notice a rebuilt panel, so
    // the panel has to stay a direct child of the map container.
    assert.equal(panel.parentElement, container, "the panel is no longer a map-container child");
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

  it("re-finds the panel the control rebuilds when it is repositioned", async () => {
    // `setMapControlPosition` moves the control with a removeMapControl /
    // addMapControl pair, and `onAdd` builds a *fresh* panel each time. The
    // watch is anchored to the panel's parent — the map container, which the
    // control reuses — so both the removal and the insertion land on the node
    // it observes. Narrow that watch to the panel itself and thumbnails would
    // silently stop appearing after a reposition, with nothing else to catch it.
    const container = document.createElement("div");
    document.body.append(container);
    const control = new BasemapControl({
      collapsed: false,
      includeDefaultBasemaps: false,
      basemaps: [raster(["https://tiles.example/{z}/{x}/{y}.png"])],
    } as never);
    control.onAdd(fakeMap(container));
    const thumbnails = installBasemapThumbnails(control);
    const thumbnailCount = () => container.querySelectorAll(".geolibre-basemap-thumbnail").length;

    assert.equal(thumbnailCount(), 1, "the first panel was not enhanced");

    control.onRemove();
    control.onAdd(fakeMap(container));
    assert.equal(thumbnailCount(), 0, "expected a fresh, unenhanced panel");

    // MutationObserver callbacks are queued, not synchronous.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(thumbnailCount(), 1, "the rebuilt panel was never enhanced");
    thumbnails.dispose();
  });

  it("drops a style row to name-only when neither preview can be produced", async () => {
    // Neither preview path can succeed here: there is no canvas 2d context for
    // the swatch and no WebGL for the snapshot, which is exactly how a style
    // host that is unreachable behaves. Both have to degrade quietly to the
    // name-only row rather than reject or strand the placeholder.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    const fetched: string[] = [];
    Object.assign(globalThis, {
      fetch: (url: string) => {
        fetched.push(String(url));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ layers: [] }) });
      },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const control = new BasemapControl({
      collapsed: false,
      includeDefaultBasemaps: false,
      basemaps: [styleBasemap("https://tiles.example/style.json")],
    } as never);
    control.onAdd(fakeMap(container));
    const thumbnails = installBasemapThumbnails(control);

    const row = container.querySelector(BASEMAP_ROW_SELECTOR);
    assert.ok(row, "no row was rendered");
    assert.equal(fetched.length, 1, "the style json was not fetched");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      row.getAttribute("data-geolibre-basemap-preview"),
      "skip",
      "the row kept its placeholder instead of falling back to name-only",
    );
    assert.equal(container.querySelectorAll(".geolibre-basemap-thumbnail").length, 0);
    assert.deepEqual(rejections, [], "a failed preview rejected instead of resolving null");
    process.off("unhandledRejection", onRejection);
    thumbnails.dispose();
  });

  it("defers every preview request until the row is on screen", () => {
    // Opening the panel must not contact every provider in the catalog at once:
    // the raster tile and the style JSON are deferred the same way the full
    // snapshot always was.
    const observed: HTMLElement[] = [];
    let fire: (entries: IntersectionObserverEntry[]) => void = () => {};
    class FakeIntersectionObserver {
      constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
        fire = callback;
      }
      observe(target: HTMLElement) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    }
    Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver });

    const container = document.createElement("div");
    document.body.append(container);
    const control = new BasemapControl({
      collapsed: false,
      includeDefaultBasemaps: false,
      basemaps: [raster(["https://tiles.example/{z}/{x}/{y}.png"])],
    } as never);
    control.onAdd(fakeMap(container));
    const thumbnails = installBasemapThumbnails(control);
    const thumbnailCount = () => container.querySelectorAll(".geolibre-basemap-thumbnail").length;

    assert.equal(observed.length, 1, "the row was never observed");
    assert.equal(thumbnailCount(), 0, "the tile was requested before the row was visible");

    fire([{ isIntersecting: true, target: observed[0] } as unknown as IntersectionObserverEntry]);
    assert.equal(thumbnailCount(), 1, "the row was not previewed once visible");
    thumbnails.dispose();
  });
});
