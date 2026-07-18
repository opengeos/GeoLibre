import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  EXPRESSION_FUNCTION_CATEGORIES,
  type ExpressionVariable,
  evaluateMapExpression,
  formatExpressionPreviewValue,
  inferFieldTypes,
  isStyleSpecColor,
  parseJsonExpression,
  removeTrailingJsonCommas,
  substituteExpressionVariables,
  validateMapExpression,
} from "@geolibre/core";
import type { Feature } from "geojson";

const sampleFeature: Feature = {
  type: "Feature",
  id: 7,
  properties: { name: "Springfield", pop: 1234, capital: false },
  geometry: { type: "Point", coordinates: [-89.6, 39.8] },
};

const variables: ExpressionVariable[] = [
  { token: "@project_name", value: "Demo project" },
  { token: "@feature_count", value: 42 },
];

describe("expression function catalog", () => {
  it("every snippet is a valid, standalone-compilable expression", () => {
    for (const category of EXPRESSION_FUNCTION_CATEGORIES) {
      for (const entry of category.functions) {
        const validation = validateMapExpression(entry.snippet);
        assert.ok(validation.ok, `${entry.name}: ${validation.errors.join("; ")}`);
      }
    }
  });

  it("doc keys are unique across the catalog", () => {
    const keys = EXPRESSION_FUNCTION_CATEGORIES.flatMap((category) =>
      category.functions.map((entry) => entry.docKey),
    );
    assert.equal(new Set(keys).size, keys.length);
  });

  it("every category and function doc key has an en.json string", () => {
    const en = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as {
      style: {
        expressionBuilder: {
          categories: Record<string, string>;
          functions: Record<string, string>;
        };
      };
    };
    const builder = en.style.expressionBuilder;
    for (const category of EXPRESSION_FUNCTION_CATEGORIES) {
      assert.equal(
        typeof builder.categories[category.key],
        "string",
        `missing category label: ${category.key}`,
      );
      for (const entry of category.functions) {
        assert.equal(
          typeof builder.functions[entry.docKey],
          "string",
          `missing function doc: ${entry.docKey}`,
        );
      }
    }
  });
});

describe("validateMapExpression", () => {
  it("accepts a valid expression, tolerating trailing commas", () => {
    const validation = validateMapExpression('["==", ["get", "TYPE"], "park",]');
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.parsed, ["==", ["get", "TYPE"], "park"]);
  });

  it("treats a blank source as valid (no expression)", () => {
    assert.equal(validateMapExpression("   ").ok, true);
  });

  it("classifies structural failures", () => {
    assert.equal(validateMapExpression("{oops").code, "not-json");
    assert.equal(validateMapExpression('{"a": 1}').code, "not-array");
    assert.equal(validateMapExpression("[1, 2]").code, "not-operator");
  });

  it("substitutes variables before type-checking", () => {
    const source = '["+", ["get", "pop"], "@feature_count"]';
    assert.equal(validateMapExpression(source).ok, false);
    assert.equal(validateMapExpression(source, { variables }).ok, true);
  });

  it("enforces an expected result type when given", () => {
    const filter = { expectedType: "boolean" as const };
    assert.equal(validateMapExpression('["==", ["get", "a"], 1]', filter).ok, true);
    const wrong = validateMapExpression('["concat", "a", "b"]', filter);
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, "compile");
    assert.equal(
      validateMapExpression('["concat", "#ff", "0000"]', {
        expectedType: "color",
      }).ok,
      true,
    );
  });

  it("catches operator misuse the JSON shape checks miss", () => {
    const unknown = validateMapExpression('["frobnicate", 1]');
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, "compile");
    assert.match(unknown.errors[0], /frobnicate/);

    const arity = validateMapExpression('["get"]');
    assert.equal(arity.ok, false);
    assert.equal(arity.code, "compile");
  });
});

describe("evaluateMapExpression", () => {
  it("evaluates attribute access against the sample feature", () => {
    const preview = evaluateMapExpression('["get", "name"]', {
      feature: sampleFeature,
    });
    assert.deepEqual(preview, { kind: "value", value: "Springfield" });
  });

  it("supports geometry-type, id, and zoom", () => {
    assert.equal(
      evaluateMapExpression('["geometry-type"]', { feature: sampleFeature }).value,
      "Point",
    );
    assert.equal(evaluateMapExpression('["id"]', { feature: sampleFeature }).value, 7);
    assert.equal(evaluateMapExpression('["zoom"]', { zoom: 7.5 }).value, 7.5);
  });

  it("evaluates a boolean filter", () => {
    assert.equal(
      evaluateMapExpression('[">", ["get", "pop"], 1000]', {
        feature: sampleFeature,
      }).value,
      true,
    );
  });

  it("substitutes variables before evaluating", () => {
    const preview = evaluateMapExpression('["concat", ["get", "name"], " / ", "@project_name"]', {
      feature: sampleFeature,
      variables,
    });
    assert.equal(preview.value, "Springfield / Demo project");
  });

  it("returns runtime failures as errors instead of throwing", () => {
    const preview = evaluateMapExpression('["to-color", "nope"]', {});
    assert.equal(preview.kind, "error");
    assert.ok((preview.errors ?? []).length > 0);
  });

  it("surfaces coercion failures as errors, not console warnings", () => {
    // The plain evaluate() would swallow this into console.warn (which the
    // app's diagnostics interceptor turns into re-renders); the preview must
    // get the message instead (GH #1306 freeze regression).
    const preview = evaluateMapExpression('["get", "city"]', {
      feature: {
        type: "Feature",
        properties: { city: "New York" },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
      expectedType: "color",
    });
    assert.equal(preview.kind, "error");
    assert.match((preview.errors ?? []).join(" "), /parse color/i);
  });

  it("returns empty for a blank source", () => {
    assert.equal(evaluateMapExpression("  ").kind, "empty");
  });

  it("coerces to the expected type when one is given", () => {
    const preview = evaluateMapExpression('["get", "color"]', {
      feature: {
        type: "Feature",
        properties: { color: "#ff0000" },
        geometry: { type: "Point", coordinates: [0, 0] },
      },
      expectedType: "color",
    });
    assert.equal(preview.kind, "value");
    assert.equal(formatExpressionPreviewValue(preview.value), "rgba(255, 0, 0, 1)");
  });
});

describe("variables", () => {
  it("substitutes exact tokens deeply without mutating the input", () => {
    const input = ["concat", "@project_name", ["get", "@feature_count"]];
    const output = substituteExpressionVariables(input, variables);
    assert.deepEqual(output, ["concat", "Demo project", ["get", 42]]);
    assert.deepEqual(input[1], "@project_name");
  });

  it("leaves unknown @ strings untouched", () => {
    assert.deepEqual(substituteExpressionVariables(["get", "@unknown"], variables), [
      "get",
      "@unknown",
    ]);
  });

  it("recognizes style-spec color shapes", () => {
    const preview = evaluateMapExpression('["to-color", "#ff0000"]', {});
    assert.equal(isStyleSpecColor(preview.value), true);
    assert.equal(isStyleSpecColor("#ff0000"), false);
    assert.equal(isStyleSpecColor(null), false);
    assert.equal(isStyleSpecColor({ r: 1, g: 1, b: 1 }), false);
    // Only real style-spec Color instances count: user attribute data that
    // happens to carry r/g/b/a fields (e.g. via ["properties"]) must not be
    // mistaken for a color, even with numeric channels.
    assert.equal(isStyleSpecColor({ r: "x", g: 0, b: 0, a: "x" }), false);
    assert.equal(isStyleSpecColor({ r: NaN, g: 0, b: 0, a: 1 }), false);
    assert.equal(isStyleSpecColor({ r: 0.5, g: 0.5, b: 0.5, a: 1 }), false);
  });
});

describe("field type inference", () => {
  it("infers primitive types, mixed, and unknown", () => {
    const types = inferFieldTypes(
      [{ properties: { a: 1, b: "x", c: true, d: null } }, { properties: { a: "y", b: "z" } }],
      ["a", "b", "c", "d", "e"],
    );
    assert.deepEqual(types, {
      a: "mixed",
      b: "string",
      c: "boolean",
      d: "unknown",
      e: "unknown",
    });
  });
});

describe("preview formatting", () => {
  it("renders style-spec colors as rgba strings", () => {
    const preview = evaluateMapExpression('["to-color", "#ff0000"]', {});
    assert.equal(formatExpressionPreviewValue(preview.value), "rgba(255, 0, 0, 1)");
  });

  it("renders plain values as JSON and null as null", () => {
    assert.equal(formatExpressionPreviewValue("abc"), '"abc"');
    assert.equal(formatExpressionPreviewValue(3), "3");
    assert.equal(formatExpressionPreviewValue(null), "null");
  });
});

describe("removeTrailingJsonCommas sharing", () => {
  it("still backs parseJsonExpression after the refactor", () => {
    assert.deepEqual(parseJsonExpression('["get", "a",]'), ["get", "a"]);
    assert.equal(removeTrailingJsonCommas('["a", "b",]'), '["a", "b"]');
  });
});
