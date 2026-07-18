import {
  DEFAULT_LAYER_STYLE,
  effectiveVectorRules,
  isHexColor,
  parseJsonExpression,
  styleValue,
  type GeoLibreLayer,
  type LayerStyle,
  type MarkerShape,
  type VectorRule,
  type VectorStyleStop,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { detectGeometryProfile, type GeometryProfile } from "./geojson-loader";

/**
 * OGC standardized rendering scale denominator at MapLibre/Web-Mercator zoom 0
 * (a 256px tile, 0.28mm pixel). Scale halves with each zoom level, so
 * `denominator = SCALE_AT_ZOOM_0 / 2**zoom`. Used to translate GeoLibre's zoom
 * window into SLD `Min`/`MaxScaleDenominator` and back. This is the value QGIS
 * and GeoServer use, so the exported scale bounds line up with those tools.
 */
export const OGC_SCALE_DENOMINATOR_AT_ZOOM_0 = 559082264.028717;

const MIN_LAYER_ZOOM = DEFAULT_LAYER_STYLE.minZoom;
const MAX_LAYER_ZOOM = DEFAULT_LAYER_STYLE.maxZoom;

/** Default font family written to exported `TextSymbolizer` labels. */
const DEFAULT_FONT_FAMILY = "Open Sans";

/** GeoLibre marker shapes that map onto an SLD `WellKnownName`. */
const MARKER_WELL_KNOWN_NAME: Partial<Record<MarkerShape, string>> = {
  circle: "circle",
  square: "square",
  triangle: "triangle",
  star: "star",
  cross: "cross",
};

export interface SldExportResult {
  /** A complete OGC SLD 1.0.0 document (`StyledLayerDescriptor`) as XML text. */
  sld: string;
  /**
   * Human-readable notes about anything that could not be represented exactly
   * (3D extrusion, heatmap/cluster point renderers, fill patterns, custom
   * markers, a raw color expression), so the export never fails silently. Empty
   * when the symbology mapped cleanly.
   */
  warnings: string[];
}

/**
 * The layer fields the SLD exporter reads. Kept structural (rather than the full
 * {@link GeoLibreLayer}) so it is easy to unit-test with a minimal fixture.
 */
export type SldExportableLayer = Pick<
  GeoLibreLayer,
  "id" | "name" | "type" | "style" | "opacity" | "visible"
>;

export interface SldExportOptions {
  /**
   * Font family written to exported label (`TextSymbolizer`) fonts. Defaults to
   * {@link DEFAULT_FONT_FAMILY} (a widely available default); GeoLibre has no
   * per-layer font setting, so this is the only place to influence it.
   */
  fontFamily?: string;
}

/** Escape a value for XML text/attribute content. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a number without scientific notation and without trailing zeros. */
function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // Round to a stable precision so a fold like 0.6 * 1 does not serialize as
  // 0.6000000000000001, then strip the trailing zeros/point. `|| 0` collapses a
  // negative zero (e.g. from negating a 0 offset) so it never serializes "-0".
  return String(Number(value.toFixed(6)) || 0);
}

/** One `<CssParameter name="…">value</CssParameter>` line. */
function cssParam(name: string, value: string): string {
  return `<CssParameter name="${name}">${xmlEscape(value)}</CssParameter>`;
}

/** Emit `Min`/`MaxScaleDenominator` for a zoom window narrower than [0, 24]. */
function scaleDenominators(style: LayerStyle): string[] {
  const minZoom = clampZoom(styleValue(style, "minZoom"), MIN_LAYER_ZOOM);
  const maxZoom = clampZoom(styleValue(style, "maxZoom"), MAX_LAYER_ZOOM);
  return scaleDenominatorsForWindow(minZoom, maxZoom);
}

/** `Min`/`MaxScaleDenominator` lines for an explicit zoom window. */
function scaleDenominatorsForWindow(minZoom: number, maxZoom: number): string[] {
  const low = Math.min(minZoom, maxZoom);
  const high = Math.max(minZoom, maxZoom);
  const lines: string[] = [];
  // Higher zoom ⇒ smaller scale denominator, so the layer's maxZoom sets the
  // MinScaleDenominator and its minZoom the MaxScaleDenominator.
  if (high < MAX_LAYER_ZOOM) {
    lines.push(
      `<MinScaleDenominator>${num(
        OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / 2 ** high,
      )}</MinScaleDenominator>`,
    );
  }
  if (low > MIN_LAYER_ZOOM) {
    lines.push(
      `<MaxScaleDenominator>${num(
        OGC_SCALE_DENOMINATOR_AT_ZOOM_0 / 2 ** low,
      )}</MaxScaleDenominator>`,
    );
  }
  return lines;
}

function clampZoom(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_LAYER_ZOOM, Math.max(MIN_LAYER_ZOOM, value));
}

/** The resolved fill/stroke used for one rule's symbolizers. */
interface SymbolPaint {
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  strokeOpacity: number;
  /** Per-rule circle radius override (pixels); pointSymbolizer doubles it. */
  circleRadius?: number;
}

/** Build the flat (single-symbol) paint from a style, folding in layer opacity. */
function basePaint(style: LayerStyle, opacity: number): SymbolPaint {
  return {
    fillColor: styleValue(style, "fillColor"),
    fillOpacity: styleValue(style, "fillOpacity") * opacity,
    strokeColor: styleValue(style, "strokeColor"),
    strokeWidth: styleValue(style, "strokeWidth"),
    strokeOpacity: opacity,
  };
}

function fillElement(paint: SymbolPaint): string {
  return [
    "<Fill>",
    cssParam("fill", paint.fillColor),
    cssParam("fill-opacity", num(paint.fillOpacity)),
    "</Fill>",
  ].join("");
}

function strokeElement(paint: SymbolPaint): string {
  return [
    "<Stroke>",
    cssParam("stroke", paint.strokeColor),
    cssParam("stroke-width", num(paint.strokeWidth)),
    cssParam("stroke-opacity", num(paint.strokeOpacity)),
    "</Stroke>",
  ].join("");
}

function polygonSymbolizer(paint: SymbolPaint): string {
  return `<PolygonSymbolizer>${fillElement(paint)}${strokeElement(paint)}</PolygonSymbolizer>`;
}

function lineSymbolizer(paint: SymbolPaint): string {
  return `<LineSymbolizer>${strokeElement(paint)}</LineSymbolizer>`;
}

/**
 * A point `Graphic`/`Mark`. Uses the marker shape's WellKnownName (and marker
 * color/size) when a shape marker is enabled and mappable, otherwise a circle
 * sized to the layer's circle radius (SLD `Size` is the graphic diameter).
 */
function pointSymbolizer(style: LayerStyle, paint: SymbolPaint, warnings: string[]): string {
  let wellKnownName = "circle";
  let markPaint = paint;
  let size = (paint.circleRadius ?? styleValue(style, "circleRadius")) * 2;
  let shapeMarker = false;

  if (styleValue(style, "markerEnabled")) {
    const shape = styleValue(style, "markerShape");
    const mapped = MARKER_WELL_KNOWN_NAME[shape];
    if (mapped) {
      wellKnownName = mapped;
      markPaint = {
        ...paint,
        fillColor: styleValue(style, "markerColor"),
      };
      size = styleValue(style, "markerSize");
      // A circle-shape marker is indistinguishable from the plain circle
      // renderer in SLD, so keep the real layer stroke (not the white halo) for
      // it — that way a round-trip recovers a plain circle without corrupting
      // strokeColor. Only non-circle shapes use the drawBuiltinMarker halo.
      shapeMarker = shape !== "circle";
    } else {
      warnings.push(`The "${shape}" marker has no SLD equivalent; points use a circle instead.`);
    }
  }

  // A plain circle mark takes the layer's real stroke (matching MapLibre's
  // circle-stroke-width, so the width round-trips). A built-in shape marker is
  // rasterized by GeoLibre with a fixed white halo (drawBuiltinMarker) that
  // ignores strokeColor/strokeWidth, so approximate that halo instead.
  const stroke = shapeMarker
    ? `<Stroke>${cssParam("stroke", "#ffffff")}${cssParam(
        "stroke-width",
        "1",
      )}${cssParam("stroke-opacity", num(0.9 * paint.strokeOpacity))}</Stroke>`
    : `<Stroke>${cssParam("stroke", paint.strokeColor)}${cssParam(
        "stroke-width",
        num(paint.strokeWidth),
      )}${cssParam("stroke-opacity", num(paint.strokeOpacity))}</Stroke>`;

  return [
    "<PointSymbolizer><Graphic><Mark>",
    `<WellKnownName>${wellKnownName}</WellKnownName>`,
    fillElement(markPaint),
    stroke,
    "</Mark>",
    `<Size>${num(Math.max(1, size))}</Size>`,
    "</Graphic></PointSymbolizer>",
  ].join("");
}

/** The `TextSymbolizer` for a layer whose labels are enabled, or null. */
function textSymbolizer(
  style: LayerStyle,
  opacity: number,
  fontFamily: string,
  warnings: string[],
): string | null {
  const labels = style.labels ?? DEFAULT_LAYER_STYLE.labels;
  if (!labels.enabled) return null;

  // SLD labels a single attribute via <ogc:PropertyName>; a MapLibre expression
  // (concatenation, etc.) has no direct SLD equivalent, so fall back to the
  // field and warn.
  let field = labels.field.trim();
  if (!field && labels.expression.trim()) {
    warnings.push("The label expression has no SLD equivalent; export the label field instead.");
  }
  if (!field) return null;

  const parts: string[] = ["<TextSymbolizer>"];
  parts.push(`<Label><ogc:PropertyName>${xmlEscape(field)}</ogc:PropertyName></Label>`);
  parts.push(
    `<Font>${cssParam("font-family", fontFamily)}${cssParam("font-size", num(labels.size))}</Font>`,
  );

  // Point vs line placement, with the point anchor/offset/rotation carried over.
  // A point placement with no anchor/offset/rotation is left implicit (the SLD
  // default) rather than written as an empty element.
  if (labels.placement === "line") {
    parts.push("<LabelPlacement><LinePlacement/></LabelPlacement>");
  } else {
    const anchor = anchorPoint(labels.anchor);
    const inner = [
      anchor
        ? `<AnchorPoint><AnchorPointX>${num(anchor[0])}</AnchorPointX><AnchorPointY>${num(
            anchor[1],
          )}</AnchorPointY></AnchorPoint>`
        : "",
      labels.offsetX || labels.offsetY
        ? `<Displacement><DisplacementX>${num(labels.offsetX)}</DisplacementX><DisplacementY>${num(
            -labels.offsetY,
          )}</DisplacementY></Displacement>`
        : "",
      labels.rotation ? `<Rotation>${num(labels.rotation)}</Rotation>` : "",
    ].join("");
    if (inner) {
      parts.push(`<LabelPlacement><PointPlacement>${inner}</PointPlacement></LabelPlacement>`);
    }
  }

  if (labels.haloWidth > 0) {
    parts.push(
      `<Halo><Radius>${num(labels.haloWidth)}</Radius><Fill>${cssParam(
        "fill",
        labels.haloColor,
      )}</Fill></Halo>`,
    );
  }
  parts.push(
    `<Fill>${cssParam("fill", labels.color)}${cssParam("fill-opacity", num(opacity))}</Fill>`,
  );
  parts.push("</TextSymbolizer>");
  return parts.join("");
}

/**
 * SLD `AnchorPoint` (0..1, origin bottom-left) for a MapLibre text-anchor, or
 * null for `center` (the SLD default, so it is left implicit).
 */
function anchorPoint(anchor: string): [number, number] | null {
  const x = anchor.includes("left") ? 0 : anchor.includes("right") ? 1 : 0.5;
  const y = anchor.includes("bottom") ? 0 : anchor.includes("top") ? 1 : 0.5;
  if (x === 0.5 && y === 0.5) return null;
  return [x, y];
}

/**
 * The render symbolizers (polygon/line/point) for one rule's paint, restricted
 * to the geometries the layer actually has. A missing geojson profile emits all
 * three (a safe superset), matching the Mapbox exporter.
 */
function renderSymbolizers(
  style: LayerStyle,
  paint: SymbolPaint,
  profile: GeometryProfile,
  warnings: string[],
  lineColor?: string,
): string {
  const parts: string[] = [];
  if (profile.hasPolygon) parts.push(polygonSymbolizer(paint));
  // A LineSymbolizer is only emitted for real line geometry; a polygon's border
  // is already drawn by the PolygonSymbolizer's own Stroke, so adding one here
  // would draw the boundary twice in a spec-compliant SLD renderer. Line
  // geometry takes the per-rule color for an attribute-driven renderer
  // (matching vectorLineColorValue, which colors lines by the data value while
  // polygon outlines keep the flat stroke), falling back to the flat stroke.
  if (profile.hasLine) {
    const linePaint = lineColor !== undefined ? { ...paint, strokeColor: lineColor } : paint;
    parts.push(lineSymbolizer(linePaint));
  }
  if (profile.hasPoint) parts.push(pointSymbolizer(style, paint, warnings));
  return parts.join("");
}

/** Wrap one rule's body (filter + scale + symbolizers) in a `<Rule>`. */
function rule(
  name: string,
  title: string | null,
  filter: string | null,
  scale: string[],
  symbolizers: string,
): string {
  const parts: string[] = ["<Rule>"];
  parts.push(`<Name>${xmlEscape(name)}</Name>`);
  if (title) parts.push(`<Title>${xmlEscape(title)}</Title>`);
  if (filter) parts.push(filter);
  parts.push(...scale);
  parts.push(symbolizers);
  parts.push("</Rule>");
  return parts.join("");
}

/** `<ogc:Filter>` for `PropertyIs…` on a property/literal, e.g. equals. */
function comparisonFilter(op: string, property: string, literal: string | number): string {
  return `<ogc:Filter><ogc:${op}><ogc:PropertyName>${xmlEscape(
    property,
  )}</ogc:PropertyName><ogc:Literal>${xmlEscape(
    String(literal),
  )}</ogc:Literal></ogc:${op}></ogc:Filter>`;
}

/** A range `<ogc:And>` of `>= lower` and (when finite) `< upper`. */
function rangeFilter(property: string, lower: number, upper: number | null): string {
  const prop = xmlEscape(property);
  const ge = `<ogc:PropertyIsGreaterThanOrEqualTo><ogc:PropertyName>${prop}</ogc:PropertyName><ogc:Literal>${num(
    lower,
  )}</ogc:Literal></ogc:PropertyIsGreaterThanOrEqualTo>`;
  if (upper === null) return `<ogc:Filter>${ge}</ogc:Filter>`;
  const lt = `<ogc:PropertyIsLessThan><ogc:PropertyName>${prop}</ogc:PropertyName><ogc:Literal>${num(
    upper,
  )}</ogc:Literal></ogc:PropertyIsLessThan>`;
  return `<ogc:Filter><ogc:And>${ge}${lt}</ogc:And></ogc:Filter>`;
}

/** A `< value` filter, used to clamp graduated values below the first break. */
function belowFilter(property: string, value: number): string {
  return `<ogc:Filter><ogc:PropertyIsLessThan><ogc:PropertyName>${xmlEscape(
    property,
  )}</ogc:PropertyName><ogc:Literal>${num(
    value,
  )}</ogc:Literal></ogc:PropertyIsLessThan></ogc:Filter>`;
}

/**
 * Translate a GeoLibre rule's MapLibre filter (JSON string) into an
 * `<ogc:Filter>` body (no wrapper), or null when it uses an operator SLD cannot
 * express. Supports the comparison and logical operators QGIS/GeoServer rules
 * use (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `all`, `any`, `!`).
 */
function mapboxFilterToOgc(expression: unknown): string | null {
  if (!Array.isArray(expression)) return null;
  const [op, ...rest] = expression;

  const comparison: Record<string, string> = {
    "==": "PropertyIsEqualTo",
    "!=": "PropertyIsNotEqualTo",
    "<": "PropertyIsLessThan",
    "<=": "PropertyIsLessThanOrEqualTo",
    ">": "PropertyIsGreaterThan",
    ">=": "PropertyIsGreaterThanOrEqualTo",
  };
  if (typeof op === "string" && op in comparison && rest.length === 2) {
    const property = getProp(rest[0]);
    const literal = getLiteral(rest[1]);
    if (property === null || literal === null) return null;
    return `<ogc:${comparison[op]}><ogc:PropertyName>${xmlEscape(
      property,
    )}</ogc:PropertyName><ogc:Literal>${xmlEscape(
      String(literal),
    )}</ogc:Literal></ogc:${comparison[op]}>`;
  }

  if ((op === "all" || op === "any") && rest.length > 0) {
    const children = rest.map(mapboxFilterToOgc);
    if (children.some((child) => child === null)) return null;
    const tag = op === "all" ? "And" : "Or";
    return `<ogc:${tag}>${children.join("")}</ogc:${tag}>`;
  }

  if (op === "!" && rest.length === 1) {
    const child = mapboxFilterToOgc(rest[0]);
    return child === null ? null : `<ogc:Not>${child}</ogc:Not>`;
  }

  // `in` ⇒ an Or of equality tests. Accepts both the modern two-operand form
  // `["in", ["get", p], ["literal", [v1, v2, …]]]` and the legacy variadic form
  // `["in", ["get", p], v1, v2, …]`.
  if (op === "in" && rest.length >= 2) {
    const property = getProp(rest[0]);
    if (property === null) return null;
    const haystack = rest[1];
    const rawValues =
      rest.length === 2 &&
      Array.isArray(haystack) &&
      haystack[0] === "literal" &&
      Array.isArray(haystack[1])
        ? (haystack[1] as unknown[])
        : rest.slice(1);
    const values = rawValues.map(getLiteral);
    if (values.length === 0 || values.some((value) => value === null)) {
      return null;
    }
    const tests = values
      .map(
        (value) =>
          `<ogc:PropertyIsEqualTo><ogc:PropertyName>${xmlEscape(
            property,
          )}</ogc:PropertyName><ogc:Literal>${xmlEscape(
            String(value),
          )}</ogc:Literal></ogc:PropertyIsEqualTo>`,
      )
      .join("");
    return values.length === 1 ? tests : `<ogc:Or>${tests}</ogc:Or>`;
  }

  return null;
}

/** Read the property name from `["get", "p"]`. */
function getProp(node: unknown): string | null {
  if (Array.isArray(node) && node[0] === "get" && typeof node[1] === "string") {
    return node[1];
  }
  return null;
}

/** Read a scalar literal (string/number/boolean) from a filter operand. */
function getLiteral(node: unknown): string | number | boolean | null {
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return node;
  }
  // A ["literal", v] wrapper is unwrapped to its scalar.
  if (Array.isArray(node) && node[0] === "literal") {
    return getLiteral(node[1]);
  }
  return null;
}

/** Build the categorized renderer's rules (one per stop + an else rule). */
function categorizedRules(
  style: LayerStyle,
  opacity: number,
  property: string,
  stops: VectorStyleStop[],
  profile: GeometryProfile,
  scale: string[],
  warnings: string[],
): string {
  const base = basePaint(style, opacity);
  const rules: string[] = [];
  // Skip stops with a blank value or an invalid color, matching how
  // vectorColorExpression filters them out of the live `match` expression, so
  // the exported SLD renders the same categories the map does.
  for (const stop of stops) {
    if (String(stop.value).trim().length === 0 || !isHexColor(stop.color)) continue;
    const paint = { ...base, fillColor: stop.color };
    rules.push(
      rule(
        `${property} = ${stop.value}`,
        stop.label || String(stop.value),
        comparisonFilter("PropertyIsEqualTo", property, stop.value),
        scale,
        renderSymbolizers(style, paint, profile, warnings, stop.color),
      ),
    );
  }
  // The `match` fallback color becomes an ElseFilter rule so unmatched features
  // still draw (mirrors vectorColorExpression's trailing fallback). Its line
  // color stays the flat stroke (the match fallback the live map uses for lines).
  rules.push(
    rule(
      "Other",
      "Other",
      "<ElseFilter/>",
      scale,
      renderSymbolizers(style, base, profile, warnings),
    ),
  );
  return rules.join("");
}

/**
 * Build the graduated renderer's rules. GeoLibre's graduated renderer is a
 * continuous color interpolation, which SLD vector fills cannot express, so the
 * stops are written as discrete class-break rules (`>= vi AND < vi+1`); the
 * exact stop values and colors survive a round-trip.
 */
function graduatedRules(
  style: LayerStyle,
  opacity: number,
  property: string,
  stops: VectorStyleStop[],
  profile: GeometryProfile,
  scale: string[],
  warnings: string[],
): string {
  const base = basePaint(style, opacity);
  const numeric = stops
    .map((stop) => ({
      color: stop.color,
      label: stop.label,
      value: typeof stop.value === "number" ? stop.value : Number.parseFloat(String(stop.value)),
    }))
    // Drop stops with a non-numeric value or an invalid color, matching the
    // filtering vectorColorExpression applies before building the interpolation.
    .filter((stop) => Number.isFinite(stop.value) && isHexColor(stop.color))
    .sort((a, b) => a.value - b.value);

  warnings.push(
    "The graduated color ramp was written as discrete SLD class breaks; the continuous interpolation is approximated.",
  );

  const rules: string[] = [];
  // Values below the first break clamp to the first stop's color on the live
  // map (the interpolate expression clamps out-of-range inputs), so emit a
  // leading `< first` rule to reproduce that in SLD consumers. The importer
  // recognizes and skips this guard so the stop values still round-trip exactly.
  if (numeric.length > 0) {
    rules.push(
      rule(
        `${property} < ${num(numeric[0].value)}`,
        numeric[0].label ?? null,
        belowFilter(property, numeric[0].value),
        scale,
        renderSymbolizers(
          style,
          { ...base, fillColor: numeric[0].color },
          profile,
          warnings,
          numeric[0].color,
        ),
      ),
    );
  }
  for (let index = 0; index < numeric.length; index += 1) {
    const stop = numeric[index];
    const next = numeric[index + 1];
    const paint = { ...base, fillColor: stop.color };
    const upper = next ? next.value : null;
    rules.push(
      rule(
        upper === null
          ? `${property} >= ${num(stop.value)}`
          : `${num(stop.value)} <= ${property} < ${num(upper)}`,
        stop.label ?? null,
        rangeFilter(property, stop.value, upper),
        scale,
        renderSymbolizers(style, paint, profile, warnings, stop.color),
      ),
    );
  }
  return rules.join("");
}

/**
 * Build the rule-based renderer's rules. Uses the shared
 * {@link effectiveVectorRules} resolver so disabled rules are dropped and
 * nested rules are flattened (ancestor filters ANDed into each leaf), exactly
 * as the live map draws them; SLD has no rule tree of its own. Per-rule zoom
 * ranges intersect the layer window into per-rule scale denominators, and
 * per-rule symbol overrides (outline color/width, opacity, size) are
 * folded into each rule's symbolizers.
 */
function ruleBasedRules(
  style: LayerStyle,
  opacity: number,
  rules: VectorRule[],
  profile: GeometryProfile,
  scale: string[],
  warnings: string[],
): string {
  const base = basePaint(style, opacity);
  const out: string[] = [];
  const { rules: effective, elseRule } = effectiveVectorRules(style);
  if (rules.some((entry) => entry.enabled === false)) {
    warnings.push("Disabled rules are not part of the rendered style and were not exported.");
  }
  // A self-referencing parentId means "no parent" (top-level), so it does not
  // count as nesting for the flattening warning.
  if (rules.some((entry) => entry.parentId && entry.parentId !== entry.id)) {
    warnings.push(
      "Nested rules were flattened for SLD: each rule's filter was combined with its parents' filters.",
    );
  }
  const layerMinZoom = clampZoom(styleValue(style, "minZoom"), MIN_LAYER_ZOOM);
  const layerMaxZoom = clampZoom(styleValue(style, "maxZoom"), MAX_LAYER_ZOOM);
  for (const entry of effective) {
    const filter = mapboxFilterToOgc(entry.filter);
    if (filter === null) {
      warnings.push(
        `The rule "${entry.label || JSON.stringify(entry.filter)}" uses a filter with no SLD equivalent and was skipped.`,
      );
      continue;
    }
    // The rule's scale window is its zoom range intersected with the layer's.
    const ruleMinZoom = Math.max(
      layerMinZoom,
      clampZoom(entry.minZoom ?? layerMinZoom, MIN_LAYER_ZOOM),
    );
    const ruleMaxZoom = Math.min(
      layerMaxZoom,
      clampZoom(entry.maxZoom ?? layerMaxZoom, MAX_LAYER_ZOOM),
    );
    const hasRuleZoom = entry.minZoom !== undefined || entry.maxZoom !== undefined;
    if (hasRuleZoom && ruleMinZoom >= ruleMaxZoom) {
      // The rule's zoom range lies entirely outside the layer's window, so
      // the live map never draws it (the layer's zoom clipping hides it).
      // scaleDenominatorsForWindow would silently swap the inverted bounds
      // into a wrong, visible range, so skip the rule instead.
      warnings.push(
        `The rule "${entry.label || JSON.stringify(entry.filter)}" is never visible inside the layer's zoom window and was not exported.`,
      );
      continue;
    }
    const ruleScale = hasRuleZoom ? scaleDenominatorsForWindow(ruleMinZoom, ruleMaxZoom) : scale;
    const paint: SymbolPaint = {
      ...base,
      fillColor: entry.color,
      strokeColor: entry.strokeColor ?? base.strokeColor,
      strokeWidth: entry.strokeWidth ?? base.strokeWidth,
      fillOpacity: entry.fillOpacity !== undefined ? entry.fillOpacity * opacity : base.fillOpacity,
      ...(entry.circleRadius !== undefined ? { circleRadius: entry.circleRadius } : {}),
    };
    out.push(
      rule(
        entry.label || "rule",
        entry.label || null,
        `<ogc:Filter>${filter}</ogc:Filter>`,
        ruleScale,
        renderSymbolizers(style, paint, profile, warnings, entry.color),
      ),
    );
  }
  // A switched-off else rule means features matching no rule are hidden, and
  // an SLD expresses exactly that by having no ElseFilter rule — so skip the
  // catch-all and the export round-trips back to a disabled else record.
  if (rules.find((entry) => entry.isElse)?.enabled === false) {
    return out.join("");
  }
  // Catch-all rule so features matched by no rule still draw. The Title is only
  // written when the else rule has a real label, so an unlabeled else round-trips
  // back to an empty label instead of a synthetic "Other". When the else rule
  // has no valid color, the live map falls the fill channel back to the layer
  // fill and the line channel back to the layer stroke (ruleBasedColorExpression
  // is seeded with fillColor for fills and strokeColor for lines), so mirror
  // both here rather than using one color for both channels.
  const elseFillColor =
    elseRule && isHexColor(elseRule.color) ? elseRule.color : styleValue(style, "fillColor");
  const elseLineColor =
    elseRule && isHexColor(elseRule.color) ? elseRule.color : styleValue(style, "strokeColor");
  // The else rule can carry its own symbol overrides, like any other rule.
  const elsePaint: SymbolPaint = {
    ...base,
    fillColor: elseFillColor,
    strokeColor: isHexColor(elseRule?.strokeColor)
      ? (elseRule!.strokeColor as string)
      : base.strokeColor,
    strokeWidth:
      typeof elseRule?.strokeWidth === "number" && Number.isFinite(elseRule.strokeWidth)
        ? elseRule.strokeWidth
        : base.strokeWidth,
    fillOpacity:
      typeof elseRule?.fillOpacity === "number" && Number.isFinite(elseRule.fillOpacity)
        ? elseRule.fillOpacity * opacity
        : base.fillOpacity,
    ...(typeof elseRule?.circleRadius === "number" && Number.isFinite(elseRule.circleRadius)
      ? { circleRadius: elseRule.circleRadius }
      : {}),
  };
  out.push(
    rule(
      "Other",
      elseRule?.label || null,
      "<ElseFilter/>",
      scale,
      renderSymbolizers(style, elsePaint, profile, warnings, elseLineColor),
    ),
  );
  return out.join("");
}

/** The single-symbol renderer's one rule (no filter). */
function singleRule(
  style: LayerStyle,
  opacity: number,
  profile: GeometryProfile,
  scale: string[],
  warnings: string[],
): string {
  return rule(
    "Single symbol",
    null,
    null,
    scale,
    renderSymbolizers(style, basePaint(style, opacity), profile, warnings),
  );
}

/**
 * Serialize a vector layer's GeoLibre symbology into an OGC SLD 1.0.0 document
 * (`StyledLayerDescriptor` with `CssParameter` symbolizers), the interchange
 * format QGIS, GeoServer, MapServer, and ArcGIS speak. The
 * single/categorized/graduated/rule-based renderers map onto SLD rules and
 * filters; labels become a `TextSymbolizer`. Anything SLD cannot represent (3D
 * extrusion, heatmap/cluster points, fill patterns, custom markers, a raw color
 * expression) degrades gracefully and is reported in
 * {@link SldExportResult.warnings} rather than dropped silently.
 *
 * The layer's opacity is folded into the symbolizer fill/stroke opacity (SLD has
 * no layer-opacity concept), matching the Mapbox exporter, so re-importing an
 * SLD from a layer whose opacity was not 1 collapses the two into one value with
 * an unchanged rendered result.
 *
 * @param layer   The layer whose `style` is exported.
 * @param geojson The layer's features, used only to detect which geometries are
 *                present (so a point layer does not gain a polygon symbolizer).
 *                When `null`, all three symbolizers are emitted as a safe
 *                superset.
 */
export function buildSld(
  layer: SldExportableLayer,
  geojson: FeatureCollection | null,
  options: SldExportOptions = {},
): SldExportResult {
  const warnings: string[] = [];
  const style = layer.style;
  // Export the layer's real opacity regardless of its current visibility: SLD
  // has no hidden state, so folding a hidden layer's opacity to 0 would write an
  // all-transparent style that renders nothing and loses the layer's colors.
  const opacity = layer.opacity;
  const fontFamily = options.fontFamily?.trim() || DEFAULT_FONT_FAMILY;

  const profile: GeometryProfile = geojson
    ? detectGeometryProfile(geojson)
    : { hasPoint: true, hasLine: true, hasPolygon: true };
  // With no geometry at all, fall back to the superset so the export is not empty.
  if (!profile.hasPoint && !profile.hasLine && !profile.hasPolygon) {
    profile.hasPoint = true;
    profile.hasLine = true;
    profile.hasPolygon = true;
  }

  if (styleValue(style, "extrusionEnabled")) {
    warnings.push("3D extrusion has no SLD equivalent; the layer is exported as a flat 2D style.");
  }
  const pointOnly = profile.hasPoint && !profile.hasLine && !profile.hasPolygon;
  const pointRenderer = styleValue(style, "pointRenderer");
  if (pointOnly && (pointRenderer === "heatmap" || pointRenderer === "cluster")) {
    warnings.push(
      `The ${pointRenderer} point renderer has no SLD equivalent; points are exported as plain markers.`,
    );
  }
  if (profile.hasPolygon && styleValue(style, "fillPattern") !== "none") {
    warnings.push(
      "The fill pattern has no portable SLD equivalent; the polygon uses a flat fill instead.",
    );
  }
  // basePaint writes the flat strokeWidth as a static pixel width. A
  // "meters"-scaled stroke (zoom-driven on the live map) and a proportional
  // (attribute-driven) size have no portable SLD equivalent, so warn that they
  // are exported as a fixed value rather than silently flattening the scaling.
  if (styleValue(style, "strokeWidthUnit") === "meters") {
    warnings.push(
      "The stroke width is in map units (meters); SLD has no portable equivalent, so it is exported as a fixed pixel width.",
    );
  }
  if (styleValue(style, "proportionalSizeEnabled")) {
    warnings.push(
      "Proportional (attribute-driven) symbol size has no portable SLD equivalent; a fixed size is exported instead.",
    );
  }

  const scale = scaleDenominators(style);
  const mode = styleValue(style, "vectorStyleMode");
  const property = styleValue(style, "vectorStyleProperty").trim();
  const stops = styleValue(style, "vectorStyleStops");
  // Count only stops that would actually render (non-empty value, valid color),
  // so a renderer whose stops are all invalid falls through to a single symbol
  // rather than emitting an empty categorized/graduated block.
  const validCategorized = stops.filter(
    (stop) => String(stop.value).trim().length > 0 && isHexColor(stop.color),
  ).length;
  const validGraduated = stops.filter(
    (stop) =>
      isHexColor(stop.color) &&
      Number.isFinite(
        typeof stop.value === "number" ? stop.value : Number.parseFloat(String(stop.value)),
      ),
  ).length;

  let renderRules: string;
  if (mode === "categorized" && property && validCategorized > 0) {
    renderRules = categorizedRules(style, opacity, property, stops, profile, scale, warnings);
  } else if (mode === "graduated" && property && validGraduated >= 2) {
    renderRules = graduatedRules(style, opacity, property, stops, profile, scale, warnings);
  } else if (mode === "rule-based" && styleValue(style, "vectorRules").length > 0) {
    renderRules = ruleBasedRules(
      style,
      opacity,
      styleValue(style, "vectorRules"),
      profile,
      scale,
      warnings,
    );
  } else {
    if (mode === "expression") {
      warnings.push(
        "The custom color expression has no SLD equivalent; the layer is exported with its fallback color.",
      );
    } else if (mode === "categorized" || mode === "graduated" || mode === "rule-based") {
      // The renderer was attribute-driven but had no usable classes (no
      // property, all-invalid stops, or empty rules), so it fell back to a
      // single symbol; flag that rather than silently dropping the classes.
      warnings.push(
        `The ${mode} renderer had no valid classes to export; the layer is exported as a single symbol.`,
      );
    }
    renderRules = singleRule(style, opacity, profile, scale, warnings);
  }

  // The label symbolizer goes in its own rule so it applies across every
  // feature regardless of the render rules' filters (matching how the live map
  // draws one symbol layer for all features).
  const text = textSymbolizer(style, opacity, fontFamily, warnings);
  const labelRule = text ? rule("Labels", null, null, scale, text) : "";

  const name = xmlEscape(layer.name || "layer");
  const sld = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<StyledLayerDescriptor version="1.0.0"' +
      ' xmlns="http://www.opengis.net/sld"' +
      ' xmlns:ogc="http://www.opengis.net/ogc"' +
      ' xmlns:xlink="http://www.w3.org/1999/xlink"' +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ' xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">',
    "<NamedLayer>",
    `<Name>${name}</Name>`,
    "<UserStyle>",
    `<Name>${name}</Name>`,
    "<FeatureTypeStyle>",
    renderRules,
    labelRule,
    "</FeatureTypeStyle>",
    "</UserStyle>",
    "</NamedLayer>",
    "</StyledLayerDescriptor>",
  ].join("\n");

  // Several warnings (marker fallback, per-rule notes) are pushed once per
  // generated rule; dedupe so the user is not shown the same sentence N times.
  return { sld: formatSld(sld), warnings: [...new Set(warnings)] };
}

/**
 * Pretty-print the SLD by inserting newlines and indentation between tags. The
 * document is built as a flat string for simplicity; this pass makes it readable
 * without a DOM serializer (which is unavailable in the Node test environment).
 */
function formatSld(xml: string): string {
  const tokens = xml.replace(/>\s*</g, "><").replace(/></g, ">\n<").split("\n");
  let depth = 0;
  const out: string[] = [];
  for (const token of tokens) {
    const isClosing = /^<\//.test(token);
    const isSelfContained =
      /^<[^!?][^>]*\/>$/.test(token) ||
      /^<\?/.test(token) ||
      /^<([\w:]+)(\s[^>]*)?>.*<\/\1>$/.test(token);
    if (isClosing) depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + token);
    if (!isClosing && !isSelfContained && /^<[^!?]/.test(token)) depth += 1;
  }
  return out.join("\n");
}
