/**
 * Atlas (map series) generation for the Print Layout (GH #1291).
 *
 * Pure, framework-free helpers: token substitution, feature bounds, filtering,
 * sorting, and page building. The dialog drives the live map from the pages
 * produced here and composes each capture through the regular layout pipeline,
 * so everything in this module is unit-testable without a map.
 */
import type { FeatureCollection, Geometry, Position } from "geojson";

/** Geographic bounds as `[west, south, east, north]` in WGS84 degrees. */
export type AtlasBounds = [number, number, number, number];

/** One page of an atlas: a coverage feature plus its resolved identity. */
export interface AtlasPage {
  /** 0-based position in the final (filtered + sorted) page order. */
  index: number;
  /** 0-based position of the feature in the source collection: a stable
   * identity that survives filtering and sorting. */
  sourceIndex: number;
  /** Display name resolved from the name field, or `Feature N` (1-based, from
   * the feature's position in the source collection) when unset/blank. */
  name: string;
  /** The feature's attributes, for `{atlas.attr:FIELD}` tokens. */
  properties: Record<string, unknown>;
  /** Bounding box of the feature geometry (margin not yet applied). */
  bounds: AtlasBounds;
}

/** Values substituted into `{atlas.*}` tokens for one page. */
export interface AtlasTokenContext {
  name: string;
  /** 1-based page number in the final page order. */
  pageNumber: number;
  /** Total number of pages in the atlas. */
  total: number;
  properties: Record<string, unknown>;
}

const ATTR_TOKEN = /\{atlas\.attr:([^{}]+)\}/g;

/**
 * Replace `{atlas.name}`, `{atlas.pagenumber}`, `{atlas.total}`, and
 * `{atlas.attr:FIELD}` tokens in a template string. Unknown attribute fields
 * (and null/undefined values) resolve to an empty string; text without tokens
 * passes through unchanged.
 */
export function substituteAtlasTokens(
  text: string,
  ctx: AtlasTokenContext,
): string {
  if (!text) return text;
  return text
    .replace(/\{atlas\.name\}/g, ctx.name)
    .replace(/\{atlas\.pagenumber\}/g, String(ctx.pageNumber))
    .replace(/\{atlas\.total\}/g, String(ctx.total))
    .replace(ATTR_TOKEN, (_m, field: string) => {
      const v = ctx.properties[field.trim()];
      return v === null || v === undefined ? "" : String(v);
    });
}

/**
 * Remove all `{atlas.*}` tokens from a template (used to derive a token-free
 * base filename for the combined PDF, where no single page's values apply).
 */
export function stripAtlasTokens(text: string): string {
  return text
    .replace(/\{atlas\.(?:name|pagenumber|total)\}/g, "")
    .replace(ATTR_TOKEN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function walkPositions(
  coords: unknown,
  visit: (pos: Position) => void,
): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number") {
    visit(coords as Position);
    return;
  }
  for (const c of coords) walkPositions(c, visit);
}

/**
 * Compute the `[west, south, east, north]` bounding box of a GeoJSON geometry
 * (GeometryCollections included). Returns `null` for empty or missing
 * geometries so callers can skip features that cannot produce a page.
 */
export function geometryBounds(
  geometry: Geometry | null | undefined,
): AtlasBounds | null {
  if (!geometry) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  // Longitudes shifted into [0, 360), tracked in parallel to detect features
  // that cross the antimeridian (Fiji, the Aleutians, ...): for those, the
  // raw min/max box spans the far side of the globe instead of the feature.
  let wShifted = Infinity;
  let eShifted = -Infinity;
  const visit = (pos: Position) => {
    const [x, y] = pos;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    w = Math.min(w, x);
    s = Math.min(s, y);
    e = Math.max(e, x);
    n = Math.max(n, y);
    const shifted = x < 0 ? x + 360 : x;
    wShifted = Math.min(wShifted, shifted);
    eShifted = Math.max(eShifted, shifted);
  };
  if (geometry.type === "GeometryCollection") {
    // Children are merged on their raw boxes; a collection whose *combination*
    // crosses the antimeridian is not unwrapped (leaf geometries are).
    for (const g of geometry.geometries) {
      const b = geometryBounds(g);
      if (!b) continue;
      w = Math.min(w, b[0]);
      s = Math.min(s, b[1]);
      e = Math.max(e, b[2]);
      n = Math.max(n, b[3]);
    }
  } else {
    walkPositions(geometry.coordinates, visit);
  }
  if (!Number.isFinite(w) || !Number.isFinite(s)) return null;
  // A raw span over 180° that shrinks in the shifted frame means the feature
  // crosses ±180°: return the shifted box (east may exceed 180°, which
  // MapLibre's fitBounds understands and renders across the antimeridian).
  if (e - w > 180 && eShifted - wShifted < e - w) {
    return [wShifted, s, eShifted, n];
  }
  return [w, s, e, n];
}

/**
 * Expand a bounding box by a symmetric margin (a percentage of each span) and
 * pad degenerate spans (points, vertical/horizontal lines) to a minimum span
 * so `fitBounds` never receives a zero-area box.
 *
 * @param bounds - The box to expand.
 * @param marginPct - Margin as a percentage of each side's span (10 = 10%).
 * @param minSpanDeg - Minimum span, in degrees, either axis is padded to.
 */
export function expandBounds(
  bounds: AtlasBounds,
  marginPct: number,
  minSpanDeg = 0.005,
): AtlasBounds {
  let [w, s, e, n] = bounds;
  const padX = Math.max(((e - w) * marginPct) / 100, 0);
  const padY = Math.max(((n - s) * marginPct) / 100, 0);
  w -= padX;
  e += padX;
  s -= padY;
  n += padY;
  if (e - w < minSpanDeg) {
    const cx = (w + e) / 2;
    w = cx - minSpanDeg / 2;
    e = cx + minSpanDeg / 2;
  }
  // Clamp latitudes into Web Mercator's renderable range *before* enforcing
  // the minimum span, and keep the padded centre inside it too: clamping after
  // padding could invert the box for a feature at the poles (e.g. a point at
  // latitude 90 became [~89.9975, 85]).
  s = Math.max(-85, Math.min(85, s));
  n = Math.max(-85, Math.min(85, n));
  if (n - s < minSpanDeg) {
    const cy = Math.max(
      -85 + minSpanDeg / 2,
      Math.min(85 - minSpanDeg / 2, (s + n) / 2),
    );
    s = cy - minSpanDeg / 2;
    n = cy + minSpanDeg / 2;
  }
  return [w, s, e, n];
}

/**
 * Collect the union of attribute names across the features (or a sample of
 * them, when `sampleLimit` is set), in first-seen order, for populating the
 * name/sort field selectors. Accepts anything carrying `properties`, so both
 * GeoJSON Features and precomputed {@link AtlasFeatureInfo}s work.
 */
export function listAtlasFields(
  features: ReadonlyArray<{
    properties?: Record<string, unknown> | null;
  }>,
  sampleLimit = Infinity,
): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  const limit = Math.min(features.length, sampleLimit);
  for (let i = 0; i < limit; i++) {
    for (const key of Object.keys(features[i].properties ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      fields.push(key);
    }
  }
  return fields;
}

export type AtlasFilterPredicate = (
  properties: Record<string, unknown>,
) => boolean;

/** A single parsed `field op value` comparison. */
interface FilterCondition {
  field: string;
  op: "=" | "!=" | ">" | ">=" | "<" | "<=" | "contains";
  value: string;
  numericValue: number | null;
}

const CONDITION_RE =
  /^(.+?)\s*(==|!=|>=|<=|=|>|<)\s*(.+)$|^(.+?)\s+(contains)\s+(.+)$/i;

function unquote(raw: string): string {
  const v = raw.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split a filter expression on the standalone keyword `and`, ignoring any
 * occurrence inside a single- or double-quoted value so expressions like
 * `NAME = "Sam and Max"` stay one condition.
 */
function splitConditions(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      const m = /^\s+and\s+/i.exec(expr.slice(i));
      if (m) {
        parts.push(current);
        current = "";
        i += m[0].length;
        continue;
      }
    }
    current += ch;
    i++;
  }
  parts.push(current);
  return parts;
}

/**
 * Parse a simple atlas filter expression into a predicate over feature
 * attributes, or return `null` when the expression is malformed (so the dialog
 * can show an inline error instead of silently matching nothing).
 *
 * Grammar: one or more `field op value` comparisons joined by `and`. Supported
 * operators: `=` (or `==`), `!=`, `>`, `>=`, `<`, `<=`, and `contains`
 * (case-insensitive substring). Values may be numbers, quoted strings, or bare
 * words. Equality compares numerically when both sides are numbers, otherwise
 * as strings; ordering comparisons require numbers on both sides.
 */
export function parseAtlasFilter(
  expression: string,
): AtlasFilterPredicate | null {
  const expr = expression.trim();
  if (!expr) return () => true;
  const parts = splitConditions(expr);
  const conditions: FilterCondition[] = [];
  for (const part of parts) {
    const m = CONDITION_RE.exec(part.trim());
    if (!m) return null;
    const field = unquote((m[1] ?? m[4]).trim());
    const opRaw = (m[2] ?? m[5]).toLowerCase();
    const value = unquote((m[3] ?? m[6]).trim());
    if (!field || !value) return null;
    const op = (opRaw === "==" ? "=" : opRaw) as FilterCondition["op"];
    const num = Number(value);
    conditions.push({
      field,
      op,
      value,
      numericValue: value !== "" && Number.isFinite(num) ? num : null,
    });
  }
  return (properties) =>
    conditions.every((c) => matchCondition(c, properties[c.field]));
}

function matchCondition(c: FilterCondition, raw: unknown): boolean {
  // A feature without the field at all: it is "not equal" to any value, but
  // cannot satisfy equality, ordering, or containment.
  if (raw === null || raw === undefined) return c.op === "!=";
  const asNum = typeof raw === "number" ? raw : Number(raw);
  const bothNumeric =
    c.numericValue !== null &&
    Number.isFinite(asNum) &&
    String(raw).trim() !== "";
  switch (c.op) {
    case "=":
      return bothNumeric ? asNum === c.numericValue : String(raw) === c.value;
    case "!=":
      return bothNumeric ? asNum !== c.numericValue : String(raw) !== c.value;
    case ">":
      return bothNumeric && asNum > (c.numericValue as number);
    case ">=":
      return bothNumeric && asNum >= (c.numericValue as number);
    case "<":
      return bothNumeric && asNum < (c.numericValue as number);
    case "<=":
      return bothNumeric && asNum <= (c.numericValue as number);
    case "contains":
      return String(raw).toLowerCase().includes(c.value.toLowerCase());
  }
}

function compareValues(a: unknown, b: unknown): number {
  // Missing values sort last regardless of direction... handled by caller sign;
  // here: undefined/null compare greater than any present value.
  const aMissing = a === null || a === undefined || a === "";
  const bMissing = b === null || b === undefined || b === "";
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return an === bn ? 0 : an < bn ? -1 : 1;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export interface BuildAtlasPagesOptions {
  /** Attribute used for each page's display name; blank = `Feature N`. */
  nameField?: string;
  /** Attribute to order pages by; blank keeps the source feature order. */
  sortField?: string;
  /** Reverse the sort order (missing values always sort last). */
  sortDescending?: boolean;
  /** Predicate from {@link parseAtlasFilter}; features failing it are skipped. */
  filter?: AtlasFilterPredicate | null;
}

/**
 * A coverage feature reduced to what atlas paging needs: stable identity,
 * bounds, and attributes. Precomputing these once per layer (the geometry
 * walk is the expensive part) keeps filter/sort edits cheap for large layers.
 */
export interface AtlasFeatureInfo {
  /** 0-based position of the feature in the source collection. */
  sourceIndex: number;
  bounds: AtlasBounds;
  properties: Record<string, unknown>;
}

/**
 * Reduce a coverage layer's features to {@link AtlasFeatureInfo}s, dropping
 * features without a usable geometry. This walks every vertex, so callers
 * iterating settings should compute it once per layer and pass the result to
 * {@link buildAtlasPages}.
 */
export function collectAtlasFeatures(
  collection: Pick<FeatureCollection, "features">,
): AtlasFeatureInfo[] {
  const infos: AtlasFeatureInfo[] = [];
  collection.features.forEach((feature, i) => {
    const bounds = geometryBounds(feature.geometry);
    if (!bounds) return;
    infos.push({
      sourceIndex: i,
      bounds,
      properties: (feature.properties ?? {}) as Record<string, unknown>,
    });
  });
  return infos;
}

/**
 * Build the ordered page list for an atlas from a coverage layer's features
 * (or from precomputed {@link AtlasFeatureInfo}s): drop features without a
 * usable geometry, apply the filter, sort, and assign final page indices.
 */
export function buildAtlasPages(
  source: Pick<FeatureCollection, "features"> | AtlasFeatureInfo[],
  options: BuildAtlasPagesOptions = {},
): AtlasPage[] {
  const { nameField, sortField, sortDescending, filter } = options;
  const infos = Array.isArray(source) ? source : collectAtlasFeatures(source);
  const pages: Omit<AtlasPage, "index">[] = [];
  for (const info of infos) {
    const { sourceIndex, bounds, properties } = info;
    if (filter && !filter(properties)) continue;
    let name = "";
    if (nameField) {
      const v = properties[nameField];
      if (v !== null && v !== undefined) name = String(v).trim();
    }
    pages.push({
      sourceIndex,
      name: name || `Feature ${sourceIndex + 1}`,
      properties,
      bounds,
    });
  }
  if (sortField) {
    const sign = sortDescending ? -1 : 1;
    pages.sort((a, b) => {
      const cmp = compareValues(
        a.properties[sortField],
        b.properties[sortField],
      );
      // Missing values stay last in both directions: compareValues already
      // pushed them to the end, so only flip the sign for present-vs-present.
      const aMissing =
        a.properties[sortField] === null ||
        a.properties[sortField] === undefined ||
        a.properties[sortField] === "";
      const bMissing =
        b.properties[sortField] === null ||
        b.properties[sortField] === undefined ||
        b.properties[sortField] === "";
      if (aMissing || bMissing) return cmp;
      return cmp * sign;
    });
  }
  return pages.map((p, index) => ({ ...p, index }));
}

const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in metres between two `[lng, lat]` positions. */
function haversineMeters(a: Position, b: Position): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const la1 = toRad(a[1]);
  const la2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Linear interpolation between two positions — adequate at the sub-segment
 * distances the cutter works with (an edge of a digitized line). Longitude is
 * unwrapped first so an edge crossing the antimeridian (179° to -179°)
 * interpolates across the short dateline path haversine measured, not through
 * 0°; the result may exceed ±180°, which MapLibre and {@link geometryBounds}
 * both understand. */
function lerpPosition(a: Position, b: Position, t: number): Position {
  let dx = b[0] - a[0];
  if (dx > 180) dx -= 360;
  else if (dx < -180) dx += 360;
  return [a[0] + dx * t, a[1] + (b[1] - a[1]) * t];
}

/** Collect the line parts (as coordinate arrays) of a geometry: LineStrings,
 * MultiLineStrings, and any of either nested in a GeometryCollection.
 * Non-line geometries contribute nothing. */
function lineParts(geometry: Geometry | null | undefined): Position[][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case "LineString":
      return [geometry.coordinates];
    case "MultiLineString":
      return geometry.coordinates;
    case "GeometryCollection":
      return geometry.geometries.flatMap((g) => lineParts(g));
    default:
      return [];
  }
}

/**
 * Whether a geometry contributes any line parts to along-a-line coverage —
 * the same traversal {@link buildLineAtlasPages} uses (GeometryCollections
 * included), so UI counts can never disagree with the page builder.
 */
export function hasLineGeometry(
  geometry: Geometry | null | undefined,
): boolean {
  return lineParts(geometry).length > 0;
}

/**
 * Hard ceiling on pages one along-a-line series may produce. A tiny segment
 * length against a very long line would otherwise build an unbounded page
 * list synchronously on the main thread; the dialog surfaces a truncation
 * notice when this cap is hit.
 */
export const MAX_LINE_ATLAS_PAGES = 5000;

interface LineSegment {
  coords: Position[];
  startM: number;
  endM: number;
}

/**
 * Cut a (possibly multi-part) line into consecutive stretches of
 * `segmentM` metres of ground length, interpolating cut points inside edges.
 * Chainage runs continuously across parts (gaps between MultiLineString parts
 * add no distance), and a trailing remainder shorter than `segmentM` becomes
 * the final segment.
 */
function segmentLine(parts: Position[][], segmentM: number): LineSegment[] {
  const segments: LineSegment[] = [];
  let walked = 0;
  let segStart = 0;
  let current: Position[] = [];
  const flush = () => {
    // Skip degenerate leftovers (an exact-multiple cut leaves a zero-length
    // tail) so no page ever frames a single point.
    if (current.length >= 2 && walked - segStart > 0.5) {
      segments.push({ coords: current, startM: segStart, endM: walked });
    }
  };
  for (const part of parts) {
    if (part.length < 2) continue;
    current.push(part[0]);
    for (let i = 1; i < part.length; i++) {
      let from = part[i - 1];
      const to = part[i];
      let d = haversineMeters(from, to);
      // Cut every segment boundary that falls inside this edge.
      while (d > 0 && walked + d >= segStart + segmentM) {
        const t = (segStart + segmentM - walked) / d;
        const cut = lerpPosition(from, to, t);
        current.push(cut);
        walked = segStart + segmentM;
        flush();
        segStart = walked;
        current = [cut];
        from = cut;
        d = haversineMeters(from, to);
      }
      walked += d;
      current.push(to);
    }
  }
  flush();
  return segments;
}

export interface BuildLineAtlasPagesOptions {
  /** Ground length of one page's stretch of line, in kilometres. */
  segmentKm: number;
  /** Attribute naming the source line; blank = `Line N`. */
  nameField?: string;
  /** Predicate over source-feature attributes; failing lines are skipped. */
  filter?: AtlasFilterPredicate | null;
}

/** Round a chainage value to one decimal for labels and attributes. */
function roundKm(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Build atlas pages that tile the line features of a coverage layer in
 * fixed-length stretches (GH #1291 follow-up: uniformly scaled map series
 * along a river or trail). Each page covers `segmentKm` kilometres of line;
 * pages follow the line's own direction, per feature, in source order.
 *
 * Page properties carry the source feature's attributes plus `km_start`,
 * `km_end`, `segment`, and `segments`, all usable as `{atlas.attr:FIELD}`
 * tokens. Non-line features are skipped.
 */
export function buildLineAtlasPages(
  collection: Pick<FeatureCollection, "features">,
  options: BuildLineAtlasPagesOptions,
): AtlasPage[] {
  const { segmentKm, nameField, filter } = options;
  if (!(segmentKm > 0)) return [];
  const pages: Omit<AtlasPage, "index">[] = [];
  for (
    let featureIndex = 0;
    featureIndex < collection.features.length &&
    pages.length < MAX_LINE_ATLAS_PAGES;
    featureIndex++
  ) {
    const feature = collection.features[featureIndex];
    const parts = lineParts(feature.geometry);
    if (parts.length === 0) continue;
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    if (filter && !filter(properties)) continue;
    let base = "";
    if (nameField) {
      const v = properties[nameField];
      if (v !== null && v !== undefined) base = String(v).trim();
    }
    base = base || `Line ${featureIndex + 1}`;
    const segments = segmentLine(parts, segmentKm * 1000);
    for (let i = 0; i < segments.length; i++) {
      if (pages.length >= MAX_LINE_ATLAS_PAGES) break;
      const seg = segments[i];
      const bounds = geometryBounds({
        type: "LineString",
        coordinates: seg.coords,
      });
      if (!bounds) continue;
      const startKm = roundKm(seg.startM / 1000);
      const endKm = roundKm(seg.endM / 1000);
      pages.push({
        // Pages keep the *feature's* stable identity (the AtlasPage contract);
        // ordering within it lives in `index`/`segment`.
        sourceIndex: featureIndex,
        name: `${base} km ${startKm}-${endKm}`,
        properties: {
          ...properties,
          km_start: startKm,
          km_end: endKm,
          segment: i + 1,
          segments: segments.length,
        },
        bounds,
      });
    }
  }
  return pages.map((p, index) => ({ ...p, index }));
}

/**
 * Resolve a zip entry filename for one atlas page: substitute tokens in the
 * pattern, sanitize the result for the filesystem, and fall back to the page
 * number when everything sanitizes away.
 */
export function atlasEntryName(
  pattern: string,
  ctx: AtlasTokenContext,
): string {
  const substituted = substituteAtlasTokens(
    pattern || "{atlas.pagenumber}-{atlas.name}",
    ctx,
  );
  const cleaned = substituted
    .trim()
    .replace(/[^\p{L}\p{N} ._-]+/gu, "")
    .replace(/\s+/g, "-");
  return cleaned || String(ctx.pageNumber);
}
