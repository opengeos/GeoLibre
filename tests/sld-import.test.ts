import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import { applySldImport, parseSld } from "../packages/map/src/sld-import";

/** A minimal SLD 1.0.0 wrapper around FeatureTypeStyle rules. */
function sld(rules: string, version = "1.0.0"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="${version}" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer><Name>test</Name><UserStyle><FeatureTypeStyle>
    ${rules}
  </FeatureTypeStyle></UserStyle></NamedLayer>
</StyledLayerDescriptor>`;
}

describe("parseSld", () => {
  it("reads a single PolygonSymbolizer into a single-symbol style", () => {
    const result = parseSld(
      sld(`<Rule><PolygonSymbolizer>
        <Fill><CssParameter name="fill">#ff8800</CssParameter><CssParameter name="fill-opacity">0.4</CssParameter></Fill>
        <Stroke><CssParameter name="stroke">#004488</CssParameter><CssParameter name="stroke-width">3</CssParameter></Stroke>
      </PolygonSymbolizer></Rule>`),
    );
    assert.equal(result.matchedRuleCount, 1);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.equal(result.style.fillColor, "#ff8800");
    assert.equal(result.style.fillOpacity, 0.4);
    assert.equal(result.style.strokeColor, "#004488");
    assert.equal(result.style.strokeWidth, 3);
    assert.equal(result.style.strokeWidthUnit, "pixels");
  });

  it("reads a PointSymbolizer size back into a circle radius", () => {
    const result = parseSld(
      sld(`<Rule><PointSymbolizer><Graphic><Mark>
        <WellKnownName>circle</WellKnownName>
        <Fill><CssParameter name="fill">#123456</CssParameter></Fill>
      </Mark><Size>20</Size></Graphic></PointSymbolizer></Rule>`),
    );
    assert.equal(result.style.fillColor, "#123456");
    // Size 20 → radius 10.
    assert.equal(result.style.circleRadius, 10);
  });

  it("classifies PropertyIsEqualTo rules as a categorized renderer", () => {
    const result = parseSld(
      sld(`
        <Rule><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>type</ogc:PropertyName><ogc:Literal>park</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer><Fill><CssParameter name="fill">#00ff00</CssParameter></Fill></PolygonSymbolizer></Rule>
        <Rule><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>type</ogc:PropertyName><ogc:Literal>lake</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer><Fill><CssParameter name="fill">#0000ff</CssParameter></Fill></PolygonSymbolizer></Rule>
        <Rule><ElseFilter/><PolygonSymbolizer><Fill><CssParameter name="fill">#cccccc</CssParameter></Fill></PolygonSymbolizer></Rule>
      `),
    );
    assert.equal(result.style.vectorStyleMode, "categorized");
    assert.equal(result.style.vectorStyleProperty, "type");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: "park", color: "#00ff00" },
      { value: "lake", color: "#0000ff" },
    ]);
    // The ElseFilter fill is the fallback color.
    assert.equal(result.style.fillColor, "#cccccc");
  });

  it("parses canonical numeric categories as numbers but keeps zero-padded ones as strings", () => {
    const result = parseSld(
      sld(`
        <Rule><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>code</ogc:PropertyName><ogc:Literal>1.0</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer><Fill><CssParameter name="fill">#111111</CssParameter></Fill></PolygonSymbolizer></Rule>
        <Rule><ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>code</ogc:PropertyName><ogc:Literal>01</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
          <PolygonSymbolizer><Fill><CssParameter name="fill">#222222</CssParameter></Fill></PolygonSymbolizer></Rule>
      `),
    );
    assert.equal(result.style.vectorStyleMode, "categorized");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: 1, color: "#111111" },
      { value: "01", color: "#222222" },
    ]);
  });

  it("classifies numeric range rules as a graduated renderer", () => {
    const result = parseSld(
      sld(`
        <Rule><ogc:Filter><ogc:And>
          <ogc:PropertyIsGreaterThanOrEqualTo><ogc:PropertyName>pop</ogc:PropertyName><ogc:Literal>0</ogc:Literal></ogc:PropertyIsGreaterThanOrEqualTo>
          <ogc:PropertyIsLessThan><ogc:PropertyName>pop</ogc:PropertyName><ogc:Literal>100</ogc:Literal></ogc:PropertyIsLessThan>
        </ogc:And></ogc:Filter><PolygonSymbolizer><Fill><CssParameter name="fill">#eeeeee</CssParameter></Fill></PolygonSymbolizer></Rule>
        <Rule><ogc:Filter>
          <ogc:PropertyIsGreaterThanOrEqualTo><ogc:PropertyName>pop</ogc:PropertyName><ogc:Literal>100</ogc:Literal></ogc:PropertyIsGreaterThanOrEqualTo>
        </ogc:Filter><PolygonSymbolizer><Fill><CssParameter name="fill">#111111</CssParameter></Fill></PolygonSymbolizer></Rule>
      `),
    );
    assert.equal(result.style.vectorStyleMode, "graduated");
    assert.equal(result.style.vectorStyleProperty, "pop");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: 0, color: "#eeeeee" },
      { value: 100, color: "#111111" },
    ]);
  });

  it("classifies mixed filters as a rule-based renderer", () => {
    const result = parseSld(
      sld(`
        <Rule><ogc:Filter><ogc:PropertyIsGreaterThan><ogc:PropertyName>pop</ogc:PropertyName><ogc:Literal>1000</ogc:Literal></ogc:PropertyIsGreaterThan></ogc:Filter>
          <PolygonSymbolizer><Fill><CssParameter name="fill">#ff0000</CssParameter></Fill></PolygonSymbolizer></Rule>
        <Rule><ElseFilter/><PolygonSymbolizer><Fill><CssParameter name="fill">#dddddd</CssParameter></Fill></PolygonSymbolizer></Rule>
      `),
    );
    assert.equal(result.style.vectorStyleMode, "rule-based");
    const rules = result.style.vectorRules ?? [];
    assert.equal(rules.length, 2);
    assert.equal(rules[0].filter, JSON.stringify([">", ["get", "pop"], 1000]));
    assert.equal(rules[0].color, "#ff0000");
    assert.equal(rules[1].isElse, true);
    assert.equal(rules[1].color, "#dddddd");
  });

  it("reads a TextSymbolizer into labels", () => {
    const result = parseSld(
      sld(`<Rule>
        <PolygonSymbolizer><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></PolygonSymbolizer>
        <TextSymbolizer>
          <Label><ogc:PropertyName>name</ogc:PropertyName></Label>
          <Font><CssParameter name="font-size">18</CssParameter></Font>
          <Halo><Radius>2</Radius><Fill><CssParameter name="fill">#000000</CssParameter></Fill></Halo>
          <Fill><CssParameter name="fill">#333333</CssParameter></Fill>
        </TextSymbolizer>
      </Rule>`),
    );
    assert.ok(result.labels);
    assert.equal(result.labels?.enabled, true);
    assert.equal(result.labels?.field, "name");
    assert.equal(result.labels?.size, 18);
    assert.equal(result.labels?.haloWidth, 2);
    assert.equal(result.labels?.haloColor, "#000000");
    assert.equal(result.labels?.color, "#333333");
  });

  it("recovers a zoom window from scale denominators", () => {
    const result = parseSld(
      sld(`<Rule>
        <MinScaleDenominator>136494.69</MinScaleDenominator>
        <MaxScaleDenominator>34952466.0</MaxScaleDenominator>
        <PolygonSymbolizer><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></PolygonSymbolizer>
      </Rule>`),
    );
    // 559082264 / 2^12 ≈ 136494.7 → maxZoom 12; / 2^4 ≈ 34942641 → minZoom 4.
    assert.equal(result.style.maxZoom, 12);
    assert.equal(result.style.minZoom, 4);
  });

  it("also parses SLD 1.1.0 SvgParameter symbolizers", () => {
    const result = parseSld(
      sld(
        `<Rule><PolygonSymbolizer><Fill><SvgParameter name="fill">#abcdef</SvgParameter></Fill></PolygonSymbolizer></Rule>`,
        "1.1.0",
      ),
    );
    assert.equal(result.style.fillColor, "#abcdef");
  });

  it("keeps the polygon stroke width over the point Mark in a mixed rule", () => {
    const result = parseSld(
      sld(`<Rule>
        <PolygonSymbolizer><Fill><CssParameter name="fill">#eeeeee</CssParameter></Fill>
          <Stroke><CssParameter name="stroke">#333333</CssParameter><CssParameter name="stroke-width">4</CssParameter></Stroke></PolygonSymbolizer>
        <PointSymbolizer><Graphic><Mark><WellKnownName>circle</WellKnownName>
          <Stroke><CssParameter name="stroke">#333333</CssParameter><CssParameter name="stroke-width">1</CssParameter></Stroke>
        </Mark><Size>10</Size></Graphic></PointSymbolizer>
      </Rule>`),
    );
    // The polygon border width wins; the point Mark outline does not clobber it.
    assert.equal(result.style.strokeWidth, 4);
  });

  it("recovers a shape marker from a WellKnownName", () => {
    const result = parseSld(
      sld(`<Rule><PointSymbolizer><Graphic><Mark>
        <WellKnownName>star</WellKnownName>
        <Fill><CssParameter name="fill">#ff8800</CssParameter></Fill>
      </Mark><Size>18</Size></Graphic></PointSymbolizer></Rule>`),
    );
    assert.equal(result.style.markerEnabled, true);
    assert.equal(result.style.markerShape, "star");
    assert.equal(result.style.markerColor, "#ff8800");
    assert.equal(result.style.markerSize, 18);
  });

  it("warns when a WellKnownName has no GeoLibre marker equivalent", () => {
    const result = parseSld(
      sld(`<Rule><PointSymbolizer><Graphic><Mark>
        <WellKnownName>shape://slash</WellKnownName>
        <Fill><CssParameter name="fill">#123456</CssParameter></Fill>
      </Mark><Size>12</Size></Graphic></PointSymbolizer></Rule>`),
    );
    // Falls back to a plain circle (no marker enabled) and warns.
    assert.notEqual(result.style.markerEnabled, true);
    assert.ok(result.warnings.some((w) => /no GeoLibre equivalent/.test(w)));
  });

  it("reports a clear error for a non-SLD document", () => {
    const result = parseSld("<html><body>not sld</body></html>");
    assert.equal(result.matchedRuleCount, 0);
    assert.ok(result.warnings.some((w) => /not an SLD/.test(w)));
  });

  it("reports a clear error for unparseable XML", () => {
    const result = parseSld("<<< not xml");
    assert.equal(result.matchedRuleCount, 0);
    assert.ok(result.warnings.length > 0);
  });

  it("applySldImport merges the patch and labels over a base style", () => {
    const base: LayerStyle = { ...DEFAULT_LAYER_STYLE, fillColor: "#000000" };
    const merged = applySldImport(base, {
      style: { fillColor: "#ff0000" },
      labels: { enabled: true, field: "name" },
      warnings: [],
      matchedRuleCount: 1,
    });
    assert.equal(merged.fillColor, "#ff0000");
    assert.equal(merged.labels.enabled, true);
    assert.equal(merged.labels.field, "name");
    // Untouched base label fields survive.
    assert.equal(merged.labels.color, DEFAULT_LAYER_STYLE.labels.color);
  });
});
