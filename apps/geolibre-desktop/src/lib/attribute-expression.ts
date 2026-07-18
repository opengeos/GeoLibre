/**
 * A small, self-contained expression evaluator for the attribute-table Field
 * Calculator. Expressions are plain JavaScript so familiar arithmetic, string,
 * and ternary syntax all work (e.g. `pop / area`, `upper(name)`,
 * `pop > 100 ? "big" : "small"`). They run on the user's own data in the local
 * webview — analogous to a spreadsheet formula bar — so the evaluator favors
 * ergonomics over a hardened sandbox. It is NOT a security boundary; it must
 * never be used to run expressions from an untrusted source.
 *
 * Field values are exposed two ways:
 *  - as bare identifiers when the field name is a valid JS identifier (`pop`),
 *  - always through the `props` object so fields with spaces/punctuation are
 *    reachable as `props["my field"]`.
 * A curated set of helper functions, the `$index` (row position) variable, and
 * the geometry helpers `$length`/`$perimeter`/`$area` (which measure the
 * feature's own geometry) are also in scope.
 */
import type { Geometry } from "geojson";
import {
  measureArea,
  measureLength,
  measurePerimeter,
  type AreaUnit,
  type DistanceUnit,
} from "./geometry-measure";

/** A helper exposed to expressions by name. */
type Helper = (...args: unknown[]) => unknown;

function toNumber(value: unknown): number {
  if (value == null || value === "") return Number.NaN;
  return Number(value);
}

function isNullish(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isNaN(value));
}

/**
 * Helper functions available inside an expression. Kept small and GIS-flavored;
 * arithmetic/comparison/ternary come for free from JavaScript itself.
 */
export const EXPRESSION_HELPERS: Record<string, Helper> = {
  // Math
  abs: (x) => Math.abs(toNumber(x)),
  ceil: (x) => Math.ceil(toNumber(x)),
  floor: (x) => Math.floor(toNumber(x)),
  sqrt: (x) => Math.sqrt(toNumber(x)),
  exp: (x) => Math.exp(toNumber(x)),
  ln: (x) => Math.log(toNumber(x)),
  log10: (x) => Math.log10(toNumber(x)),
  pow: (x, y) => Math.pow(toNumber(x), toNumber(y)),
  min: (...args) => Math.min(...args.map(toNumber)),
  max: (...args) => Math.max(...args.map(toNumber)),
  // round(x) → nearest integer; round(x, n) → n decimal places.
  round: (x, digits) => {
    const value = toNumber(x);
    const places = digits == null ? 0 : Math.trunc(toNumber(digits));
    if (!Number.isFinite(value) || !Number.isFinite(places)) return value;
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  },
  // Conversion
  toNumber: (x) => {
    const next = toNumber(x);
    return Number.isNaN(next) ? null : next;
  },
  // Param annotated because `toString` collides with Object.prototype's own
  // signature, which would otherwise win the contextual type over Helper.
  toString: (x: unknown) => (x == null ? "" : String(x)),
  // String
  upper: (x) => (x == null ? "" : String(x).toUpperCase()),
  lower: (x) => (x == null ? "" : String(x).toLowerCase()),
  trim: (x) => (x == null ? "" : String(x).trim()),
  length: (x) => (x == null ? 0 : String(x).length),
  concat: (...args) => args.map((a) => (a == null ? "" : String(a))).join(""),
  // (start, length) with slice semantics, so a negative start counts from the
  // end (`substr("hello", -3)` → "llo"), matching QGIS / Python / JS slice.
  substr: (x, start, len) => {
    const str = x == null ? "" : String(x);
    const from = Math.trunc(toNumber(start)) || 0;
    if (len == null) return str.slice(from);
    return str.slice(from, from + (Math.trunc(toNumber(len)) || 0));
  },
  // A null/undefined search is a no-op (returns the input); a null replacement
  // is treated as the empty string — both avoid coercing to "null"/"undefined".
  replace: (x, search, replacement) => {
    const str = x == null ? "" : String(x);
    if (search == null) return str;
    return str.split(String(search)).join(replacement == null ? "" : String(replacement));
  },
  // Logic
  isNull: (x) => isNullish(x),
  // First argument that is neither null nor NaN; null when all are nullish.
  coalesce: (...args) => {
    for (const arg of args) {
      if (!isNullish(arg)) return arg;
    }
    return null;
  },
  // iif(condition, thenValue, elseValue) — `if` is a reserved word in JS, so it
  // cannot be a bare identifier; ternaries (`cond ? a : b`) also work directly.
  // Note: unlike SQL CASE or a ternary, all three arguments are evaluated before
  // iif() runs — use a ternary when a branch may throw (e.g. null-property
  // access: `obj != null ? obj.child : "default"`).
  iif: (condition, thenValue, elseValue) => (condition ? thenValue : elseValue),
};

/** Math constants exposed as bare identifiers. */
const EXPRESSION_CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
};

/**
 * Geometry helper names, in scope as functions bound to each feature's own
 * geometry: `$length(unit)` / `$perimeter(unit)` measure a line or a polygon's
 * boundary (default meters); `$area(unit)` measures a polygon (default square
 * meters). Units mirror the Measure tool — e.g. `$area("hectares")`,
 * `$length("kilometers")`. Non-matching geometries return 0.
 */
export const GEOMETRY_HELPER_NAMES = ["$length", "$perimeter", "$area"] as const;

/** A mutable slot the geometry helpers read, updated once per evaluated row. */
interface GeometryHolder {
  geometry: Geometry | null | undefined;
}

/**
 * Build the geometry helpers for a compiled expression. They close over a
 * mutable holder (updated once per row) rather than over the geometry itself, so
 * the three closures are allocated once per compile instead of once per feature
 * during a bulk `calculateField` run.
 */
function createGeometryHelpers(holder: GeometryHolder): Helper[] {
  return [
    (unit) => measureLength(holder.geometry, unit as DistanceUnit | undefined),
    (unit) => measurePerimeter(holder.geometry, unit as DistanceUnit | undefined),
    (unit) => measureArea(holder.geometry, unit as AreaUnit | undefined),
  ];
}

/** Names that are always in scope and therefore cannot be used as field idents. */
const RESERVED_NAMES = new Set<string>([
  ...Object.keys(EXPRESSION_HELPERS),
  ...Object.keys(EXPRESSION_CONSTANTS),
  ...GEOMETRY_HELPER_NAMES,
  "props",
  "$index",
]);

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ECMAScript keywords (plus the strict-mode future-reserved words and the
// strict-mode-restricted `eval`/`arguments`) are illegal as `new Function`
// parameter names. A field whose name matches one — `class` and `type`-style
// names are common in OSM data — must fall back to the `props["name"]` path,
// otherwise compiling ANY expression for that layer throws a SyntaxError.
const JS_KEYWORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  // strict-mode future-reserved words and restricted names
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "eval",
  "arguments",
  // future-reserved in all modes
  "enum",
  // global constants — not reserved words, but as bare params they would
  // silently shadow the JS globals (e.g. a field named `NaN`).
  "undefined",
  "NaN",
  "Infinity",
]);

/**
 * Whether a field name can be exposed as a bare identifier in an expression.
 * Names that collide with a helper/constant, or with a JavaScript keyword that
 * cannot be a function parameter, fall back to `props["name"]` access — so
 * neither a helper is shadowed nor the parser is broken.
 */
export function isBareIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name) && !RESERVED_NAMES.has(name) && !JS_KEYWORDS.has(name);
}

/**
 * The snippet that references a field inside an expression: the bare name when
 * it is a safe identifier, otherwise a quoted `props[...]` lookup.
 */
export function fieldReference(name: string): string {
  return isBareIdentifier(name) ? name : `props[${JSON.stringify(name)}]`;
}

/** A compiled expression ready to run against each feature's properties. */
export interface CompiledExpression {
  evaluate: (props: Record<string, unknown>, index: number, geometry?: Geometry | null) => unknown;
}

/**
 * Compile an expression once for a known set of field names. Throws a
 * SyntaxError (with a readable message) when the expression cannot be parsed, so
 * callers can surface the problem before touching any feature.
 */
export function compileExpression(expression: string, fieldNames: string[]): CompiledExpression {
  const trimmed = expression.trim();
  if (trimmed === "") {
    throw new SyntaxError("Expression is empty.");
  }

  const bareFields = fieldNames.filter(isBareIdentifier);
  const helperNames = Object.keys(EXPRESSION_HELPERS);
  const constantNames = Object.keys(EXPRESSION_CONSTANTS);
  const argNames = [
    ...bareFields,
    ...helperNames,
    ...constantNames,
    ...GEOMETRY_HELPER_NAMES,
    "props",
    "$index",
  ];

  let fn: (...args: unknown[]) => unknown;
  try {
    // "use strict" disables `with` and silent global creation; the named
    // arguments shadow the field/helper names. It does NOT sandbox: browser
    // globals (fetch, window, …) stay reachable — see the file-level note. Safe
    // here only because calculations run immediately and the expression itself
    // is never persisted or re-evaluated from a project file.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(...argNames, `"use strict"; return (${trimmed});`) as (
      ...args: unknown[]
    ) => unknown;
  } catch (error) {
    throw new SyntaxError(error instanceof Error ? error.message : "Invalid expression.");
  }

  const helperValues = helperNames.map((name) => EXPRESSION_HELPERS[name]);
  const constantValues = constantNames.map((name) => EXPRESSION_CONSTANTS[name]);
  // Allocate the geometry helpers once and feed each row's geometry through a
  // shared holder, so a bulk calculation doesn't rebuild them per feature.
  const geometryHolder: GeometryHolder = { geometry: null };
  const geometryHelperValues = createGeometryHelpers(geometryHolder);

  return {
    evaluate(props, index, geometry) {
      geometryHolder.geometry = geometry ?? null;
      const fieldValues = bareFields.map((name) => props[name]);
      return fn(
        ...fieldValues,
        ...helperValues,
        ...constantValues,
        ...geometryHelperValues,
        props,
        index,
      );
    },
  };
}

/** Output type for a calculated field. `auto` keeps the raw computed value. */
export type CalcOutputType = "auto" | "text" | "number" | "boolean";

/**
 * Coerce a computed value to the chosen output type. `auto` passes the raw value
 * through (numbers stay numbers, strings stay strings). A value that cannot be
 * represented in the target type — a non-finite number, an unparseable text →
 * number — becomes null so a calculation never persists a type-corrupted cell.
 */
export function coerceComputedValue(value: unknown, type: CalcOutputType): unknown {
  if (value === undefined) return null;
  if (type === "auto") {
    // Normalize the JS "no result" values to null for a clean cell.
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (value === null) return null;
  if (type === "number") {
    const next = Number(value);
    return Number.isFinite(next) ? next : null;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    // Recognize the common string spellings so "0"/"no" don't become true via
    // JS truthiness (every non-empty string is truthy) — surprising to users
    // coming from SQL / QGIS / pandas.
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
    return Boolean(value);
  }
  // text
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
