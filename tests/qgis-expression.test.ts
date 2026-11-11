import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeAttributeFormDefaults,
  evaluateMapExpression,
  evaluateQgisExpression,
  parseQgisExpression,
  qgisExpressionProblem,
  qgisExpressionReferences,
  qgisExpressionToMapLibre,
  type AttributeFormConfig,
  type QgisExpressionContext,
} from "@geolibre/core";

const NOW = new Date(2026, 10, 11, 16, 5, 9);
const context: QgisExpressionContext = {
  now: () => NOW,
  uuid: () => "11111111-2222-4333-8444-555555555555",
};

function value(source: string, extra: QgisExpressionContext = {}): unknown {
  const result = evaluateQgisExpression(source, { ...context, ...extra });
  assert.ok(result.ok, `${source}: ${result.ok ? "" : result.error}`);
  return result.value;
}

describe("QGIS expression subset", () => {
  it("evaluates literals, arithmetic and precedence", () => {
    assert.equal(value("1 + 2 * 3"), 7);
    assert.equal(value("(1 + 2) * 3"), 9);
    assert.equal(value("2 ^ 3 ^ 2"), 512);
    assert.equal(value("-4 + 10 % 3"), -3);
    assert.equal(value("'it''s'"), "it's");
    assert.equal(value("7 / 0"), null);
  });

  it("reads fields quoted, bare and through attribute()", () => {
    const properties = { site: "A1", "plot no": 7 };
    assert.equal(value('"site"', { properties }), "A1");
    assert.equal(value("site", { properties }), "A1");
    assert.equal(value('"plot no" + 1', { properties }), 8);
    assert.equal(value("attribute('site')", { properties }), "A1");
    assert.equal(value("missing", { properties }), null);
  });

  it("builds a photo file name from attributes and the date", () => {
    assert.equal(
      value(
        `"site" || '_' || lpad("plot", 3, '0') || '_' || format_date(now(), 'yyyyMMdd_HHmmss') || '.jpg'`,
        {
          properties: { site: "A1", plot: 7 },
        },
      ),
      "A1_007_20261111_160509.jpg",
    );
  });

  it("generates ids the way QGIS formats them", () => {
    assert.equal(value("uuid()"), "{11111111-2222-4333-8444-555555555555}");
    assert.equal(value("uuid('WithoutBraces')"), "11111111-2222-4333-8444-555555555555");
    assert.equal(value("uuid('Id128')"), "11111111222243338444555555555555");
    const generated = evaluateQgisExpression("uuid('WithoutBraces')");
    assert.ok(generated.ok && /^[0-9a-f-]{36}$/.test(String(generated.value)));
  });

  it("treats unknown variables as NULL so QField's coalesce idiom works", () => {
    const source = "coalesce(@position_horizontal_accuracy, @gnss_horizontal_accuracy)";
    assert.equal(value(source), null);
    assert.equal(value(source, { variables: { gnss_horizontal_accuracy: 2.5 } }), 2.5);
    assert.equal(value("@position_coordinate is not null"), false);
  });

  it("reads coordinates from a position variable and the feature geometry", () => {
    const variables = { position_coordinate: { type: "Point", coordinates: [9.25, 46.8, 1020] } };
    assert.equal(value("x(coalesce(@position_coordinate, @gnss_coordinate))", { variables }), 9.25);
    assert.equal(value("z(@position_coordinate)", { variables }), 1020);
    assert.equal(value("y(@position_coordinate)"), null);
    const geometry = { type: "Point" as const, coordinates: [1, 2] };
    assert.equal(value("$x", { geometry }), 1);
    assert.equal(value("y($geometry)", { geometry }), 2);
  });

  it("reprojects through the host's transform hook, and fails without one", () => {
    const variables = { position_coordinate: { type: "Point", coordinates: [9, 46] } };
    const source = "x(transform(@position_coordinate, 'EPSG:4326', 'EPSG:2056'))";
    assert.equal(value(source, { variables, transform: ([x, y]) => [x * 1000, y * 1000] }), 9000);
    assert.equal(evaluateQgisExpression(source, { variables }).ok, false);
  });

  it("applies three-valued logic, IN, LIKE and CASE", () => {
    assert.equal(value("NULL and false"), false);
    assert.equal(value("NULL or true"), true);
    assert.equal(value("NULL and true"), null);
    assert.equal(value("'b' in ('a', 'b')"), true);
    assert.equal(value("3 not in (1, 2)"), true);
    assert.equal(value("'Maple Rd' ilike 'maple%'"), true);
    assert.equal(value("case when 5 > 3 then 'big' else 'small' end"), "big");
    assert.equal(value("if(1 = 2, 'a', 'b')"), "b");
  });

  it("matches LIKE without building a regular expression", () => {
    assert.equal(value("'a.c' like 'a.c'"), true);
    assert.equal(value("'abc' like 'a.c'"), false);
    assert.equal(value("'abc' like 'a_c'"), true);
    assert.equal(value("'abc' like '%'"), true);
    assert.equal(value("'' like '%'"), true);
    assert.equal(value("'abc' like 'a%b%c%'"), true);
    assert.equal(value("'abc' like '%d'"), false);
    assert.equal(value("'50%' like '50\\%'"), true);
    assert.equal(value("'505' like '50\\%'"), false);
    // The shape that backtracks catastrophically as a regex returns at once.
    const started = Date.now();
    const subject = "a".repeat(4000);
    const result = evaluateQgisExpression(`x like '${"%a".repeat(40)}b'`, {
      properties: { x: subject },
    });
    assert.deepEqual(result, { ok: true, value: false });
    assert.ok(Date.now() - started < 1000);
  });

  it("evaluates only the chosen if() branch", () => {
    assert.equal(value("if(true, 'ok', to_int('invalid'))"), "ok");
    assert.equal(value("if(a is null, 0, to_int(a))", { properties: { a: null } }), 0);
    assert.equal(evaluateQgisExpression("if(false, 'ok', to_int('invalid'))").ok, false);
  });

  it("reads zone-less dates as local calendar dates", () => {
    assert.equal(value("to_date('2026-11-11')"), "2026-11-11");
    assert.equal(value("day('2026-11-01')"), 1);
    assert.equal(value("month('2026-01-31')"), 1);
    assert.equal(
      value("format_date('2026-03-05 07:08:09', 'dd.MM.yyyy HH:mm')"),
      "05.03.2026 07:08",
    );
  });

  it("refuses to build oversized text", () => {
    assert.equal(evaluateQgisExpression("rpad('x', 200000000, 'x')").ok, false);
    assert.equal(evaluateQgisExpression("lpad('x', 200000000, 'x')").ok, false);
    assert.equal(value("lpad('7', 3, '0')"), "007");
  });

  it("lists the fields an expression reads and what makes it change", () => {
    assert.deepEqual(qgisExpressionReferences(`"site" || '_' || left(code, 2)`), {
      fields: ["site", "code"],
      usesNow: false,
      usesUuid: false,
    });
    assert.deepEqual(qgisExpressionReferences("uuid()"), {
      fields: [],
      usesNow: false,
      usesUuid: true,
    });
    assert.deepEqual(qgisExpressionReferences("site || format_date(now(), 'yyyy')"), {
      fields: ["site"],
      usesNow: true,
      usesUuid: false,
    });
    assert.deepEqual(qgisExpressionReferences("attribute('site')")?.fields, ["site"]);
    assert.deepEqual(qgisExpressionReferences("@position_horizontal_accuracy")?.fields, []);
    assert.equal(qgisExpressionReferences("1 +"), null);
  });

  it("leaves text alone when asked to replace an empty string", () => {
    assert.equal(value("replace('abc', '', 'x')"), "abc");
    assert.equal(value("replace('a-b-c', '-', '')"), "abc");
  });

  it("reports syntax errors and unsupported functions without throwing", () => {
    assert.equal(parseQgisExpression("1 +").ok, false);
    assert.equal(parseQgisExpression("'open").ok, false);
    assert.equal(evaluateQgisExpression("get_feature('a', 'b', 1)").ok, false);
    assert.equal(qgisExpressionProblem("uuid()"), null);
    assert.equal(qgisExpressionProblem("coalesce(@cloud_name, @user_full_name)"), null);
    assert.equal(
      qgisExpressionProblem(`attribute(get_feature('apiary', 'uuid', "apiary_uuid"), 'fid')`),
      "attribute(), get_feature()",
    );
    assert.equal(qgisExpressionProblem("$area"), "$area");
    assert.match(qgisExpressionProblem("1 +") ?? "", /Unexpected end/);
  });

  it("cannot reach anything outside its function table", () => {
    for (const source of ["constructor()", "__proto__()", "toString()", "hasOwnProperty('a')"]) {
      assert.equal(evaluateQgisExpression(source).ok, false, source);
    }
    assert.equal(value("constructor"), null);
    assert.equal(value("attribute('constructor')", { properties: { a: 1 } }), null);
    assert.equal(value("attribute('__proto__')", { properties: { a: 1 } }), null);
    assert.equal(value("@__proto__"), null);
    assert.equal(parseQgisExpression("(".repeat(200) + "1" + ")".repeat(200)).ok, false);
  });
});

describe("QGIS constraint to MapLibre expression", () => {
  function passes(source: string, properties: Record<string, unknown>): boolean {
    const translated = qgisExpressionToMapLibre(source);
    assert.ok(translated, `${source} did not translate`);
    const result = evaluateMapExpression(translated, {
      feature: { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties },
      expectedType: "boolean",
    });
    assert.equal(result.kind, "value", JSON.stringify(result));
    return result.kind === "value" && result.value === true;
  }

  it("translates a range check on a field", () => {
    const source = "1 <= nbr_of_boxes and nbr_of_boxes <= 10";
    assert.equal(passes(source, { nbr_of_boxes: 4 }), true);
    assert.equal(passes(source, { nbr_of_boxes: 11 }), false);
  });

  it("translates a text length check, treating a missing value as empty", () => {
    assert.equal(passes("length(beekeeper)>1", { beekeeper: "Jo" }), true);
    assert.equal(passes("length(beekeeper)>1", { beekeeper: "J" }), false);
    assert.equal(passes("length(beekeeper)>1", {}), false);
  });

  it("translates null tests, IN and string comparison", () => {
    assert.equal(passes('"status" is not null', { status: "ok" }), true);
    assert.equal(passes('"status" is not null', {}), false);
    assert.equal(passes("kind in ('a', 'b') or kind = 'z'", { kind: "z" }), true);
    assert.equal(passes("not (upper(code) = 'X')", { code: "x" }), false);
  });

  it("declines what it cannot express", () => {
    assert.equal(qgisExpressionToMapLibre("@position_coordinate is not null"), null);
    assert.equal(qgisExpressionToMapLibre("now() > review_date"), null);
    assert.equal(qgisExpressionToMapLibre("regexp_match(code, '^A')"), null);
    // to_int() truncates; MapLibre has no integer conversion to match it.
    assert.equal(qgisExpressionToMapLibre("to_int(depth) = 1"), null);
    assert.equal(qgisExpressionToMapLibre("42"), null);
  });
});

describe("attribute form default values", () => {
  const form: AttributeFormConfig = {
    fields: [
      { field: "uuid", widget: "text", defaultValue: "uuid('WithoutBraces')" },
      { field: "visited", widget: "date", defaultValue: "now()" },
      { field: "logged_at", widget: "text", defaultValue: "now()" },
      { field: "accuracy", widget: "number", defaultValue: "@position_horizontal_accuracy" },
      { field: "locked", widget: "checkbox", defaultValue: "@position_coordinate is not null" },
      {
        field: "photo",
        widget: "text",
        defaultValue: `"site" || '_' || left("uuid", 8) || '.jpg'`,
      },
      { field: "broken", widget: "text", defaultValue: "get_feature('a', 'b', 1)" },
      { field: "site", widget: "text" },
    ],
  };

  it("fills each field in the form its widget expects", () => {
    const defaults = computeAttributeFormDefaults(form, {
      ...context,
      properties: { site: "A1" },
      variables: { position_horizontal_accuracy: 3.2 },
    });
    assert.deepEqual(defaults, {
      uuid: "11111111-2222-4333-8444-555555555555",
      visited: "2026-11-11",
      logged_at: "2026-11-11T16:05:09",
      accuracy: "3.2",
      locked: "false",
      // Built on the uuid default computed earlier in the same pass.
      photo: "A1_11111111.jpg",
    });
  });

  it("leaves skipped fields and NULL results alone", () => {
    const defaults = computeAttributeFormDefaults(form, context, { skip: new Set(["uuid"]) });
    assert.equal("uuid" in defaults, false);
    assert.equal("accuracy" in defaults, false);
    assert.equal("broken" in defaults, false);
  });
});
