import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE } from "@geolibre/core";
import { importStyleText, isQmlStyleXml } from "@geolibre/map/style-import";

/** A minimal SLD 1.0.0 carrying one polygon rule. */
const SLD = `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer><Name>test</Name><UserStyle><FeatureTypeStyle>
    <Rule><PolygonSymbolizer>
      <Fill><CssParameter name="fill">#ff8800</CssParameter></Fill>
    </PolygonSymbolizer></Rule>
  </FeatureTypeStyle></UserStyle></NamedLayer>
</StyledLayerDescriptor>`;

/** A minimal QGIS QML carrying one fill symbol. */
const QML = `<!DOCTYPE qgis>
<qgis version="3.34.0"><renderer-v2 type="singleSymbol"><symbols>
  <symbol type="fill" name="0"><layer class="SimpleFill"><Option type="Map">
    <Option name="color" type="QString" value="0,68,136,255"/>
  </Option></layer></symbol>
</symbols></renderer-v2></qgis>`;

/** A minimal Mapbox GL style carrying one fill layer. */
const MAPBOX = JSON.stringify({
  version: 8,
  layers: [{ id: "a", type: "fill", paint: { "fill-color": "#4ce600" } }],
});

// Exported rather than kept private because the Style Manager's library import sniffs XML the same
// way; two copies of this heuristic would drift and send the same document to different parsers.
describe("isQmlStyleXml tells the two XML dialects apart", () => {
  it("recognizes a QML by its qgis root", () => {
    assert.equal(isQmlStyleXml(QML), true);
  });

  // A QML fragment saved without the <qgis> wrapper is still a QML; QGIS's own "save style" writes
  // the renderer element as the root.
  it("recognizes a QML by a bare renderer-v2 root", () => {
    assert.equal(isQmlStyleXml('<renderer-v2 type="singleSymbol"></renderer-v2>'), true);
  });

  it("does not claim an SLD", () => {
    assert.equal(isQmlStyleXml(SLD), false);
  });

  // Substring matches would be wrong: an SLD naming a layer "qgis-export" is not a QML.
  it("matches the element, not the word", () => {
    assert.equal(isQmlStyleXml("<Name>qgis</Name>"), false);
  });
});

// The format is read off the content, not a file extension: a `.xml` can hold either XML dialect,
// so the caller cannot tell them apart and this is the only place that decides.
describe("importStyleText picks the format from the content", () => {
  for (const [label, text, colour] of [
    ["an SLD by its StyledLayerDescriptor root", SLD, "#ff8800"],
    ["a QML by its qgis/renderer-v2 root", QML, "#004488"],
    ["anything else as Mapbox GL JSON", MAPBOX, "#4ce600"],
  ] as const) {
    it(`reads ${label}`, () => {
      const result = importStyleText(text);

      assert.equal(result.ok, true, "the style was read");
      assert.equal(
        result.ok && result.apply({ ...DEFAULT_LAYER_STYLE }).fillColor,
        colour,
        "and the colour it carries reaches the layer",
      );
    });
  }

  // Leading whitespace is ordinary in a file written by a tool; it must not push an XML document
  // down the JSON path, where it would come back "invalid" rather than importing.
  it("looks past leading whitespace before deciding", () => {
    const result = importStyleText(`\n\n  ${SLD}`);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.apply({ ...DEFAULT_LAYER_STYLE }).fillColor, "#ff8800");
  });

  // Only the first character decides. A Mapbox style is free to carry `<` inside a label expression,
  // and reading that as XML would hand the whole document to the wrong parser.
  it("does not mistake a JSON style for XML over a stray angle bracket", () => {
    const result = importStyleText(
      JSON.stringify({
        version: 8,
        layers: [
          {
            id: "a",
            type: "fill",
            paint: { "fill-color": "#4ce600" },
            layout: { "text-field": "<= 5 m" },
          },
        ],
      }),
    );

    assert.equal(result.ok, true, "it is still read as JSON");
    assert.equal(result.ok && result.apply({ ...DEFAULT_LAYER_STYLE }).fillColor, "#4ce600");
  });
});

// Each caller renders its own note, so the reason has to say which of the two happened: the text
// was not a style at all, or it was one that says nothing this layer can wear.
describe("importStyleText separates unreadable text from an empty style", () => {
  it("calls text that is not a style invalid", () => {
    const result = importStyleText("not a style");

    assert.deepEqual(result, { ok: false, reason: "invalid", warnings: [] });
  });

  // `LayerPanel` guards on the picked file rather than its text specifically so an empty file still
  // reaches the parser and says so, instead of looking like the user cancelled the dialog.
  for (const [label, text] of [
    ["empty", ""],
    ["only whitespace", "   \n\t "],
  ] as const) {
    it(`calls ${label} text invalid, not a silent no-op`, () => {
      assert.deepEqual(importStyleText(text), { ok: false, reason: "invalid", warnings: [] });
    });
  }

  it("calls a style with nothing to apply a no-match", () => {
    const result = importStyleText(JSON.stringify({ version: 8, layers: [] }));

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "no-match");
  });

  // Only the Mapbox branch was exercised here at first; an SLD or QML whose match count check was
  // broken would have imported as a success and shown "Style imported." over an unchanged layer.
  for (const [label, text] of [
    ["an SLD with no rules", SLD.replace(/<Rule>[\s\S]*<\/Rule>/, "")],
    ["a QML with no symbols", QML.replace(/<symbol[\s\S]*<\/symbol>/, "")],
  ] as const) {
    it(`calls ${label} a no-match rather than a clean import`, () => {
      const result = importStyleText(text);

      assert.equal(result.ok, false, "an empty style is not something to apply");
      assert.equal(result.ok === false && result.reason, "no-match");
    });
  }

  it("carries the parser's own words when it had any", () => {
    const result = importStyleText(
      JSON.stringify({ version: 8, layers: [{ id: "a", type: "raster" }] }),
    );

    assert.equal(result.ok, false);
    assert.equal(
      typeof (result.ok === false ? result.warnings[0] : undefined),
      "string",
      "so the note can say why rather than a generic no-match",
    );
  });

  // Same field, same type, whether the read succeeded or not: how many of these fit on screen is
  // the caller's problem, and a headless caller applying a catalog's style wants all of them.
  it("always carries a warnings array, even when there was nothing to say", () => {
    const invalid = importStyleText("not a style");

    assert.equal(invalid.ok, false);
    assert.deepEqual(invalid.ok === false && invalid.warnings, []);
  });
});

// The patch merges onto whatever the layer wears now — the panel re-reads the store after its file
// dialog, so `apply` must not close over a style captured earlier.
describe("importStyleText returns a patch, not a whole style", () => {
  it("keeps settings the imported style says nothing about", () => {
    const base = { ...DEFAULT_LAYER_STYLE, minZoom: 7, labels: { ...DEFAULT_LAYER_STYLE.labels } };
    const result = importStyleText(MAPBOX);

    assert.equal(result.ok, true);
    const applied = result.ok ? result.apply(base) : base;
    assert.equal(applied.fillColor, "#4ce600", "the imported colour lands");
    assert.equal(applied.minZoom, 7, "and the layer keeps what the style did not mention");
  });

  // The panel appends these to its success note, so a style that half-imported still says so. Lose
  // them and the import claims to have worked in full.
  it("carries the warnings a style earned while still importing", () => {
    const result = importStyleText(
      JSON.stringify({
        version: 8,
        layers: [
          { id: "a", type: "fill", paint: { "fill-color": "#4ce600" } },
          { id: "b", type: "fill", paint: { "fill-color": ["get", "colour"] } },
        ],
      }),
    );

    assert.equal(result.ok, true);
    const warnings = result.ok ? result.warnings : [];
    assert.equal(warnings.length, 1, "the note can say what was left behind");
    assert.match(warnings[0]!, /multiple fill layers/);
  });

  // The panel hands `apply` the live store object. Mutating it in place would edit a layer's style
  // behind the store's back, so every format has to build a new one.
  for (const [label, text] of [
    ["Mapbox GL", MAPBOX],
    ["SLD", SLD],
    ["QML", QML],
  ] as const) {
    it(`leaves the style a ${label} import was given untouched`, () => {
      const base = { ...DEFAULT_LAYER_STYLE, fillColor: "#123456" };
      const before = JSON.stringify(base);
      const result = importStyleText(text);

      assert.equal(result.ok, true);
      const applied = result.ok ? result.apply(base) : base;
      assert.notEqual(applied, base, "a fresh object, not the one passed in");
      assert.equal(JSON.stringify(base), before, "and the caller's style is unchanged");
    });
  }
});

// `isQmlStyleXml` accepts a bare `<renderer-v2>` root, so `parseQml` must read one. A fragment
// copied out of a .qml carries no `<qgis>` wrapper, and the paste box is how it arrives.
describe("a QML fragment with no <qgis> wrapper", () => {
  const RENDERER =
    `<renderer-v2 type="singleSymbol"><symbols><symbol type="line" name="0">` +
    `<layer class="SimpleLine"><Option type="Map">` +
    `<Option name="line_color" type="QString" value="230,0,0,255"/>` +
    `<Option name="line_width" type="QString" value="1"/>` +
    `</Option></layer></symbol></symbols></renderer-v2>`;

  const LABELING =
    `<labeling type="simple"><settings>` +
    `<text-style fieldName="name" textColor="17,17,17,255"/>` +
    `<placement placement="1"/></settings></labeling>`;

  // Every root `parseQml` reads has to be a root `isQmlStyleXml` claims. A root it accepts but the
  // detection misses goes to the SLD parser and comes back as no-match.
  for (const [label, fragment] of [
    ["renderer", RENDERER],
    ["labeling", LABELING],
  ] as const) {
    it(`routes a bare ${label} fragment to the QML parser`, () => {
      assert.ok(isQmlStyleXml(fragment), "the detection claims this root");
      assert.ok(importStyleText(fragment).ok, "and the parser reads it");
    });
  }

  it("reads the bare renderer the same as the wrapped one", () => {
    const bare = importStyleText(RENDERER);
    const wrapped = importStyleText(`<qgis>${RENDERER}</qgis>`);

    assert.ok(bare.ok, "a bare renderer-v2 root is a QML this reader accepts");
    assert.ok(wrapped.ok);
    assert.deepEqual(
      bare.apply(DEFAULT_LAYER_STYLE),
      wrapped.apply(DEFAULT_LAYER_STYLE),
      "the wrapper is the only difference between the two documents",
    );
  });
});

// The paste box shows the parser's own words. A reader that says "file" there is talking about
// something the user never touched, which is why `layers.importStyleInvalid` dropped the word too.
describe("what a failed import calls the thing it could not read", () => {
  for (const [label, text] of [
    ["a non-SLD XML document", "<foo/>"],
    ["JSON that is not a style", '{"not":"a style"}'],
    ["a QML with no renderer", "<qgis></qgis>"],
  ] as const) {
    it(`never says "file" for ${label}`, () => {
      const result = importStyleText(text);

      assert.ok(!result.ok, "this input carries no symbology");
      for (const warning of result.warnings) {
        assert.ok(
          !/\bfiles?\b/i.test(warning),
          `a paste has no file, so this must not mention one: ${warning}`,
        );
      }
    });
  }
});
