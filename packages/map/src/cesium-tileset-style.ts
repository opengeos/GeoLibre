import type { GeoLibreLayer } from "@geolibre/core";
import { isHexColor, vectorColorExpression } from "@geolibre/core";

// 3D Tiles styling on the globe (issue #2290).
//
// A tileset's features carry attributes, and Cesium can classify them through
// `Cesium3DTileStyle` — but that style is written in the 3D Tiles styling
// language (`${height} > 100`, `color('#f00', 0.5)`), not in the MapLibre
// expressions every other GeoLibre symbology compiles to. This module is the
// translator, so a 3D Tiles layer classifies from exactly the fields the Style
// panel already writes (`vectorStyleMode`, the stops, the rule tree) rather
// than from a second, tileset-only symbology model.
//
// Translation is deliberately partial. `@geolibre/core` emits a small, known
// set of shapes for colour (`match`, `step`, `case`, a literal) and for
// filters (comparisons, `all`/`any`/`!`, `has`, `in`), and those are what this
// covers. Anything else — a hand-written `interpolate`, a `coalesce`, a
// feature-state read — returns null, and the caller leaves the tileset
// unstyled rather than guessing: an unstyled tileset draws its own colours,
// where a half-translated style would draw the wrong ones.

/** A `Cesium3DTileStyle` constructor argument, as plain JSON. */
export interface TilesetStyleSpec {
  /** Per-feature colour, as an expression or a first-match-wins condition list. */
  color?: string | { conditions: [string, string][] };
  /** Per-feature visibility expression. */
  show?: string;
}

/** Colour used when a style names none: the shared vector-layer default. */
const DEFAULT_TILESET_COLOR = "#3b82f6";

/** A property name Cesium can interpolate directly as `${name}`. */
const SIMPLE_PROPERTY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** A property read, quoted through `feature[...]` when the name is not an identifier. */
function propertyRef(name: string): string {
  return SIMPLE_PROPERTY.test(name) ? `\${${name}}` : `\${feature[${JSON.stringify(name)}]}`;
}

/**
 * A `color(...)` call for a CSS colour and alpha.
 *
 * Only the hex colours the Style panel and the colour ramps produce are
 * accepted. A named or `rgba()` colour would also parse in the styling
 * language, but it reaches here from hand-authored projects too, and the
 * string is interpolated into an expression Cesium then compiles — so
 * anything unrecognized falls back rather than being passed through.
 */
function colorCall(css: string, alpha: number): string {
  const colour = isHexColor(css) ? css : DEFAULT_TILESET_COLOR;
  return `color('${colour}', ${clamp01(alpha)})`;
}

/** A literal value as a styling-language token, or null when it has no form there. */
function literal(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (value === null) return "null";
  return null;
}

/**
 * Translate one MapLibre expression node into the 3D Tiles styling language.
 *
 * @param node - A MapLibre expression, or a literal operand.
 * @returns The equivalent expression string, or null when this node has no
 *   equivalent (which fails the whole translation, by design).
 */
export function tilesetExpression(node: unknown): string | null {
  if (!Array.isArray(node)) return literal(node);
  const [op, ...args] = node as [unknown, ...unknown[]];
  if (typeof op !== "string") return null;

  switch (op) {
    case "literal":
      return literal(args[0]);
    case "get": {
      // Only the one-argument form: `["get", name, object]` reads a property
      // off some other object, which a tileset feature has no counterpart for.
      if (args.length !== 1 || typeof args[0] !== "string") return null;
      return propertyRef(args[0]);
    }
    case "has": {
      if (args.length !== 1 || typeof args[0] !== "string") return null;
      return `defined(${propertyRef(args[0])})`;
    }
    case "to-string":
    case "to-number": {
      const inner = tilesetExpression(args[0]);
      if (inner === null) return null;
      // A `to-number` fallback (the second argument core's `step` compiler
      // passes) has no styling-language form; the cast alone yields NaN for a
      // missing property, which compares false in every condition — the same
      // outcome as landing in the catch-all class.
      return op === "to-string" ? `String(${inner})` : `Number(${inner})`;
    }
    case "==":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (args.length !== 2) return null;
      const left = tilesetExpression(args[0]);
      const right = tilesetExpression(args[1]);
      if (left === null || right === null) return null;
      const cesiumOp = op === "==" ? "===" : op === "!=" ? "!==" : op;
      return `(${left} ${cesiumOp} ${right})`;
    }
    case "!": {
      if (args.length !== 1) return null;
      const inner = tilesetExpression(args[0]);
      return inner === null ? null : `(!${inner})`;
    }
    case "all":
    case "any": {
      if (args.length === 0) return op === "all" ? "true" : "false";
      const parts: string[] = [];
      for (const arg of args) {
        const part = tilesetExpression(arg);
        if (part === null) return null;
        parts.push(part);
      }
      return `(${parts.join(op === "all" ? " && " : " || ")})`;
    }
    case "in": {
      // `["in", needle, ["literal", [...]]]` and the legacy variadic form.
      if (args.length < 2) return null;
      const needle = tilesetExpression(args[0]);
      if (needle === null) return null;
      const rest = args.slice(1);
      const values =
        rest.length === 1 && Array.isArray(rest[0]) && (rest[0] as unknown[])[0] === "literal"
          ? (rest[0] as [string, unknown])[1]
          : rest;
      if (!Array.isArray(values) || values.length === 0) return "false";
      const parts: string[] = [];
      for (const value of values) {
        const token = literal(value);
        if (token === null) return null;
        parts.push(`(${needle} === ${token})`);
      }
      return `(${parts.join(" || ")})`;
    }
    default:
      return null;
  }
}

/**
 * The colour conditions for a MapLibre colour value.
 *
 * Cesium evaluates a condition list top to bottom and takes the first match,
 * which is how all three of core's colour shapes already behave: `match` on a
 * label, `case` on a rule filter, and `step` on an ascending break list —
 * inverted here to descending, so "the highest break this feature clears"
 * wins on the first hit rather than the lowest.
 */
function colorConditions(value: unknown, alpha: number): [string, string][] | null {
  if (typeof value === "string") return [["true", colorCall(value, alpha)]];
  if (!Array.isArray(value)) return null;
  const [op, ...args] = value as [unknown, ...unknown[]];

  if (op === "match") {
    const input = tilesetExpression(args[0]);
    if (input === null || args.length < 4 || args.length % 2 !== 0) return null;
    const conditions: [string, string][] = [];
    for (let i = 1; i + 1 < args.length; i += 2) {
      const label = args[i];
      const colour = args[i + 1];
      if (typeof colour !== "string") return null;
      // A `match` label may be one value or a list of them.
      const labels = Array.isArray(label) ? label : [label];
      const tests: string[] = [];
      for (const one of labels) {
        const token = literal(one);
        if (token === null) return null;
        tests.push(`(${input} === ${token})`);
      }
      conditions.push([tests.join(" || "), colorCall(colour, alpha)]);
    }
    const fallback = args[args.length - 1];
    if (typeof fallback !== "string") return null;
    conditions.push(["true", colorCall(fallback, alpha)]);
    return conditions;
  }

  if (op === "step") {
    const input = tilesetExpression(args[0]);
    if (input === null || args.length < 4 || args.length % 2 !== 0) return null;
    const base = args[1];
    if (typeof base !== "string") return null;
    const steps: { stop: number; colour: string }[] = [];
    for (let i = 2; i + 1 < args.length; i += 2) {
      const stop = args[i];
      const colour = args[i + 1];
      if (typeof stop !== "number" || !Number.isFinite(stop) || typeof colour !== "string")
        return null;
      steps.push({ stop, colour });
    }
    const conditions: [string, string][] = steps
      .slice()
      .reverse()
      .map(({ stop, colour }): [string, string] => [
        `(${input} >= ${stop})`,
        colorCall(colour, alpha),
      ]);
    conditions.push(["true", colorCall(base, alpha)]);
    return conditions;
  }

  if (op === "case") {
    if (args.length < 3 || args.length % 2 !== 1) return null;
    const conditions: [string, string][] = [];
    for (let i = 0; i + 1 < args.length; i += 2) {
      const test = tilesetExpression(args[i]);
      const colour = args[i + 1];
      if (test === null || typeof colour !== "string") return null;
      conditions.push([test, colorCall(colour, alpha)]);
    }
    const fallback = args[args.length - 1];
    if (typeof fallback !== "string") return null;
    conditions.push(["true", colorCall(fallback, alpha)]);
    return conditions;
  }

  return null;
}

/**
 * Compile a layer's symbology and filters into a `Cesium3DTileStyle` spec.
 *
 * @param layer - The store layer being drawn as a tileset.
 * @param opacity - The layer's effective opacity (story overrides applied).
 * @param filter - The layer's composed per-feature filter, as the caller's
 *   `composeLayerFeatureFilter` builds it, or null when nothing filters it.
 *   Passed in rather than composed here so this module stays a pure translator
 *   with no import back into the layer sync.
 * @returns The style spec, or null when the layer neither classifies nor
 *   filters and draws at full opacity — the case where the tileset should keep
 *   its own colours untouched.
 */
export function compileTilesetStyle(
  layer: GeoLibreLayer,
  opacity: number,
  filter: unknown[] | null,
): TilesetStyleSpec | null {
  const style = layer.style ?? {};
  const alpha = clamp01(opacity);
  const spec: TilesetStyleSpec = {};

  const colourValue = vectorColorExpression(
    style as Parameters<typeof vectorColorExpression>[0],
    style.fillColor || DEFAULT_TILESET_COLOR,
  );
  const classified = Array.isArray(colourValue);
  if (classified) {
    const conditions = colorConditions(colourValue, alpha);
    // An untranslatable classification leaves the tileset's own colours alone
    // rather than flattening every feature to the fallback colour, which would
    // read as "the classification worked and every feature is in one class".
    if (conditions) spec.color = { conditions };
  } else if (alpha < 1) {
    // Nothing classifies, so only the opacity needs to reach the tileset.
    // White multiplies through Cesium's default HIGHLIGHT blend, so textured
    // tiles (Google Photorealistic, a scanned mesh) fade without being tinted.
    spec.color = `color('#ffffff', ${alpha})`;
  }

  if (filter) {
    const show = tilesetExpression(filter);
    // A filter that cannot be translated shows everything. Hiding features on
    // a guess is the worse failure: the user would read the missing ones as
    // absent from the data.
    if (show !== null) spec.show = show;
  }

  return spec.color === undefined && spec.show === undefined ? null : spec;
}

/** A key that changes whenever {@link compileTilesetStyle} would produce a different spec. */
export function tilesetStyleKey(spec: TilesetStyleSpec | null): string {
  return spec ? JSON.stringify(spec) : "";
}
