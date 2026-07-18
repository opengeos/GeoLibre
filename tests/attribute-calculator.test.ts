import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { calculateField } from "../apps/geolibre-desktop/src/lib/attribute-columns";
import {
  coerceComputedValue,
  compileExpression,
  fieldReference,
  isBareIdentifier,
} from "../apps/geolibre-desktop/src/lib/attribute-expression";

function fc(features: FeatureCollection["features"]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc([
      {
        type: "Feature",
        id: "f0",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { name: "A", pop: 10, area: 5 },
      },
      {
        type: "Feature",
        id: "f1",
        geometry: { type: "Point", coordinates: [1, 1] },
        properties: { name: "B", pop: 20, area: 8 },
      },
    ]),
    ...patch,
  };
}

const DISCOVERED = ["name", "pop", "area"];

describe("expression compilation", () => {
  it("evaluates arithmetic over field identifiers", () => {
    const compiled = compileExpression("pop / area", DISCOVERED);
    assert.equal(compiled.evaluate({ pop: 10, area: 5 }, 0), 2);
  });

  it("exposes helper functions and the $index variable", () => {
    assert.equal(compileExpression("upper(name)", DISCOVERED).evaluate({ name: "abc" }, 0), "ABC");
    assert.equal(
      compileExpression("round(pop / area, 2)", DISCOVERED).evaluate({ pop: 10, area: 3 }, 0),
      3.33,
    );
    assert.equal(compileExpression("$index", DISCOVERED).evaluate({}, 7), 7);
  });

  it("handles null-ish args in string helpers without coercing to 'null'", () => {
    // replace: a null search is a no-op; a null replacement is the empty string.
    assert.equal(
      compileExpression('replace("a null b", x, "X")', ["x"]).evaluate({ x: null }, 0),
      "a null b",
    );
    // substr uses slice semantics: a negative start counts from the end.
    assert.equal(compileExpression('substr("hello", -3)', []).evaluate({}, 0), "llo");
  });

  it("reaches non-identifier fields through props", () => {
    const compiled = compileExpression('props["my field"] + 1', ["my field"]);
    assert.equal(compiled.evaluate({ "my field": 41 }, 0), 42);
  });

  it("compiles when a field name is a JS keyword (e.g. OSM 'class')", () => {
    // `class` is a reserved word and cannot be a `new Function` parameter, so it
    // must be reachable only via props — compiling must not throw.
    const compiled = compileExpression('props["class"]', ["class", "name"]);
    assert.equal(compiled.evaluate({ class: "road", name: "x" }, 0), "road");
    assert.doesNotThrow(() => compileExpression("name", ["class", "let", "name"]));
  });

  it("throws a SyntaxError for an unparseable or empty expression", () => {
    assert.throws(() => compileExpression("pop +", DISCOVERED), SyntaxError);
    assert.throws(() => compileExpression("   ", DISCOVERED), SyntaxError);
  });
});

describe("identifier helpers", () => {
  it("treats valid, non-reserved names as bare identifiers", () => {
    assert.equal(isBareIdentifier("pop"), true);
    assert.equal(isBareIdentifier("my field"), false);
    assert.equal(isBareIdentifier("round"), false); // collides with a helper
    assert.equal(isBareIdentifier("class"), false); // JS keyword
    assert.equal(isBareIdentifier("let"), false); // strict-mode reserved
    assert.equal(isBareIdentifier("enum"), false); // reserved in all modes
    assert.equal(isBareIdentifier("undefined"), false); // global constant
    assert.equal(isBareIdentifier("NaN"), false); // global constant
    assert.equal(isBareIdentifier("Infinity"), false); // global constant
    assert.equal(fieldReference("pop"), "pop");
    assert.equal(fieldReference("my field"), 'props["my field"]');
    assert.equal(fieldReference("class"), 'props["class"]');
  });
});

describe("output coercion", () => {
  it("keeps the raw value under auto and normalizes non-finite numbers", () => {
    assert.equal(coerceComputedValue(3.5, "auto"), 3.5);
    assert.equal(coerceComputedValue("x", "auto"), "x");
    assert.equal(coerceComputedValue(Number.NaN, "auto"), null);
    assert.equal(coerceComputedValue(undefined, "auto"), null);
  });

  it("coerces to the requested type, nulling unrepresentable values", () => {
    assert.equal(coerceComputedValue("7", "number"), 7);
    assert.equal(coerceComputedValue("nope", "number"), null);
    assert.equal(coerceComputedValue(1, "text"), "1");
    assert.equal(coerceComputedValue("true", "boolean"), true);
    assert.equal(coerceComputedValue("false", "boolean"), false);
    // String spellings of 0/1 and yes/no are recognized rather than falling
    // through to JS truthiness (where every non-empty string would be true).
    assert.equal(coerceComputedValue("1", "boolean"), true);
    assert.equal(coerceComputedValue("0", "boolean"), false);
    assert.equal(coerceComputedValue("yes", "boolean"), true);
    assert.equal(coerceComputedValue("no", "boolean"), false);
    // Actual numbers use JS truthiness, which is already correct.
    assert.equal(coerceComputedValue(1, "boolean"), true);
    assert.equal(coerceComputedValue(0, "boolean"), false);
  });
});

describe("calculateField", () => {
  it("creates a new field from an expression for every feature", () => {
    const result = calculateField(makeLayer(), DISCOVERED, "density", true, "pop / area", "number");
    assert.ok(result && "patch" in result);
    assert.equal(result.evaluated, 2);
    assert.equal(result.errors, 0);
    const props = result.patch.geojson?.features.map((f) => f.properties);
    assert.equal(props?.[0]?.density, 2);
    assert.equal(props?.[1]?.density, 2.5);
    // The new field is appended to the persisted column order.
    const order = (result.patch.metadata?.columnSettings as { order?: string[] })?.order;
    assert.deepEqual(order, undefined); // no prior explicit order → discovery places it
  });

  it("updates an existing field in place without adding metadata order", () => {
    const result = calculateField(makeLayer(), DISCOVERED, "pop", false, "pop * 2", "number");
    assert.ok(result && "patch" in result);
    const props = result.patch.geojson?.features.map((f) => f.properties);
    assert.equal(props?.[0]?.pop, 20);
    assert.equal(props?.[1]?.pop, 40);
    assert.equal(result.patch.metadata, undefined);
  });

  it("limits updates to the targeted feature ids", () => {
    const result = calculateField(
      makeLayer(),
      DISCOVERED,
      "pop",
      false,
      "999",
      "number",
      new Set(["f1"]),
    );
    assert.ok(result && "patch" in result);
    assert.equal(result.evaluated, 1);
    const props = result.patch.geojson?.features.map((f) => f.properties);
    assert.equal(props?.[0]?.pop, 10); // untouched
    assert.equal(props?.[1]?.pop, 999);
  });

  it("seeds out-of-scope features with null when creating a scoped field", () => {
    const result = calculateField(
      makeLayer(),
      DISCOVERED,
      "flag",
      true,
      '"yes"',
      "text",
      new Set(["f0"]),
    );
    assert.ok(result && "patch" in result);
    const props = result.patch.geojson?.features.map((f) => f.properties);
    assert.equal(props?.[0]?.flag, "yes");
    assert.equal(props?.[1]?.flag, null);
  });

  it("counts runtime errors and writes null for the failing feature", () => {
    const result = calculateField(
      makeLayer(),
      DISCOVERED,
      "bad",
      true,
      "nope.missing", // ReferenceError on every row
      "auto",
    );
    assert.ok(result && "patch" in result);
    assert.equal(result.errors, 2);
    const props = result.patch.geojson?.features.map((f) => f.properties);
    assert.equal(props?.[0]?.bad, null);
  });

  it("returns an error for an invalid expression instead of mutating", () => {
    const result = calculateField(makeLayer(), DISCOVERED, "x", true, "pop +", "auto");
    assert.ok(result && "error" in result);
  });

  it("is a no-op when creating a colliding field or targeting an absent one", () => {
    assert.equal(calculateField(makeLayer(), DISCOVERED, "pop", true, "1", "number"), null);
    assert.equal(calculateField(makeLayer(), DISCOVERED, "ghost", false, "1", "number"), null);
  });
});
