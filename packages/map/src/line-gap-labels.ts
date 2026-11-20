import { compileFeatureExpression, type LabelStyle } from "@geolibre/core";
import type { Feature, FeatureCollection, LineString, MultiLineString, Position } from "geojson";
import { parseLabelOverride } from "./label-style";

// Contour-style line labels (the "Cut line under label" option): each label
// sits in a gap cut out of its own line, so the text reads cleanly without a
// halo, the way topographic maps print contour values.
//
// MapLibre cannot mask a line under a symbol, so the gap has to exist in the
// geometry. Placement runs in screen pixels at one zoom: the label's width in
// pixels decides how much line to cut, so the result is rebuilt per half zoom
// level (`lineGapZoomBucket`) and cached. Kept free of any renderer import so
// it can be unit tested and shared.

/** Feature property holding a gap label's text. */
export const LINE_GAP_TEXT_PROPERTY = "__geolibre_gap_text";
/** Feature property holding a gap label's clockwise rotation in degrees. */
export const LINE_GAP_ANGLE_PROPERTY = "__geolibre_gap_angle";

/** MapLibre's world size at zoom 0, in pixels. */
const TILE_SIZE = 512;
/** Web Mercator's latitude limit. */
const MAX_LATITUDE = 85.051129;
/**
 * How straight the line under a label must be: the chord between the gap's
 * ends over the gap's length along the line. Below it the straight text would
 * stick out of a bend.
 */
const MIN_STRAIGHTNESS = 0.92;

export interface LineGapLabelOptions {
  /** Zoom the placement is computed for (see {@link lineGapZoomBucket}). */
  zoom: number;
  /** Label text for a feature, or null/empty for no label. */
  textFor: (feature: Feature) => string | null;
  /** Width of a label's text in pixels. */
  measure: (text: string) => number;
  /** Text size in pixels, used for the label's collision box height. */
  size: number;
  /** Extra line removed on each side of the text, in pixels. */
  padding: number;
  /** Target distance between labels along one line, in pixels. */
  spacing: number;
  /** Keep labels whose boxes overlap other labels. */
  allowOverlap?: boolean;
  /**
   * Whether a feature's label is shown. A hidden feature keeps its line
   * uncut and reserves no space; null shows every feature.
   */
  visible?: ((feature: Feature) => boolean) | null;
}

export interface LineGapLabelResult {
  /** The input features, with labeled lines cut where their labels sit. */
  lines: FeatureCollection;
  /** One point per label, carrying the text and rotation properties. */
  labels: FeatureCollection;
}

/**
 * The zoom a line-gap placement is computed for: the current zoom rounded
 * down to a half level. Rounding down keeps every gap at least as wide as its
 * text across the bucket (pixels per map unit only grow as you zoom in), and
 * half levels keep a gap within ~1.4x of the text.
 */
export function lineGapZoomBucket(zoom: number): number {
  return Math.floor(Math.max(0, zoom) * 2) / 2;
}

function project(position: Position, worldSize: number): [number, number] {
  const lat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, position[1]));
  const sin = Math.sin((lat * Math.PI) / 180);
  const x = ((position[0] + 180) / 360) * worldSize;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;
  return [x, y];
}

/** A line part in screen pixels with its cumulative distance per vertex. */
interface MeasuredPart {
  coords: Position[];
  px: [number, number][];
  cum: number[];
  length: number;
  worldSize: number;
}

function measurePart(coords: Position[], worldSize: number): MeasuredPart {
  const px = coords.map((position) => project(position, worldSize));
  const cum = new Array<number>(px.length);
  cum[0] = 0;
  for (let i = 1; i < px.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1]);
  }
  return { coords, px, cum, length: cum[cum.length - 1] ?? 0, worldSize };
}

/** The segment index `i` with `cum[i] <= d <= cum[i + 1]`. */
function segmentAt(cum: number[], d: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

function pixelAt(part: MeasuredPart, d: number): [number, number] {
  const i = segmentAt(part.cum, d);
  const span = part.cum[i + 1] - part.cum[i];
  const t = span > 0 ? (d - part.cum[i]) / span : 0;
  const a = part.px[i];
  const b = part.px[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** The inverse of {@link project}: a world pixel back to lon/lat. */
function unproject([x, y]: [number, number], worldSize: number): Position {
  const lon = (x / worldSize) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / worldSize)) * 180) / Math.PI;
  return [lon, lat];
}

/**
 * The geographic position at distance `d`. Interpolated in screen pixels, the
 * space distances are measured in, then unprojected, so a gap of N pixels is N
 * pixels on the map. The line's own vertices are returned as they are.
 */
function positionAt(part: MeasuredPart, d: number): Position {
  const i = segmentAt(part.cum, d);
  const span = part.cum[i + 1] - part.cum[i];
  const t = span > 0 ? (d - part.cum[i]) / span : 0;
  const a = part.coords[i];
  const b = part.coords[i + 1] ?? a;
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pa = part.px[i];
  const pb = part.px[i + 1] ?? pa;
  return unproject([pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t], part.worldSize);
}

/** The part's coordinates between distances `from` and `to`. */
function slicePart(part: MeasuredPart, from: number, to: number): Position[] {
  const out: Position[] = [positionAt(part, from)];
  for (let i = 0; i < part.cum.length; i++) {
    if (part.cum[i] > from && part.cum[i] < to) out.push(part.coords[i]);
  }
  out.push(positionAt(part, to));
  return out;
}

/** Clockwise text rotation for the chord a->b, kept upright (-90..90]. */
function uprightAngle(a: [number, number], b: [number, number]): number {
  let angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  else if (angle <= -90) angle += 180;
  return Math.round(angle * 10) / 10;
}

/** Placed label circles in a uniform grid, for overlap checks. */
class CollisionGrid {
  private readonly cells = new Map<string, Array<[number, number, number]>>();
  /** Largest radius stored so far, so a search reaches every circle it can overlap. */
  private maxRadius = 0;
  constructor(private readonly cellSize: number) {}

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  collides(x: number, y: number, r: number): boolean {
    const reach = Math.ceil((r + this.maxRadius) / this.cellSize) + 1;
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (const [ox, oy, or] of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          if (Math.hypot(ox - x, oy - y) < or + r) return true;
        }
      }
    }
    return false;
  }

  add(x: number, y: number, r: number): void {
    this.maxRadius = Math.max(this.maxRadius, r);
    const key = this.key(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize));
    const cell = this.cells.get(key);
    if (cell) cell.push([x, y, r]);
    else this.cells.set(key, [[x, y, r]]);
  }
}

function lineParts(geometry: LineString | MultiLineString): Position[][] {
  return geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
}

/**
 * Place contour-style labels on a collection's lines and cut a gap in each
 * line under its label.
 *
 * Labels are spread along each line at roughly {@link LineGapLabelOptions.spacing}
 * and nudged along the line to a stretch straight enough for straight text
 * and clear of labels already placed. A line too short for its text gets no
 * label and no gap. Features that are not lines, or get no label, pass through
 * unchanged (the same object), and a cut line keeps its properties, so the
 * line's own styling, filters and identify still apply.
 *
 * @param collection The layer's features.
 * @param options Placement settings for one zoom.
 * @returns The cut lines and the label points.
 */
export function buildLineGapLabels(
  collection: FeatureCollection,
  options: LineGapLabelOptions,
): LineGapLabelResult {
  const worldSize = TILE_SIZE * 2 ** options.zoom;
  const padding = Math.max(0, options.padding);
  const spacing = Math.max(1, options.spacing);
  const textHeight = Math.max(1, options.size);
  const grid = new CollisionGrid(Math.max(16, spacing / 4));
  const widths = new Map<string, number>();
  const labels: Feature[] = [];
  const features = collection.features.map((feature) => {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "LineString" && geometry.type !== "MultiLineString")) {
      return feature;
    }
    if (options.visible && !options.visible(feature)) return feature;
    const raw = options.textFor(feature);
    const text = raw == null ? "" : String(raw).trim();
    if (!text) return feature;
    let width = widths.get(text);
    if (width === undefined) {
      width = Math.max(1, options.measure(text));
      widths.set(text, width);
    }
    const gap = width + 2 * padding;
    const half = gap / 2;
    // The collision circle spans the text's half-length, or its height for a
    // short value, so a "4" still keeps neighbours a line height away.
    const radius = Math.max(half, textHeight * 0.75);

    let cut = false;
    const pieces: Position[][] = [];
    for (const coords of lineParts(geometry)) {
      if (coords.length < 2) {
        pieces.push(coords);
        continue;
      }
      const part = measurePart(coords, worldSize);
      const intervals: Array<[number, number]> = [];
      if (part.length >= gap * 1.5) {
        const count = Math.max(1, Math.floor(part.length / spacing));
        for (let n = 0; n < count; n++) {
          const target = ((n + 0.5) * part.length) / count;
          for (const shift of [0, gap, -gap, 2 * gap, -2 * gap, 3 * gap, -3 * gap]) {
            const d = target + shift;
            if (d - half < 0 || d + half > part.length) continue;
            const a = pixelAt(part, d - half);
            const b = pixelAt(part, d + half);
            if (Math.hypot(b[0] - a[0], b[1] - a[1]) < gap * MIN_STRAIGHTNESS) continue;
            const center = pixelAt(part, d);
            if (!options.allowOverlap && grid.collides(center[0], center[1], radius)) continue;
            grid.add(center[0], center[1], radius);
            intervals.push([d - half, d + half]);
            labels.push({
              type: "Feature",
              properties: {
                ...feature.properties,
                [LINE_GAP_TEXT_PROPERTY]: text,
                [LINE_GAP_ANGLE_PROPERTY]: uprightAngle(a, b),
              },
              geometry: { type: "Point", coordinates: positionAt(part, d) },
            });
            break;
          }
        }
      }
      if (intervals.length === 0) {
        pieces.push(coords);
        continue;
      }
      cut = true;
      intervals.sort((x, y) => x[0] - y[0]);
      let from = 0;
      for (const [start, end] of intervals) {
        if (start > from) pieces.push(slicePart(part, from, start));
        from = end;
      }
      if (from < part.length) pieces.push(slicePart(part, from, part.length));
    }
    if (!cut) return feature;
    return {
      ...feature,
      geometry: { type: "MultiLineString", coordinates: pieces } satisfies MultiLineString,
    };
  });
  return {
    lines: { ...collection, features },
    labels: { type: "FeatureCollection", features: labels },
  };
}

/** Plain text of an evaluated `text-field` (a string, number or `Formatted`). */
function plainText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && Array.isArray((value as { sections?: unknown }).sections)) {
    return (value as { sections: Array<{ text?: string }> }).sections
      .map((section) => section.text ?? "")
      .join("");
  }
  return String(value);
}

function applyTransform(text: string, transform: LabelStyle["transform"]): string {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  return text;
}

/**
 * Label text per feature for a `text-field` value: the same expression the
 * symbol layer would evaluate (field lookup, number formatting, or the
 * user's expression), so the gap is cut for exactly the text drawn in it.
 * The letter-case transform is applied too, since it changes the width.
 * `zoom` is the zoom the expression is evaluated at, so a zoom-dependent
 * `text-field` matches the placement's zoom bucket.
 */
export function lineGapTextResolver(
  textField: unknown,
  transform: LabelStyle["transform"],
  zoom?: number,
): ((feature: Feature) => string | null) | null {
  if (typeof textField === "string") {
    const literal = applyTransform(textField, transform);
    return literal ? () => literal : null;
  }
  const compiled = compileFeatureExpression(JSON.stringify(textField));
  if (!compiled.ok || !compiled.evaluate) return null;
  const evaluate = compiled.evaluate;
  return (feature) => {
    try {
      return applyTransform(plainText(evaluate(feature, zoom)), transform);
    } catch {
      return null;
    }
  };
}

/**
 * Feature visibility for a label's `visibilityExpression` (a parsed boolean
 * override), evaluated at `zoom`. A feature whose expression fails to evaluate
 * is hidden, as the label layer's filter would hide it.
 */
function lineGapVisibilityResolver(
  visibility: unknown,
  zoom: number,
): ((feature: Feature) => boolean) | null {
  if (visibility == null) return null;
  const compiled = compileFeatureExpression(JSON.stringify(visibility));
  if (!compiled.ok || !compiled.evaluate) return null;
  const evaluate = compiled.evaluate;
  return (feature) => {
    try {
      return Boolean(evaluate(feature, zoom));
    } catch {
      return false;
    }
  };
}

// Placements per collection, keyed by everything that changes them, so a
// resync at the same zoom bucket hands back the same objects (which the
// geojson source then skips re-uploading) and zooming back is instant.
const placementCache = new WeakMap<FeatureCollection, Map<string, LineGapLabelResult>>();
const PLACEMENTS_PER_COLLECTION = 8;

/**
 * {@link buildLineGapLabels} for a layer's labels at a zoom, memoized per
 * collection, zoom bucket and label settings.
 *
 * @param collection The layer's features.
 * @param labels The layer's label settings.
 * @param textField The label layer's `text-field` value.
 * @param zoom The map's current zoom; placement uses its bucket.
 * @param measure Text width in pixels at the label size.
 * @returns The placement, or null when there is no usable label text.
 */
export function getLineGapLabels(
  collection: FeatureCollection,
  labels: LabelStyle,
  textField: unknown,
  zoom: number,
  measure: (text: string) => number,
): LineGapLabelResult | null {
  const bucket = lineGapZoomBucket(zoom);
  const key = JSON.stringify([
    bucket,
    textField,
    labels.transform,
    labels.size,
    labels.lineGapPadding,
    labels.lineSpacing,
    labels.allowOverlap,
    labels.visibilityExpression,
  ]);
  let byKey = placementCache.get(collection);
  const cached = byKey?.get(key);
  if (cached) return cached;
  const textFor = lineGapTextResolver(textField, labels.transform, bucket);
  if (!textFor) return null;
  const result = buildLineGapLabels(collection, {
    zoom: bucket,
    textFor,
    measure,
    size: Math.max(1, labels.size),
    padding: Math.max(0, labels.lineGapPadding),
    spacing: Math.max(1, labels.lineSpacing),
    allowOverlap: labels.allowOverlap,
    visible: lineGapVisibilityResolver(
      parseLabelOverride(labels.visibilityExpression, "boolean"),
      bucket,
    ),
  });
  if (!byKey) {
    byKey = new Map();
    placementCache.set(collection, byKey);
  }
  if (byKey.size >= PLACEMENTS_PER_COLLECTION) {
    const oldest = byKey.keys().next().value;
    if (oldest !== undefined) byKey.delete(oldest);
  }
  byKey.set(key, result);
  return result;
}
