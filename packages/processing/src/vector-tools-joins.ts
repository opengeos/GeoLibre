// Join vector tools: spatial join, summarize within and attribute join.

import intersect from "@turf/intersect";
import union from "@turf/union";
import bbox from "@turf/bbox";
import { featureCollection } from "@turf/helpers";
import type { Feature, GeoJsonProperties, Polygon, MultiPolygon } from "geojson";
import { horizontalBbox, layerJoinKey } from "@geolibre/core/worker-safe";
import { geodesicRingArea } from "@geolibre/core/geodesic";
import type { ProcessingAlgorithm } from "./types";
import {
  MAX_CLIENT_PAIRS,
  getLayer,
  requireFeatures,
  numberParam,
  isFamily,
  polygonFeatures,
  toNumeric,
  computeStat,
  type SpatialPredicate,
  rawPredicate,
  JOIN_FIELD_SUFFIX,
  propertyKeys,
  bboxesOverlap,
} from "./vector-tools-common";

type SpatialJoinHow = "inner" | "left";

/** Valid spatial-join predicates/join-types; kept in sync with the backend guard. */
const SPATIAL_JOIN_PREDICATES: SpatialPredicate[] = ["intersects", "within", "contains"];

const SPATIAL_JOIN_HOW: SpatialJoinHow[] = ["inner", "left"];

/**
 * Like {@link rawPredicate} but treats an unevaluable pair as a non-match rather
 * than letting the exception abort the whole run. Safe for positive predicates
 * (a pair that can't be evaluated simply doesn't match); the complement
 * (`disjoint`) must instead distinguish "no match" from "couldn't evaluate".
 */
function matchesPredicate(input: Feature, join: Feature, predicate: SpatialPredicate): boolean {
  try {
    return rawPredicate(input, join, predicate);
  } catch {
    return false;
  }
}

/**
 * Output name for each join-layer field, so no two output columns differ only
 * in case. DuckDB (the SQL workspace) and most databases treat column names
 * case-insensitively, so a join that keeps both `NAME` and `name` produces a
 * layer that cannot be queried (issue #3514).
 *
 * A join field that exactly matches an input field keeps its name: the input
 * value wins there, as before. A join field that matches an input field, or an
 * earlier join field, only case-insensitively is renamed with the `_right`
 * suffix GeoPandas' `sjoin` uses (`name_right`, then `name_right_2`, ...).
 *
 * @param inputKeys Every property name on the input (target) features.
 * @param joinKeys Join-layer property names in first-seen order.
 * @returns Map from each join key to its output name.
 */
export function joinFieldOutputNames(
  inputKeys: Iterable<string>,
  joinKeys: Iterable<string>,
): Map<string, string> {
  const input = new Set(inputKeys);
  const taken = new Set([...input].map((key) => key.toLowerCase()));
  const names = new Map<string, string>();
  for (const key of joinKeys) {
    if (names.has(key)) continue;
    if (input.has(key)) {
      names.set(key, key);
      continue;
    }
    let name = key;
    if (taken.has(name.toLowerCase())) {
      name = `${key}${JOIN_FIELD_SUFFIX}`;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) {
        name = `${key}${JOIN_FIELD_SUFFIX}_${n}`;
      }
    }
    taken.add(name.toLowerCase());
    names.set(key, name);
  }
  return names;
}

/** Copy `properties` with each key renamed through `names` (unmapped keys kept). */
function renameProperties(
  properties: GeoJsonProperties,
  names: Map<string, string>,
): Record<string, unknown> {
  // A null prototype keeps a `__proto__` key as an ordinary own property
  // (assignment into `{}` would hit the inherited setter and drop it).
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(properties ?? {})) {
    out[names.get(key) ?? key] = value;
  }
  return out;
}

export const spatialJoinTool: ProcessingAlgorithm = {
  id: "spatial-join",
  name: "Spatial join",
  description:
    "Attach attributes from a join layer to each input feature based on a spatial relationship",
  group: "Join",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Input layer", type: "layer", required: true },
    { id: "overlay", label: "Join layer", type: "layer", required: true },
    {
      id: "predicate",
      label: "Spatial relationship",
      type: "select",
      default: "intersects",
      options: [
        { value: "intersects", label: "Intersects" },
        { value: "within", label: "Within" },
        { value: "contains", label: "Contains" },
      ],
    },
    {
      id: "how",
      label: "Join type",
      type: "select",
      default: "inner",
      options: [
        { value: "inner", label: "Inner (keep only matched features)" },
        { value: "left", label: "Left (keep all input features)" },
      ],
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    if (!input) return;
    const joinLayer = getLayer(ctx, "overlay");
    if (!joinLayer) {
      ctx.log('Error: parameter "overlay" has no layer selected');
      return;
    }
    const inputFeatures = input.features.filter((f) => f.geometry);
    if (!inputFeatures.length) {
      ctx.log("Error: input layer has no features with geometry");
      return;
    }
    // Validate up front so unknown values fail loudly instead of silently
    // coercing to a default, matching the backend's ValueError guard.
    const predicate = (ctx.parameters.predicate as string) || "intersects";
    if (!SPATIAL_JOIN_PREDICATES.includes(predicate as SpatialPredicate)) {
      ctx.log(
        `Error: unknown predicate '${predicate}'; expected ${SPATIAL_JOIN_PREDICATES.join(", ")}`,
      );
      return;
    }
    const how = (ctx.parameters.how as string) || "inner";
    if (!SPATIAL_JOIN_HOW.includes(how as SpatialJoinHow)) {
      ctx.log(`Error: unknown join type '${how}'; expected ${SPATIAL_JOIN_HOW.join(", ")}`);
      return;
    }
    // An empty join layer is still well-defined: a left join keeps every input
    // feature unchanged, an inner join yields nothing (mirrors gpd.sjoin).
    const joinFeatures = (joinLayer.geojson?.features ?? []).filter((f) => f.geometry);
    // This pairwise test runs on the main thread; cap it so very large layers
    // cannot freeze the browser tab. Use the Sidecar engine for bigger jobs.
    const pairs = inputFeatures.length * joinFeatures.length;
    if (pairs > MAX_CLIENT_PAIRS) {
      ctx.log(
        `Error: spatial join needs ${pairs} comparisons (limit ${MAX_CLIENT_PAIRS}); use the Sidecar engine for large layers`,
      );
      return;
    }
    // Collect every join-layer attribute key so unmatched left-join rows get a
    // null for each one. This keeps the output schema consistent with matched
    // rows and mirrors GeoPandas, which fills NaN (→ null in GeoJSON) there.
    // Only the left path null-fills unmatched rows, but matched rows of both
    // joins use these names, so the scan always runs.
    // Rename join fields that clash case-insensitively with an input field so
    // the output never carries both `NAME` and `name` (issue #3514).
    const joinNames = joinFieldOutputNames(propertyKeys(inputFeatures), propertyKeys(joinFeatures));
    // Null prototype: a `__proto__` field stays an own property.
    const nullJoinProps: Record<string, unknown> = Object.create(null);
    if (how === "left") {
      for (const name of joinNames.values()) nullJoinProps[name] = null;
    }
    const results: Feature[] = [];
    for (const feature of inputFeatures) {
      const matches = joinFeatures.filter((j) =>
        matchesPredicate(feature, j, predicate as SpatialPredicate),
      );
      if (!matches.length) {
        // Left join keeps unmatched input features; inner join drops them,
        // mirroring gpd.sjoin(how=...). Null-fill the join columns so the
        // schema matches matched rows and the sidecar.
        if (how === "left") {
          results.push({
            type: "Feature",
            geometry: feature.geometry,
            properties: { ...nullJoinProps, ...(feature.properties ?? {}) },
          });
        }
        continue;
      }
      // One output feature per match, like GeoPandas sjoin. Input attributes win
      // on exact name collisions (the sidecar instead suffixes them
      // _left/_right); case-only collisions were renamed above.
      // Build a fresh feature (no `id`) so a one-to-many join does not emit
      // duplicate feature ids, which would corrupt MapLibre feature state.
      for (const match of matches) {
        results.push({
          type: "Feature",
          geometry: feature.geometry,
          properties: {
            ...renameProperties(match.properties, joinNames),
            ...(feature.properties ?? {}),
          },
        });
      }
    }
    ctx.log(`Spatial join: produced ${results.length} feature(s)`);
    ctx.addResultLayer?.("Spatial join", featureCollection(results));
  },
};

/** Statistics Summarize within adds for its optional numeric field. */
const SUMMARIZE_STATS = ["sum", "mean", "min", "max"] as const;

/**
 * Area in square metres of a Polygon or MultiPolygon on the active body: each
 * outer ring minus its holes, measured geodesically like the Measure tool.
 */
function polygonAreaM2(geometry: Polygon | MultiPolygon): number {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const rings of polygons) {
    rings.forEach((ring, index) => {
      total += index === 0 ? geodesicRingArea(ring) : -geodesicRingArea(ring);
    });
  }
  return Math.max(0, total);
}

/**
 * Upper bound on polygon-to-polygon clips in one Summarize within run. Each is a
 * full polygon-clipping pass, which costs milliseconds on detailed parcels, so
 * the pair cap alone does not bound the runtime.
 */
const MAX_SUMMARIZE_CLIPS = 20_000;

/**
 * Area of the union of the overlap pieces inside one polygon, so two pieces of
 * the summarized layer that overlap each other are not counted twice. Returns
 * null when Turf cannot union them: summing the pieces instead would double
 * count exactly the overlaps the union exists to remove.
 */
function coveredAreaM2(pieces: Feature<Polygon | MultiPolygon>[]): number | null {
  if (!pieces.length) return 0;
  if (pieces.length === 1) return polygonAreaM2(pieces[0].geometry);
  try {
    const merged = union(featureCollection(pieces));
    return merged ? polygonAreaM2(merged.geometry as Polygon | MultiPolygon) : null;
  } catch {
    return null;
  }
}

/**
 * Summarize within: for each polygon, count the features of another layer that
 * fall in it, reduce one of their numeric fields, and, when that layer has
 * polygons, report how much of the polygon they cover.
 *
 * Points and lines count when they intersect the polygon (a point on a shared
 * edge counts for both sides). Polygons count only when they overlap it by a
 * positive area at least `min_overlap_pct` of the polygon, so a neighbour that
 * only touches along an edge, or a digitizing sliver, is left out of the count,
 * the statistics and the covered area alike.
 */
export const summarizeWithinTool: ProcessingAlgorithm = {
  id: "summarize-within",
  name: "Summarize within",
  description:
    "Count the features of another layer that intersect each polygon, summarize a numeric field, and measure how much of each polygon they cover",
  group: "Join",
  parameters: [
    {
      id: "layer",
      label: "Polygon layer",
      type: "layer",
      required: true,
      geometryFilter: ["polygon"],
    },
    { id: "overlay", label: "Layer to summarize", type: "layer", required: true },
    {
      id: "field",
      label: "Numeric field",
      type: "field",
      fieldSource: "overlay",
      description: "Optional. Adds the sum, mean, min and max of this field for each polygon.",
    },
    {
      id: "min_overlap_pct",
      label: "Ignore overlaps smaller than (%)",
      type: "number",
      default: 0,
      min: 0,
      max: 100,
      step: 0.1,
      description:
        "When the layer to summarize has polygons, skip any that cover less than this share of a polygon, such as slivers along shared edges.",
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    if (!input) return;
    const overlayLayer = getLayer(ctx, "overlay");
    if (!overlayLayer) {
      ctx.log('Error: parameter "overlay" has no layer selected');
      return;
    }
    if (ctx.parameters.layer === ctx.parameters.overlay) {
      // Not an error (Spatial join allows it too), but every polygon then
      // matches itself and reads as fully covered.
      ctx.log(
        "Warning: both inputs are the same layer, so each polygon counts itself and shows 100% coverage",
      );
    }
    const targets = polygonFeatures(input);
    if (!targets.length) {
      ctx.log("Error: the polygon layer has no polygon features");
      return;
    }
    const nonPolygons = input.features.length - targets.length;
    if (nonPolygons > 0) {
      ctx.log(
        `Note: ${nonPolygons} non-polygon feature(s) in the polygon layer were skipped and are not in the result`,
      );
    }
    const field = typeof ctx.parameters.field === "string" ? ctx.parameters.field.trim() : "";
    const minPct = numberParam(ctx, "min_overlap_pct", 0);
    if (minPct < 0 || minPct > 100) {
      ctx.log("Error: the minimum overlap must be between 0 and 100%");
      return;
    }
    const overlayFeatures = (overlayLayer.geojson?.features ?? []).filter((f) => f.geometry);
    if (!overlayFeatures.length) {
      ctx.log("Warning: the layer to summarize has no features, so every count is 0");
    }
    if (
      field &&
      overlayFeatures.length &&
      !overlayFeatures.some((f) => f.properties && field in f.properties)
    ) {
      ctx.log(`Warning: no feature in the layer to summarize has a field "${field}"`);
    }
    // Pairwise on the main thread (or a worker); cap it like Spatial join.
    const pairs = targets.length * overlayFeatures.length;
    if (pairs > MAX_CLIENT_PAIRS) {
      ctx.log(
        `Error: summarize within needs ${pairs} comparisons (limit ${MAX_CLIENT_PAIRS}); filter or clip the layers first`,
      );
      return;
    }
    // Turf returns a feature's stored bbox member unless told to recompute, and
    // a stale one from the source file would hide real matches.
    const boundsOf = (f: Feature) => horizontalBbox(bbox(f, { recompute: true }));
    // Turf throws on a geometry type it doesn't know; skip that feature rather
    // than abort the run, and report it below.
    const overlayBoxes = overlayFeatures.map((f) => {
      try {
        return boundsOf(f);
      } catch {
        return null;
      }
    });
    const unreadable = overlayBoxes.filter((box) => box === null).length;
    const isPolygon = overlayFeatures.map((f) => isFamily(f.geometry, "polygon"));
    const hasPolygons = isPolygon.some(Boolean);
    const candidates = targets.map((target) => {
      const box = boundsOf(target);
      return overlayFeatures.flatMap((_, i) => {
        const other = overlayBoxes[i];
        return other && bboxesOverlap(box, other) ? [i] : [];
      });
    });
    const clips = candidates.reduce((n, list) => n + list.filter((i) => isPolygon[i]).length, 0);
    if (clips > MAX_SUMMARIZE_CLIPS) {
      ctx.log(
        `Error: summarize within needs ${clips} polygon overlaps (limit ${MAX_SUMMARIZE_CLIPS}); filter or clip the layers first`,
      );
      return;
    }

    const statKeys = field ? SUMMARIZE_STATS.map((stat) => `${stat}_${field}`) : [];
    const outputKeys = [
      "count",
      ...statKeys,
      ...(hasPolygons ? ["overlap_km2", "overlap_pct"] : []),
    ];
    const existing = new Set(targets.flatMap((t) => Object.keys(t.properties ?? {})));
    const clashes = outputKeys.filter((key) => existing.has(key));
    if (clashes.length) {
      ctx.log(`Warning: replacing the existing field(s) ${clashes.join(", ")}`);
    }

    let slivers = 0;
    let failedClips = 0;
    let failedChecks = 0;
    let matched = 0;
    const results: Feature[] = targets.map((target, targetIndex) => {
      const targetArea = hasPolygons ? polygonAreaM2(target.geometry) : 0;
      let count = 0;
      const values: number[] = [];
      const pieces: Feature<Polygon | MultiPolygon>[] = [];
      for (const index of candidates[targetIndex]) {
        const feature = overlayFeatures[index];
        if (isPolygon[index]) {
          let piece: Feature<Polygon | MultiPolygon> | null;
          try {
            piece = intersect(
              featureCollection([target, feature as Feature<Polygon | MultiPolygon>]),
            ) as Feature<Polygon | MultiPolygon> | null;
          } catch {
            // Invalid or self-intersecting geometry; reported once below.
            failedClips += 1;
            continue;
          }
          const pieceArea = piece ? polygonAreaM2(piece.geometry) : 0;
          if (!piece || pieceArea <= 0) continue;
          if (targetArea > 0 && (pieceArea / targetArea) * 100 < minPct) {
            slivers += 1;
            continue;
          }
          pieces.push(piece);
        } else {
          let hit: boolean;
          try {
            hit = rawPredicate(feature, target, "intersects");
          } catch {
            // Reported once below, like a polygon pair that fails to clip.
            failedChecks += 1;
            continue;
          }
          if (!hit) continue;
        }
        count += 1;
        if (field) {
          const value = toNumeric(feature.properties?.[field]);
          if (value !== null) values.push(value);
        }
      }

      if (count > 0) matched += 1;
      const properties: Record<string, unknown> = { ...(target.properties ?? {}), count };
      if (field) {
        SUMMARIZE_STATS.forEach((stat, i) => {
          properties[statKeys[i]] = computeStat(values, stat);
        });
      }
      if (hasPolygons) {
        const covered = coveredAreaM2(pieces);
        if (covered === null) {
          ctx.log(
            `Warning: could not merge the overlaps in polygon ${targetIndex + 1}, so its coverage is left empty`,
          );
        }
        // Rounded so the table reads cleanly: km² to 6 places (about 1 m²), the
        // share to 2 places. Geodesic edges leave noise past those digits.
        properties.overlap_km2 = covered === null ? null : Math.round(covered) / 1e6;
        properties.overlap_pct =
          covered !== null && targetArea > 0
            ? Math.round(Math.min(100, (covered / targetArea) * 100) * 100) / 100
            : null;
      }
      return { ...target, properties };
    });

    ctx.log(`Summarize within: ${matched} of ${results.length} polygon(s) contain features`);
    if (slivers) {
      ctx.log(`Summarize within: ignored ${slivers} overlap(s) below ${minPct}% of a polygon`);
    }
    if (failedClips) {
      ctx.log(
        `Warning: skipped ${failedClips} polygon pair(s) whose geometry could not be intersected; try Fix geometries first`,
      );
    }
    if (failedChecks) {
      ctx.log(
        `Warning: skipped ${failedChecks} point or line pair(s) whose geometry could not be compared; try Fix geometries first`,
      );
    }
    if (unreadable) {
      ctx.log(
        `Warning: skipped ${unreadable} feature(s) in the layer to summarize with a geometry that could not be read`,
      );
    }
    ctx.addResultLayer?.("Summarize within", featureCollection(results));
  },
};

/**
 * Match key for the Attribute join tool: empty values (null/undefined/NaN/empty
 * string) never match a row, mirroring a SQL/pandas NaN join key. Non-empty
 * values are keyed stringified, so a numeric `5` and the string `"5"` join
 * (both render `"5"`) while a zero-padded code like `"01001"` only matches
 * another `"01001"`. Delegates to `@geolibre/core`'s {@link layerJoinKey} —
 * the persistent-join engine's key — so the two client-side joins cannot
 * drift; the backend's ``_attribute_join_key`` remains the Python mirror.
 */
const attributeJoinKey = layerJoinKey;

/**
 * Join types accepted by the Attribute join tool. Kept local (rather than
 * reusing the spatial join's set) so a future spatial-join-only option cannot
 * silently become valid here; kept in sync with the backend's `_ATTRIBUTE_JOIN_HOW`.
 */
const ATTRIBUTE_JOIN_HOW = ["inner", "left"] as const;

export const attributeJoinTool: ProcessingAlgorithm = {
  id: "attribute-join",
  name: "Attribute join",
  description:
    "Attach attributes from a join layer (a table) onto each input feature where a key field matches, without using geometry. One-to-one: the first matching join row wins.",
  group: "Join",
  supportsSidecar: true,
  parameters: [
    { id: "layer", label: "Target layer", type: "layer", required: true },
    {
      id: "overlay",
      label: "Join layer (table)",
      type: "layer",
      required: true,
      description: "The layer whose attributes are brought over. Its geometry is ignored.",
    },
    {
      id: "target_field",
      label: "Target key field",
      type: "field",
      fieldSource: "layer",
      required: true,
    },
    {
      id: "join_field",
      label: "Join key field",
      type: "field",
      fieldSource: "overlay",
      required: true,
    },
    {
      id: "how",
      label: "Join type",
      type: "select",
      default: "left",
      options: [
        { value: "left", label: "Left (keep all target features)" },
        { value: "inner", label: "Inner (keep only matched features)" },
      ],
    },
    {
      id: "fields",
      label: "Fields to bring over (optional)",
      type: "string",
      description:
        "Comma-separated join fields to copy. Leave blank to bring over every join field except the key.",
    },
  ],
  run: (ctx) => {
    const input = requireFeatures(ctx, "layer");
    if (!input) return;
    const joinLayer = getLayer(ctx, "overlay");
    if (!joinLayer) {
      ctx.log('Error: parameter "overlay" has no layer selected');
      return;
    }
    const targetField = (ctx.parameters.target_field as string)?.trim();
    if (!targetField) {
      ctx.log("Error: a target key field is required");
      return;
    }
    const joinField = (ctx.parameters.join_field as string)?.trim();
    if (!joinField) {
      ctx.log("Error: a join key field is required");
      return;
    }
    const how = (ctx.parameters.how as string) || "left";
    if (!ATTRIBUTE_JOIN_HOW.includes(how as (typeof ATTRIBUTE_JOIN_HOW)[number])) {
      ctx.log(`Error: unknown join type '${how}'; expected ${ATTRIBUTE_JOIN_HOW.join(", ")}`);
      return;
    }
    // An empty join layer is well-defined: a left join keeps every target
    // feature (no columns added), an inner join yields nothing.
    const joinFeatures = (joinLayer.geojson?.features ?? []).filter(Boolean);

    // Collect every join-layer attribute key in first-seen order so the output
    // schema is deterministic across both engines.
    const joinKeysOrder: string[] = [];
    const joinKeySet = new Set<string>();
    for (const jf of joinFeatures) {
      for (const key of Object.keys(jf.properties ?? {})) {
        if (!joinKeySet.has(key)) {
          joinKeySet.add(key);
          joinKeysOrder.push(key);
        }
      }
    }

    const fieldsRaw = (ctx.parameters.fields as string)?.trim();
    const requestedFields = fieldsRaw
      ? fieldsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;
    let selectedFields: string[];
    // An empty array (e.g. fields = "," or ", ,") means the user effectively
    // left the field blank, so fall through to the default rather than erroring.
    if (requestedFields && requestedFields.length > 0) {
      selectedFields = requestedFields.filter((f) => joinKeySet.has(f));
      const missing = requestedFields.filter((f) => !joinKeySet.has(f));
      if (missing.length) {
        ctx.log(`Note: join field(s) not found and skipped: ${missing.join(", ")}`);
      }
      if (!selectedFields.length) {
        ctx.log("Error: none of the requested join fields exist in the join layer");
        return;
      }
    } else {
      // Default: bring over every join field except the key (which would just
      // duplicate the target key column).
      selectedFields = joinKeysOrder.filter((k) => k !== joinField);
      // A join layer that carries only the key column transfers no attributes;
      // warn so the user isn't left thinking a silent no-op succeeded.
      if (joinFeatures.length && !selectedFields.length) {
        ctx.log("Note: no fields to bring over (join layer only contains the key column)");
      }
    }

    // First-match lookup: when several join rows share a key, the first wins.
    const lookup = new Map<string, GeoJsonProperties>();
    for (const jf of joinFeatures) {
      const jfProps = jf.properties;
      const key =
        jfProps && Object.hasOwn(jfProps, joinField) ? attributeJoinKey(jfProps[joinField]) : null;
      if (key === null) continue;
      if (!lookup.has(key)) lookup.set(key, jfProps);
    }

    // Null-fill the brought-over columns for unmatched left-join rows so the
    // output schema stays consistent (mirrors the spatial join and the sidecar).
    // Rename brought-over fields that clash case-insensitively with a target
    // field, so the output never carries both `NAME` and `name` (issue #3514).
    const outputNames = joinFieldOutputNames(propertyKeys(input.features), selectedFields);
    // Null prototype: a `__proto__` field stays an own property.
    const nullFill: Record<string, unknown> = Object.create(null);
    for (const f of selectedFields) nullFill[outputNames.get(f) ?? f] = null;

    let matched = 0;
    const results: Feature[] = [];
    for (const feature of input.features) {
      const fProps = feature.properties;
      const key =
        fProps && Object.hasOwn(fProps, targetField) ? attributeJoinKey(fProps[targetField]) : null;
      const joinProps = key === null ? undefined : lookup.get(key);
      if (!joinProps) {
        if (how === "left") {
          results.push({
            type: "Feature",
            ...(feature.id !== undefined ? { id: feature.id } : {}),
            // Target attributes win on a name collision with a null-filled column.
            properties: { ...nullFill, ...(feature.properties ?? {}) },
            geometry: feature.geometry,
          });
        }
        continue;
      }
      matched += 1;
      // Null prototype: a `__proto__` field stays an own property.
      const picked: Record<string, unknown> = Object.create(null);
      for (const f of selectedFields) {
        // Own properties only: an absent `__proto__` would read Object.prototype.
        const value = Object.hasOwn(joinProps, f) ? joinProps[f] : undefined;
        picked[outputNames.get(f) ?? f] = value !== undefined ? value : null;
      }
      results.push({
        type: "Feature",
        ...(feature.id !== undefined ? { id: feature.id } : {}),
        // Target attributes win on name collisions with brought-over fields.
        properties: { ...picked, ...(feature.properties ?? {}) },
        geometry: feature.geometry,
      });
    }
    ctx.log(
      `Attribute join: ${matched} of ${input.features.length} feature(s) matched; produced ${results.length} feature(s)`,
    );
    ctx.addResultLayer?.("Attribute join", featureCollection(results));
  },
};
