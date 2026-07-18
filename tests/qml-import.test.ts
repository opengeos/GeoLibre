import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type LayerStyle } from "@geolibre/core";
import { applyQmlImport, parseQml } from "../packages/map/src/qml-import";

/** Wrap renderer/labeling XML in a minimal <qgis> document. */
function qgis(body: string): string {
  return `<!DOCTYPE qgis>\n<qgis version="3.34.0">${body}</qgis>`;
}

/** A SimpleFill symbol with the given fill/outline colors. */
function fillSymbol(name: string, color: string, outline = "30,64,175,255", width = "2"): string {
  return `<symbol type="fill" name="${name}"><layer class="SimpleFill"><Option type="Map">
    <Option name="color" type="QString" value="${color}"/>
    <Option name="outline_color" type="QString" value="${outline}"/>
    <Option name="outline_width" type="QString" value="${width}"/>
  </Option></layer></symbol>`;
}

describe("parseQml", () => {
  it("reads a single SimpleFill into a single-symbol style", () => {
    const result = parseQml(
      qgis(
        `<renderer-v2 type="singleSymbol"><symbols>${fillSymbol("0", "255,136,0,102", "0,68,136,255", "3")}</symbols></renderer-v2>`,
      ),
    );
    assert.equal(result.matchedRuleCount, 1);
    assert.equal(result.style.vectorStyleMode, "single");
    assert.equal(result.style.fillColor, "#ff8800");
    // alpha 102/255 ≈ 0.4.
    assert.ok(Math.abs((result.style.fillOpacity ?? 0) - 0.4) < 0.01);
    assert.equal(result.style.strokeColor, "#004488");
    assert.equal(result.style.strokeWidth, 3);
  });

  it("reads a legacy <prop> symbol layer", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="singleSymbol"><symbols>
        <symbol type="fill" name="0"><layer class="SimpleFill">
          <prop k="color" v="10,20,30,255"/>
          <prop k="outline_color" v="40,50,60,255"/>
        </layer></symbol>
      </symbols></renderer-v2>`),
    );
    assert.equal(result.style.fillColor, "#0a141e");
    assert.equal(result.style.strokeColor, "#28323c");
  });

  it("reads a SimpleMarker point size into a circle radius", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="singleSymbol"><symbols>
        <symbol type="marker" name="0"><layer class="SimpleMarker"><Option type="Map">
          <Option name="name" type="QString" value="circle"/>
          <Option name="color" type="QString" value="18,52,86,255"/>
          <Option name="size" type="QString" value="20"/>
        </Option></layer></symbol>
      </symbols></renderer-v2>`),
    );
    assert.equal(result.style.fillColor, "#123456");
    assert.equal(result.style.circleRadius, 10);
    assert.notEqual(result.style.markerEnabled, true);
  });

  it("recovers a diamond shape marker", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="singleSymbol"><symbols>
        <symbol type="marker" name="0"><layer class="SimpleMarker"><Option type="Map">
          <Option name="name" type="QString" value="diamond"/>
          <Option name="color" type="QString" value="255,136,0,255"/>
          <Option name="size" type="QString" value="18"/>
        </Option></layer></symbol>
      </symbols></renderer-v2>`),
    );
    assert.equal(result.style.markerEnabled, true);
    assert.equal(result.style.markerShape, "diamond");
    assert.equal(result.style.markerColor, "#ff8800");
    assert.equal(result.style.markerSize, 18);
  });

  it("classifies a categorizedSymbol renderer", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="categorizedSymbol" attr="type">
        <categories>
          <category value="park" symbol="0" label="Park" render="true"/>
          <category value="lake" symbol="1" label="lake" render="true"/>
          <category value="" symbol="2" label="" render="true"/>
        </categories>
        <symbols>${fillSymbol("0", "0,255,0,255")}${fillSymbol("1", "0,0,255,255")}${fillSymbol("2", "204,204,204,255")}</symbols>
      </renderer-v2>`),
    );
    assert.equal(result.style.vectorStyleMode, "categorized");
    assert.equal(result.style.vectorStyleProperty, "type");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: "park", color: "#00ff00", label: "Park" },
      { value: "lake", color: "#0000ff" },
    ]);
    assert.equal(result.style.fillColor, "#cccccc");
  });

  it("classifies a graduatedSymbol renderer", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="graduatedSymbol" attr="pop">
        <ranges>
          <range lower="0" upper="100" symbol="0" label="0 - 100" render="true"/>
          <range lower="100" upper="1000" symbol="1" label="100 - 1000" render="true"/>
        </ranges>
        <symbols>${fillSymbol("0", "238,238,238,255")}${fillSymbol("1", "17,17,17,255")}</symbols>
      </renderer-v2>`),
    );
    assert.equal(result.style.vectorStyleMode, "graduated");
    assert.equal(result.style.vectorStyleProperty, "pop");
    assert.deepEqual(result.style.vectorStyleStops, [
      { value: 0, color: "#eeeeee" },
      { value: 100, color: "#111111" },
    ]);
  });

  it("classifies a RuleRenderer and translates QGIS expressions", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="RuleRenderer">
        <rules>
          <rule filter="&quot;pop&quot; &gt; 1000" symbol="0" label="big"/>
          <rule filter="ELSE" symbol="1" label=""/>
        </rules>
        <symbols>${fillSymbol("0", "255,0,0,255")}${fillSymbol("1", "221,221,221,255")}</symbols>
      </renderer-v2>`),
    );
    assert.equal(result.style.vectorStyleMode, "rule-based");
    const rules = result.style.vectorRules ?? [];
    assert.equal(rules.length, 2);
    assert.equal(rules[0].filter, JSON.stringify([">", ["get", "pop"], 1000]));
    assert.equal(rules[0].label, "big");
    assert.equal(rules[1].isElse, true);
    assert.equal(rules[1].color, "#dddddd");
  });

  it("translates AND / OR / NOT / IN rule expressions", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="RuleRenderer">
        <rules>
          <rule filter="(&quot;a&quot; = 'x') AND (NOT (&quot;b&quot; = 'y'))" symbol="0"/>
          <rule filter="&quot;c&quot; IN (1, 2)" symbol="0"/>
          <rule filter="ELSE" symbol="1"/>
        </rules>
        <symbols>${fillSymbol("0", "255,0,0,255")}${fillSymbol("1", "221,221,221,255")}</symbols>
      </renderer-v2>`),
    );
    const rules = result.style.vectorRules ?? [];
    assert.equal(
      rules[0].filter,
      JSON.stringify(["all", ["==", ["get", "a"], "x"], ["!", ["==", ["get", "b"], "y"]]]),
    );
    assert.equal(rules[1].filter, JSON.stringify(["in", ["get", "c"], 1, 2]));
  });

  it("reads a labeling block", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="singleSymbol"><symbols>${fillSymbol("0", "255,255,255,255")}</symbols></renderer-v2>
      <labeling type="simple"><settings fieldName="name" isExpression="0">
        <text-style fontSize="18" textColor="51,51,51,255">
          <text-buffer bufferDraw="1" bufferSize="2" bufferColor="0,0,0,255"/>
        </text-style>
      </settings></labeling>`),
    );
    assert.ok(result.labels);
    assert.equal(result.labels?.enabled, true);
    assert.equal(result.labels?.field, "name");
    assert.equal(result.labels?.size, 18);
    assert.equal(result.labels?.color, "#333333");
    assert.equal(result.labels?.haloWidth, 2);
    assert.equal(result.labels?.haloColor, "#000000");
  });

  it("routes a line symbol's color to strokeColor", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="singleSymbol"><symbols>
        <symbol type="line" name="0"><layer class="SimpleLine"><Option type="Map">
          <Option name="line_color" type="QString" value="230,57,70,255"/>
          <Option name="line_width" type="QString" value="3"/>
        </Option></layer></symbol>
      </symbols></renderer-v2>`),
    );
    assert.equal(result.style.strokeColor, "#e63946");
    assert.equal(result.style.strokeWidth, 3);
  });

  it("rejects an unsupported arithmetic rule expression", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="RuleRenderer">
        <rules>
          <rule filter="&quot;a&quot; = 1-2" symbol="0"/>
          <rule filter="ELSE" symbol="0"/>
        </rules>
        <symbols>${fillSymbol("0", "255,0,0,255")}</symbols>
      </renderer-v2>`),
    );
    // The `1-2` arithmetic is not a supported literal, so the rule is skipped and
    // (with no translatable rules) the layer falls back to a single symbol.
    assert.equal(result.style.vectorStyleMode, "single");
    assert.ok(result.warnings.some((w) => /could not be read/.test(w)));
  });

  it("does not crash on an out-of-range numeric entity", () => {
    // &#x110000; is above the max Unicode code point; import must not throw.
    const result = parseQml(
      qgis(`<renderer-v2 type="categorizedSymbol" attr="t">
        <categories><category value="a&#x110000;b" symbol="0" label=""/></categories>
        <symbols>${fillSymbol("0", "255,0,0,255")}</symbols>
      </renderer-v2>`),
    );
    // The invalid entity is kept as raw text; the categorized renderer still
    // parses (one category), so the import succeeds without crashing.
    assert.equal(result.matchedRuleCount, 1);
    assert.equal(result.style.vectorStyleProperty, "t");
    assert.equal(result.style.vectorStyleMode, "categorized");
  });

  it("warns for a non-simple labeling type", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="singleSymbol"><symbols>${fillSymbol("0", "255,255,255,255")}</symbols></renderer-v2>
      <labeling type="rule-based"><rules><rule><settings/></rule></rules></labeling>`),
    );
    assert.equal(result.labels, null);
    assert.ok(
      result.warnings.some((w) => /"rule-based" labeling has no GeoLibre equivalent/.test(w)),
    );
  });

  it("reports a clear error for a non-QML document", () => {
    const result = parseQml("<StyledLayerDescriptor/>");
    assert.equal(result.matchedRuleCount, 0);
    assert.ok(result.warnings.some((w) => /not a QGIS QML/.test(w)));
  });

  it("applyQmlImport merges the patch and labels over a base style", () => {
    const base: LayerStyle = { ...DEFAULT_LAYER_STYLE, fillColor: "#000000" };
    const merged = applyQmlImport(base, {
      style: { fillColor: "#ff0000" },
      labels: { enabled: true, field: "name" },
      warnings: [],
      matchedRuleCount: 1,
    });
    assert.equal(merged.fillColor, "#ff0000");
    assert.equal(merged.labels.enabled, true);
    assert.equal(merged.labels.field, "name");
  });
});

describe("rule trees without an ELSE rule (#1312)", () => {
  it("imports as a disabled else record so unmatched features stay hidden", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="RuleRenderer">
        <rules>
          <rule filter="&quot;pop&quot; &gt; 1000" symbol="0" label="big"/>
        </rules>
        <symbols>${fillSymbol("0", "255,0,0,255")}</symbols>
      </renderer-v2>`),
    );
    assert.equal(result.style.vectorStyleMode, "rule-based");
    const elseRule = (result.style.vectorRules ?? []).find((r) => r.isElse);
    assert.equal(elseRule?.enabled, false);
  });

  it("keeps the else record enabled when the QML has an ELSE rule", () => {
    const result = parseQml(
      qgis(`<renderer-v2 type="RuleRenderer">
        <rules>
          <rule filter="&quot;pop&quot; &gt; 1000" symbol="0" label="big"/>
          <rule filter="ELSE" symbol="1"/>
        </rules>
        <symbols>${fillSymbol("0", "255,0,0,255")}${fillSymbol("1", "221,221,221,255")}</symbols>
      </renderer-v2>`),
    );
    const elseRule = (result.style.vectorRules ?? []).find((r) => r.isElse);
    assert.equal(elseRule?.enabled, undefined);
  });
});
