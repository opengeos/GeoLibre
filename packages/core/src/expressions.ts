import { Color, createExpression } from "@maplibre/maplibre-gl-style-spec";
import type { StyleExpression } from "@maplibre/maplibre-gl-style-spec";
import type { Feature } from "geojson";
import { featureSelectionId } from "./selection";

/**
 * Shared Expression Builder logic (GH #1306): a curated MapLibre expression
 * function reference, real parse/type validation via the MapLibre style spec,
 * live preview evaluation against a sample feature, `@`-style variable
 * substitution, and attribute field type inference. The UI dialog that
 * consumes this lives in the desktop app; keeping the logic here lets every
 * expression entry point (rule filters, expression style mode, labels, and
 * later the field calculator and atlas) share one implementation.
 */

/** One documented function/operator the builder can insert. */
export interface ExpressionFunctionDoc {
  /** The MapLibre operator name, e.g. `get` or `==`. */
  name: string;
  /** The snippet inserted into the expression text (valid JSON). */
  snippet: string;
  /**
   * i18n key suffix (under `style.expressionBuilder.functions`) for the
   * one-line description. Kept as a suffix so this package stays free of
   * i18next; the app resolves it with `t()`.
   */
  docKey: string;
}

/** A group of related functions shown as one section of the reference tree. */
export interface ExpressionFunctionCategory {
  /** Stable key, also the i18n suffix under `style.expressionBuilder.categories`. */
  key: string;
  functions: ExpressionFunctionDoc[];
}

const fn = (name: string, snippet: string, docKey: string): ExpressionFunctionDoc => ({
  name,
  snippet,
  docKey,
});

/**
 * The curated function reference, grouped by category. Snippets are valid,
 * standalone-compilable MapLibre expressions (enforced by tests) so inserting
 * one into an empty editor always yields a working starting point.
 */
export const EXPRESSION_FUNCTION_CATEGORIES: ExpressionFunctionCategory[] = [
  {
    key: "data",
    functions: [
      fn("get", '["get", "field"]', "get"),
      fn("has", '["has", "field"]', "has"),
      fn("id", '["id"]', "id"),
      fn("properties", '["properties"]', "properties"),
      fn("geometry-type", '["geometry-type"]', "geometryType"),
      fn("at", '["at", 0, ["literal", [1, 2, 3]]]', "at"),
      fn("in", '["in", "value", ["get", "field"]]', "in"),
      fn("index-of", '["index-of", "value", ["get", "field"]]', "indexOf"),
      fn("length", '["length", ["get", "field"]]', "length"),
      fn("literal", '["literal", ["a", "b"]]', "literal"),
      fn("typeof", '["typeof", ["get", "field"]]', "typeofOp"),
    ],
  },
  {
    key: "decision",
    functions: [
      fn("case", '["case", ["==", ["get", "field"], "value"], "#ff0000", "#cccccc"]', "caseOp"),
      fn(
        "match",
        '["match", ["get", "field"], "a", "#2563eb", "b", "#16a34a", "#94a3b8"]',
        "match",
      ),
      fn("coalesce", '["coalesce", ["get", "field"], "fallback"]', "coalesce"),
      fn("==", '["==", ["get", "field"], "value"]', "eq"),
      fn("!=", '["!=", ["get", "field"], "value"]', "neq"),
      fn(">", '[">", ["get", "field"], 0]', "gt"),
      fn(">=", '[">=", ["get", "field"], 0]', "gte"),
      fn("<", '["<", ["get", "field"], 0]', "lt"),
      fn("<=", '["<=", ["get", "field"], 0]', "lte"),
      fn("all", '["all", [">", ["get", "field"], 0], ["<", ["get", "field"], 100]]', "all"),
      fn("any", '["any", ["==", ["get", "field"], "a"], ["==", ["get", "field"], "b"]]', "any"),
      fn("!", '["!", ["has", "field"]]', "not"),
    ],
  },
  {
    key: "math",
    functions: [
      fn("+", '["+", ["get", "field"], 1]', "add"),
      fn("-", '["-", ["get", "field"], 1]', "subtract"),
      fn("*", '["*", ["get", "field"], 2]', "multiply"),
      fn("/", '["/", ["get", "field"], 2]', "divide"),
      fn("%", '["%", ["get", "field"], 2]', "modulo"),
      fn("^", '["^", ["get", "field"], 2]', "power"),
      fn("abs", '["abs", ["get", "field"]]', "abs"),
      fn("ceil", '["ceil", ["get", "field"]]', "ceil"),
      fn("floor", '["floor", ["get", "field"]]', "floor"),
      fn("round", '["round", ["get", "field"]]', "round"),
      fn("sqrt", '["sqrt", ["get", "field"]]', "sqrt"),
      fn("ln", '["ln", ["get", "field"]]', "ln"),
      fn("log10", '["log10", ["get", "field"]]', "log10"),
      fn("min", '["min", ["get", "field"], 0]', "min"),
      fn("max", '["max", ["get", "field"], 0]', "max"),
    ],
  },
  {
    key: "string",
    functions: [
      fn("concat", '["concat", ["get", "field"], " suffix"]', "concat"),
      fn("upcase", '["upcase", ["get", "field"]]', "upcase"),
      fn("downcase", '["downcase", ["get", "field"]]', "downcase"),
      fn("slice", '["slice", ["get", "field"], 0, 3]', "slice"),
    ],
  },
  {
    key: "conversion",
    functions: [
      fn("to-number", '["to-number", ["get", "field"]]', "toNumber"),
      fn("to-string", '["to-string", ["get", "field"]]', "toString"),
      fn("to-boolean", '["to-boolean", ["get", "field"]]', "toBoolean"),
      fn("to-color", '["to-color", "#2563eb"]', "toColor"),
    ],
  },
  {
    key: "camera",
    functions: [
      fn("zoom", '["zoom"]', "zoom"),
      fn(
        "interpolate",
        '["interpolate", ["linear"], ["zoom"], 5, ["to-color", "#2563eb"], 12, ["to-color", "#dc2626"]]',
        "interpolate",
      ),
      fn("step", '["step", ["zoom"], "#2563eb", 10, "#dc2626"]', "step"),
      fn("rgb", '["rgb", 37, 99, 235]', "rgb"),
      fn("rgba", '["rgba", 37, 99, 235, 0.5]', "rgba"),
    ],
  },
];

/**
 * Strips commas that directly precede a closing bracket/brace outside of
 * strings, so user-typed expressions with trailing commas still parse.
 * Shared by {@link parseJsonExpression} (vector-color) and the builder.
 */
export function removeTrailingJsonCommas(value: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      const nextSignificant = value.slice(index + 1).match(/\S/)?.[0];
      if (nextSignificant === "]" || nextSignificant === "}") continue;
    }

    result += char;
  }

  return result;
}

/** Result types the builder can require of a whole expression. */
export type ExpressionExpectedType = "boolean" | "color" | "string" | "number";

/** Options for {@link validateMapExpression}. */
export interface ValidateMapExpressionOptions {
  /**
   * Variables substituted before compiling, so a numeric `@token` used in a
   * numeric slot type-checks against its value instead of the raw string.
   */
  variables?: ExpressionVariable[];
  /**
   * When set, the style spec type-checks the expression's result against
   * this type (e.g. a filter must produce a boolean), rejecting expressions
   * that compile but cannot fit the destination.
   */
  expectedType?: ExpressionExpectedType;
}

/**
 * Builds the minimal property spec that makes `createExpression` enforce a
 * result type while still allowing zoom- and feature-dependent input.
 *
 * This mirrors the (unexported) `StylePropertySpecification` shape that
 * `@maplibre/maplibre-gl-style-spec` expects — the cast below means the
 * compiler cannot catch a change to that contract, so whenever the
 * style-spec package is bumped (including Dependabot PRs) re-check that
 * expected-type enforcement still works. The "enforces an expected result
 * type" test in `tests/expressions.test.ts` fails if this shape stops
 * being honored.
 */
function propertySpecFor(expectedType: ExpressionExpectedType) {
  return {
    type: expectedType,
    "property-type": "data-driven",
    expression: { parameters: ["zoom", "feature"] },
  } as unknown as Parameters<typeof createExpression>[1];
}

/** Outcome of validating an expression source string. */
export interface ExpressionValidation {
  ok: boolean;
  /**
   * Failure class, for callers that want to localize the shape errors:
   * `not-json` / `not-array` / `not-operator` are structural, `compile` means
   * the style spec rejected it (with messages in {@link errors}).
   */
  code?: "not-json" | "not-array" | "not-operator" | "compile";
  /** Human-readable problems; empty when `ok`. */
  errors: string[];
  /** The parsed JSON array when the source at least parsed as JSON. */
  parsed?: unknown[];
}

/**
 * Validates a user-entered MapLibre expression: tolerant JSON parse, shape
 * checks, then a real compile through the MapLibre style spec so operator
 * misuse (wrong arity, unknown operator, type mismatch) is caught in the
 * dialog instead of silently failing on the map. Variables are substituted
 * before compiling (so tokens type-check as their values), and
 * `expectedType` additionally enforces the destination's result type. The
 * returned `parsed` array is the raw, unsubstituted parse. An empty/blank
 * source is valid (surfaces treat it as "no expression").
 */
export function validateMapExpression(
  source: string,
  options: ValidateMapExpressionOptions = {},
): ExpressionValidation {
  return compileMapExpression(source, options).validation;
}

/**
 * The single parse + substitute + compile pass shared by validation and
 * preview evaluation, so a preview never compiles the same source twice.
 * `expression` is set only when the validation succeeded on a non-empty
 * source.
 */
function compileMapExpression(
  source: string,
  options: ValidateMapExpressionOptions,
): { validation: ExpressionValidation; expression?: StyleExpression } {
  const trimmed = source.trim();
  if (!trimmed) return { validation: { ok: true, errors: [] } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(removeTrailingJsonCommas(trimmed));
  } catch (error) {
    return {
      validation: {
        ok: false,
        code: "not-json",
        errors: [error instanceof Error ? error.message : "Invalid JSON"],
      },
    };
  }
  if (!Array.isArray(parsed)) {
    return { validation: { ok: false, code: "not-array", errors: [] } };
  }
  if (typeof parsed[0] !== "string") {
    return {
      validation: { ok: false, code: "not-operator", errors: [], parsed },
    };
  }

  const substituted = substituteExpressionVariables(parsed, options.variables ?? []) as unknown[];
  const compiled = createExpression(
    substituted,
    options.expectedType ? propertySpecFor(options.expectedType) : undefined,
  );
  if (compiled.result === "error") {
    return {
      validation: {
        ok: false,
        code: "compile",
        errors: compiled.value.map((issue) =>
          issue.key ? `${issue.key}: ${issue.message}` : issue.message,
        ),
        parsed,
      },
    };
  }
  return { validation: { ok: true, errors: [], parsed }, expression: compiled.value };
}

/** A named `@` variable with its current value. */
export interface ExpressionVariable {
  /** Token including the `@` prefix, e.g. `@project_name`. */
  token: string;
  value: string | number | boolean;
}

/**
 * Replaces every string node that exactly matches a known `@token` with that
 * variable's value, returning a new structure (the input is not mutated).
 * Unknown `@` strings are left untouched so field values that happen to start
 * with `@` never get mangled.
 */
export function substituteExpressionVariables(
  node: unknown,
  variables: ExpressionVariable[],
): unknown {
  if (typeof node === "string" && node.startsWith("@")) {
    const match = variables.find((variable) => variable.token === node);
    return match ? match.value : node;
  }
  if (Array.isArray(node)) {
    return node.map((entry) => substituteExpressionVariables(entry, variables));
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => [
        key,
        substituteExpressionVariables(value, variables),
      ]),
    );
  }
  return node;
}

/** Result of a live preview evaluation. */
export interface ExpressionPreview {
  kind: "empty" | "error" | "value";
  /** Problems when `kind` is "error" (parse or runtime). */
  errors?: string[];
  /** The evaluated value when `kind` is "value". */
  value?: unknown;
}

/** Options for {@link evaluateMapExpression}. */
export interface EvaluateMapExpressionOptions {
  /** The sample feature the expression is evaluated against. */
  feature?: Feature | null;
  /** Map zoom used for `["zoom"]`; defaults to 0. */
  zoom?: number;
  /** Variables substituted before compiling. */
  variables?: ExpressionVariable[];
  /** Enforce the destination's result type, as in validation. */
  expectedType?: ExpressionExpectedType;
}

/**
 * Evaluates an expression source against a sample feature for the builder's
 * live preview. Variables are substituted first, then the expression is
 * compiled with the MapLibre style spec and evaluated with the given zoom.
 * Runtime failures (e.g. `to-color` on garbage) come back as errors instead
 * of throwing.
 */
export function evaluateMapExpression(
  source: string,
  options: EvaluateMapExpressionOptions = {},
): ExpressionPreview {
  const trimmed = source.trim();
  if (!trimmed) return { kind: "empty" };

  const { validation, expression } = compileMapExpression(trimmed, {
    variables: options.variables,
    expectedType: options.expectedType,
  });
  if (!validation.ok || !expression) {
    return { kind: "error", errors: validation.errors };
  }

  const feature = options.feature ?? null;
  const geometryType = feature?.geometry?.type ?? "Unknown";
  try {
    // evaluateWithoutErrorHandling: the plain evaluate() swallows runtime
    // failures into console.warn, which (a) hides the error from the preview
    // and (b) feeds the app's diagnostics console interceptor from inside a
    // React render, which can re-render the panel and re-evaluate in an
    // endless loop. Throwing lets the catch below surface the message.
    const value = expression.evaluateWithoutErrorHandling({ zoom: options.zoom ?? 0 }, {
      type: geometryType,
      properties: feature?.properties ?? {},
      ...(feature?.id !== undefined ? { id: feature.id } : {}),
      geometry: feature?.geometry,
    } as never);
    return { kind: "value", value };
  } catch (error) {
    return {
      kind: "error",
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * A compiled per-feature evaluator: the expression is parsed and compiled
 * once, then `evaluate` runs it against each feature. `evaluate` is absent
 * when compilation failed (see `errors`); it throws on runtime evaluation
 * failures (same rationale as {@link evaluateMapExpression}: throwing keeps
 * errors out of console.warn) so callers decide per-feature error handling.
 */
export interface CompiledFeatureExpression {
  ok: boolean;
  /** Parse/compile problems when `ok` is false. */
  errors: string[];
  evaluate?: (feature: Feature) => unknown;
}

/**
 * Compiles an expression source once for bulk per-feature evaluation (virtual
 * fields, and any other caller that runs one expression over a whole layer).
 * Unlike {@link evaluateMapExpression} the compile cost is paid once, not per
 * feature. An empty source is reported as a failure with no errors — there is
 * nothing to evaluate.
 */
export function compileFeatureExpression(
  source: string,
  options: {
    zoom?: number;
    variables?: ExpressionVariable[];
    expectedType?: ExpressionExpectedType;
  } = {},
): CompiledFeatureExpression {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, errors: [] };

  const { validation, expression } = compileMapExpression(trimmed, {
    variables: options.variables,
    expectedType: options.expectedType,
  });
  if (!validation.ok || !expression) {
    return { ok: false, errors: validation.errors };
  }
  const zoom = options.zoom ?? 0;
  return {
    ok: true,
    errors: [],
    evaluate: (feature) =>
      expression.evaluateWithoutErrorHandling({ zoom }, {
        type: feature.geometry?.type ?? "Unknown",
        properties: feature.properties ?? {},
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        geometry: feature.geometry,
      } as never),
  };
}

/** Result of matching a feature array against a boolean expression. */
export interface FeatureExpressionMatches {
  /** False when the expression failed to parse or compile. */
  ok: boolean;
  /** Parse/compile problems when `ok` is false. */
  errors: string[];
  /** Selection ids ({@link featureSelectionId}) of the matched features. */
  ids: string[];
  /**
   * Features whose evaluation threw at runtime (e.g. a boolean assertion on
   * a string field). Counted as non-matches so one bad feature cannot abort
   * the whole selection, but surfaced so the UI can warn.
   */
  errorCount: number;
}

/**
 * Evaluates a boolean expression against every feature and returns the
 * selection ids of the matches (Select by Expression). Unlike
 * {@link evaluateMapExpression} this compiles the source once and reuses the
 * compiled expression across the whole array, so it stays fast on large
 * layers. An empty source is reported as `ok: false` with no errors — there
 * is nothing to select by.
 */
export function matchFeaturesByExpression(
  features: readonly Feature[],
  source: string,
  options: { zoom?: number; variables?: ExpressionVariable[] } = {},
): FeatureExpressionMatches {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, errors: [], ids: [], errorCount: 0 };

  const { validation, expression } = compileMapExpression(trimmed, {
    variables: options.variables,
    expectedType: "boolean",
  });
  if (!validation.ok || !expression) {
    return { ok: false, errors: validation.errors, ids: [], errorCount: 0 };
  }

  const ids: string[] = [];
  let errorCount = 0;
  features.forEach((feature, index) => {
    try {
      // Same rationale as evaluateMapExpression: evaluateWithoutErrorHandling
      // so runtime failures throw instead of feeding console.warn.
      const value = expression.evaluateWithoutErrorHandling({ zoom: options.zoom ?? 0 }, {
        type: feature.geometry?.type ?? "Unknown",
        properties: feature.properties ?? {},
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        geometry: feature.geometry,
      } as never);
      if (value === true) ids.push(featureSelectionId(feature, index));
    } catch {
      errorCount += 1;
    }
  });
  return { ok: true, errors: [], ids, errorCount };
}

/**
 * True when a preview value is a real style-spec `Color` instance (its
 * evaluated color representation: premultiplied r/g/b/a floats). Shared by
 * the preview formatter and the dialog's color-swatch rendering so the two
 * checks cannot drift apart. An instanceof check (not duck typing) so user
 * attribute data that happens to carry numeric r/g/b/a fields (e.g. via
 * `["properties"]`) is never misclassified as a color.
 */
export function isStyleSpecColor(
  value: unknown,
): value is { r: number; g: number; b: number; a: number } {
  return value instanceof Color;
}

/**
 * Renders a preview value as a short display string: style-spec Color
 * instances become rgba() strings, plain values render as JSON, and
 * `null`/`undefined` render as "null".
 */
export function formatExpressionPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (isStyleSpecColor(value)) {
    const color = value;
    // Style-spec colors are premultiplied floats in [0, 1]; undo the
    // premultiplication so the displayed rgba matches the authored color.
    const alpha = color.a;
    const channel = (component: number) => Math.round((alpha === 0 ? 0 : component / alpha) * 255);
    return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${Number(alpha.toFixed(3))})`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Attribute field types the builder badges fields with. */
export type ExpressionFieldType = "string" | "number" | "boolean" | "mixed" | "unknown";

/**
 * Infers a display type for each named field by scanning feature properties:
 * a single consistent primitive type wins, disagreements become "mixed", and
 * fields with no non-null values are "unknown".
 */
export function inferFieldTypes(
  features: ReadonlyArray<{ properties?: Record<string, unknown> | null }>,
  names: string[],
): Record<string, ExpressionFieldType> {
  const result: Record<string, ExpressionFieldType> = {};
  for (const name of names) result[name] = "unknown";

  for (const feature of features) {
    const properties = feature.properties;
    if (!properties) continue;
    for (const name of names) {
      const value = properties[name];
      if (value === null || value === undefined) continue;
      const valueType = typeof value;
      const fieldType: ExpressionFieldType =
        valueType === "string" || valueType === "number" || valueType === "boolean"
          ? valueType
          : "mixed";
      if (result[name] === "unknown") result[name] = fieldType;
      else if (result[name] !== fieldType) result[name] = "mixed";
    }
  }
  return result;
}
