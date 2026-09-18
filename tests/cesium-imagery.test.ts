import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { basemapToCesiumImagery, sameCesiumImagery } from "../packages/core/src/cesium-imagery";
import { PLANETARY_BASEMAPS } from "../packages/core/src/ellipsoids";
import { REGIONAL_BASEMAPS } from "../packages/core/src/regional-basemaps";
import { BLANK_BASEMAP, DEFAULT_BASEMAP } from "../packages/core/src/types";

// Verifies the basemap → globe-imagery mapping that lets a Cesium pane render
// the project's basemap instead of a hardcoded Ion / OpenStreetMap layer. The
// mapping is pure, so this needs no Cesium and no DOM.

/** Narrow to the xyz variant, failing the test when it isn't one. */
function asXyz(imagery: ReturnType<typeof basemapToCesiumImagery>) {
  assert.equal(imagery.kind, "xyz");
  // The equal() above is the assertion; this cast just gives the fields back.
  return imagery as Extract<typeof imagery, { kind: "xyz" }>;
}

describe("basemapToCesiumImagery", () => {
  it("draws nothing for the blank basemap", () => {
    assert.deepEqual(basemapToCesiumImagery(BLANK_BASEMAP), { kind: "none" });
  });

  it("maps each OpenFreeMap style to a raster analogue of the same tone", () => {
    const tone = (style: string) => asXyz(basemapToCesiumImagery(style)).template;
    const liberty = tone("https://tiles.openfreemap.org/styles/liberty");
    const bright = tone("https://tiles.openfreemap.org/styles/bright");
    const positron = tone("https://tiles.openfreemap.org/styles/positron");
    const dark = tone("https://tiles.openfreemap.org/styles/dark");
    const fiord = tone("https://tiles.openfreemap.org/styles/fiord");

    // Same tone → same analogue; different tone → different analogue. Asserting
    // the relationships rather than the URLs keeps the test from breaking when
    // a provider endpoint changes.
    assert.equal(liberty, bright);
    assert.equal(dark, fiord);
    assert.notEqual(liberty, positron);
    assert.notEqual(positron, dark);
  });

  it("maps Protomaps flavors by tone, keyed on the flavor path segment", () => {
    const flavor = (name: string) =>
      asXyz(
        basemapToCesiumImagery(`https://api.protomaps.com/styles/v5/${name}/en.json?key=abc123`),
      ).template;

    assert.equal(flavor("light"), flavor("white"));
    assert.equal(flavor("light"), flavor("grayscale"));
    assert.equal(flavor("dark"), flavor("black"));
    assert.notEqual(flavor("light"), flavor("dark"));
  });

  it("does not mistake an API key containing a tone word for the flavor", () => {
    // The key is matched nowhere: only the flavor path segment decides the tone.
    const light = asXyz(
      basemapToCesiumImagery("https://api.protomaps.com/styles/v5/light/en.json?key=dark-key"),
    );
    const dark = asXyz(
      basemapToCesiumImagery("https://api.protomaps.com/styles/v5/dark/en.json?key=dark-key"),
    );
    assert.notEqual(light.template, dark.template);
  });

  it("carries a planetary basemap's own tiles, scheme, and credit through", () => {
    const planetary = PLANETARY_BASEMAPS.find((b) => b.scheme === "tms");
    assert.ok(planetary, "expected at least one TMS planetary basemap");
    const imagery = asXyz(basemapToCesiumImagery(planetary.styleUrl));
    assert.equal(imagery.template, planetary.tileUrl);
    assert.equal(imagery.scheme, "tms");
    assert.equal(imagery.maximumLevel, planetary.maxZoom);
    assert.equal(imagery.attribution, planetary.attribution);
  });

  it("carries a regional basemap's hybrid overlay through", () => {
    const hybrid = REGIONAL_BASEMAPS.find((b) => b.overlayTileUrl);
    assert.ok(hybrid, "expected at least one regional basemap with an overlay");
    const imagery = asXyz(basemapToCesiumImagery(hybrid.styleUrl));
    assert.equal(imagery.template, hybrid.tileUrl);
    assert.equal(imagery.overlayTemplate, hybrid.overlayTileUrl);
    assert.equal(imagery.attribution, hybrid.attribution);
  });

  it("omits the overlay for a regional basemap without one", () => {
    const plain = REGIONAL_BASEMAPS.find((b) => !b.overlayTileUrl);
    assert.ok(plain, "expected at least one regional basemap without an overlay");
    assert.equal(asXyz(basemapToCesiumImagery(plain.styleUrl)).overlayTemplate, undefined);
  });

  it("defers to the renderer for a style it has no raster analogue for", () => {
    // A provider style, a Mapbox style, and a user's own URL all land here, so
    // the globe can fall back to Ion imagery when a token is configured.
    assert.deepEqual(basemapToCesiumImagery("https://example.com/styles/custom.json"), {
      kind: "default",
    });
    assert.deepEqual(
      basemapToCesiumImagery("https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=x"),
      { kind: "default" },
    );
  });

  it("defers for an unparseable style URL rather than throwing", () => {
    assert.deepEqual(basemapToCesiumImagery("not a url"), { kind: "default" });
  });

  it("defers for a malformed percent-escape in the flavor rather than throwing", () => {
    // A URL keeps `%E0%A4` in its pathname, but decoding it throws URIError.
    // This runs inside a render, so it has to degrade rather than blow up.
    assert.deepEqual(
      basemapToCesiumImagery("https://api.protomaps.com/styles/v5/%E0%A4/en.json?key=abc"),
      { kind: "default" },
    );
  });

  it("still resolves a percent-encoded flavor that decodes cleanly", () => {
    const encoded = basemapToCesiumImagery("https://api.protomaps.com/styles/v5/%64ark/en.json");
    assert.deepEqual(
      encoded,
      basemapToCesiumImagery("https://api.protomaps.com/styles/v5/dark/en.json"),
    );
  });

  it("falls back to the default basemap for a sentinel that no longer resolves", () => {
    // Mirrors resolveMapStyle: an unknown geolibre:// sentinel must never reach
    // the renderer as if it were a fetchable tile URL.
    const expected = basemapToCesiumImagery(DEFAULT_BASEMAP);
    assert.deepEqual(basemapToCesiumImagery("geolibre://basemap/mars-was-renamed"), expected);
    assert.deepEqual(basemapToCesiumImagery("geolibre://regional-basemap/gone"), expected);
    assert.deepEqual(basemapToCesiumImagery("geolibre://offline-basemap/session-key"), expected);
  });

  it("treats an absent basemap as the default one", () => {
    assert.deepEqual(basemapToCesiumImagery(undefined), basemapToCesiumImagery(DEFAULT_BASEMAP));
  });

  it("gives every raster analogue a credit and a zoom ceiling", () => {
    const imagery = asXyz(basemapToCesiumImagery(DEFAULT_BASEMAP));
    assert.match(imagery.template, /\{z\}.*\{x\}.*\{y\}/);
    assert.ok(imagery.attribution.length > 0);
    assert.ok((imagery.maximumLevel ?? 0) > 0);
  });
});

describe("sameCesiumImagery", () => {
  const OFM = "https://tiles.openfreemap.org/styles/";

  it("matches two basemaps that resolve to the same analogue", () => {
    // Liberty and Bright are distinct styles sharing the streets tone, so the
    // descriptors are equal but not identical — the case a `===` guard misses.
    const liberty = basemapToCesiumImagery(`${OFM}liberty`);
    const bright = basemapToCesiumImagery(`${OFM}bright`);
    assert.notEqual(liberty, bright, "expected distinct descriptor objects");
    assert.equal(sameCesiumImagery(liberty, bright), true);
  });

  it("separates analogues of different tones", () => {
    assert.equal(
      sameCesiumImagery(
        basemapToCesiumImagery(`${OFM}liberty`),
        basemapToCesiumImagery(`${OFM}dark`),
      ),
      false,
    );
  });

  it("compares the fieldless kinds by kind alone", () => {
    assert.equal(sameCesiumImagery({ kind: "none" }, { kind: "none" }), true);
    assert.equal(sameCesiumImagery({ kind: "default" }, { kind: "default" }), true);
    assert.equal(sameCesiumImagery({ kind: "none" }, { kind: "default" }), false);
    assert.equal(
      sameCesiumImagery({ kind: "none" }, basemapToCesiumImagery(DEFAULT_BASEMAP)),
      false,
    );
  });

  it("notices a difference in any xyz field", () => {
    const base = asXyz(basemapToCesiumImagery(DEFAULT_BASEMAP));
    assert.equal(
      sameCesiumImagery(base, { ...base, template: "https://x/{z}/{x}/{y}.png" }),
      false,
    );
    assert.equal(sameCesiumImagery(base, { ...base, maximumLevel: 3 }), false);
    assert.equal(sameCesiumImagery(base, { ...base, scheme: "tms" }), false);
    assert.equal(sameCesiumImagery(base, { ...base, attribution: "other" }), false);
    assert.equal(
      sameCesiumImagery(base, { ...base, overlayTemplate: "https://o/{z}/{x}/{y}.png" }),
      false,
    );
  });
});
