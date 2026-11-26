import { featureCollection } from "@turf/helpers";
import type { Feature, LineString, MultiLineString } from "geojson";
import {
  decodePolylineDetailed,
  encodePolyline,
  type GeoLibreLayer,
} from "@geolibre/core/worker-safe";
import type { ProcessingAlgorithm } from "./types";
import { requireFeatures } from "./vector-tools-common";
export {
  parseTimestamp,
  cellSectorsTool,
  trajectorySpeedTool,
  detectStopsTool,
  spaceTimeProximityTool,
} from "./vector-tools-movement";
export {
  reprojectTool,
  explodeTool,
  aggregateTool,
  smoothTool,
  extractVerticesTool,
  pointsAlongGeometryTool,
  gridTool,
  voronoiTool,
} from "./vector-tools-geometry";
export {
  selectByValueTool,
  type SelectLocationPredicate,
  SELECT_LOCATION_PREDICATES,
  type LocationMatches,
  matchFeaturesByLocation,
  selectByLocationTool,
  randomExtractTool,
} from "./vector-tools-selection";
export {
  joinFieldOutputNames,
  spatialJoinTool,
  summarizeWithinTool,
  attributeJoinTool,
} from "./vector-tools-joins";
export {
  bufferTool,
  centroidsTool,
  convexHullTool,
  dissolveTool,
  boundingBoxTool,
  simplifyTool,
  clipTool,
  intersectionTool,
  differenceTool,
  unionTool,
} from "./vector-tools-geoprocessing";
export { MAX_CLIENT_PAIRS, booleanParam, hasPositions } from "./vector-tools-common";

export const mergeLayersTool: ProcessingAlgorithm = {
  id: "merge-layers",
  name: "Merge layers",
  description:
    "Combine several vector layers into one, uniting their attribute schemas (missing attributes become null)",
  group: "Data management",
  parameters: [
    {
      id: "layers",
      label: "Input layers",
      type: "layers",
      required: true,
      description: "Select two or more layers; they are concatenated in the order shown",
    },
    {
      id: "addSourceField",
      label: "Add source layer field",
      type: "boolean",
      default: true,
      description: "Record each output feature's originating layer name",
    },
    {
      id: "sourceFieldName",
      label: "Source field name",
      type: "string",
      default: "source",
      description: "Name of the field that stores the originating layer name",
    },
  ],
  run: (ctx) => {
    // De-duplicate: the multi-select cannot repeat an option, but a replayed
    // History entry could, and merging a layer into itself twice is never meant.
    const ids = Array.isArray(ctx.parameters.layers)
      ? [...new Set(ctx.parameters.layers as string[])]
      : [];
    if (ids.length < 2) {
      ctx.log('Error: parameter "layers" requires at least two selected layers');
      return;
    }
    const addSource = ctx.parameters.addSourceField !== false;
    const rawFieldName = (ctx.parameters.sourceFieldName as string)?.trim();
    const sourceField = rawFieldName || "source";

    // Resolve first so a layer deleted since it was selected (or a stale
    // History re-run) is reported as missing rather than as merely empty.
    const resolved = ids.map((id) => ctx.layers.find((l) => l.id === id));
    const missing = resolved.filter((l) => !l).length;
    if (missing) ctx.log(`Skipped ${missing} selected layer(s) that no longer exist`);
    // Require a feature that will actually be emitted: a layer whose features
    // all have null geometry contributes nothing to the output below, so it is
    // a skip, not a merged layer.
    const selected = resolved.filter((l): l is GeoLibreLayer =>
      Boolean(l?.geojson?.features?.some((feature) => feature.geometry)),
    );
    const unusable = ids.length - missing - selected.length;
    if (unusable) ctx.log(`Skipped ${unusable} selected layer(s) with no usable geometry`);
    if (!selected.length) {
      ctx.log("Error: none of the selected layers has usable geometry");
      return;
    }
    // The source field is written last and would otherwise overwrite an input
    // attribute of the same name, so refuse rather than silently drop data.
    if (
      addSource &&
      selected.some((layer) =>
        layer.geojson!.features.some(
          (feature) =>
            feature.geometry &&
            Object.prototype.hasOwnProperty.call(feature.properties ?? {}, sourceField),
        ),
      )
    ) {
      ctx.log(
        `Error: source field '${sourceField}' already exists in an input layer; choose a different source field name`,
      );
      return;
    }

    // Union of property keys in first-seen order, so the merged attribute
    // schema is stable regardless of feature iteration.
    const schema: string[] = [];
    const seen = new Set<string>();
    if (addSource) {
      schema.push(sourceField);
      seen.add(sourceField);
    }
    for (const layer of selected) {
      for (const feature of layer.geojson!.features) {
        // Skip features the output builder drops, so a property carried only
        // by a null-geometry feature does not become an always-null column.
        if (!feature.geometry) continue;
        for (const key of Object.keys(feature.properties ?? {})) {
          if (!seen.has(key)) {
            seen.add(key);
            schema.push(key);
          }
        }
      }
    }

    // Build fresh features (no `id`): two input layers routinely number their
    // features from the same base, so carrying ids across a merge would emit
    // duplicates, which would corrupt MapLibre feature state. Same reasoning as
    // the one-to-many spatial join above.
    const out = featureCollection(
      selected.flatMap((layer) =>
        layer
          .geojson!.features.filter((feature) => feature.geometry)
          .map((feature) => ({
            type: "Feature" as const,
            properties: Object.fromEntries(
              schema.map((key) => {
                if (key === sourceField && addSource) return [key, layer.name];
                const props = feature.properties ?? {};
                // Own-property lookup: a bare `props[key]` resolves "__proto__"
                // to Object.prototype for a feature that lacks it, and `?? null`
                // does not catch that because it is not nullish. JSON.parse does
                // create an own "__proto__" key, so this is reachable from a file.
                return [
                  key,
                  Object.prototype.hasOwnProperty.call(props, key) ? (props[key] ?? null) : null,
                ];
              }),
            ),
            geometry: feature.geometry!,
          })),
      ),
    );

    ctx.log(
      `Merged ${selected.length} layer(s): ${out.features.length} feature(s), ${schema.length} attribute(s)`,
    );
    ctx.addResultLayer?.("Merged layers", out);
  },
};

export const decodePolylineTool: ProcessingAlgorithm = {
  id: "decode-polyline",
  name: "Decode polyline",
  description:
    "Decode encoded polyline strings from an attribute field into a LineString vector layer",
  group: "Geometry",
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
    },
    {
      id: "field",
      label: "Polyline field",
      type: "field",
      description: "Attribute field containing the encoded polyline string",
      required: true,
    },
    {
      id: "precision",
      label: "Precision",
      type: "select",
      options: [
        { label: "5 (Google / OSRM)", value: "5" },
        { label: "6 (Valhalla / Mapbox)", value: "6" },
      ],
      default: "5",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const field = (ctx.parameters.field as string)?.trim();
    if (!field) {
      ctx.log("Error: please specify a polyline field");
      return;
    }
    const rawPrecision = ctx.parameters.precision;
    const precision = rawPrecision === "6" || rawPrecision === 6 ? 6 : 5;

    const outFeatures: Feature<LineString | MultiLineString>[] = [];
    let skipped = 0;

    for (const feature of fc.features) {
      const rawVal = feature.properties?.[field];
      if (typeof rawVal !== "string" || !rawVal.trim()) {
        skipped++;
        continue;
      }
      const val = rawVal.trim();
      const parts = val
        .split(";")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) {
        skipped++;
        continue;
      }

      let valid = true;
      const multiCoords: [number, number][][] = [];

      for (const part of parts) {
        for (let i = 0; i < part.length; i++) {
          const code = part.charCodeAt(i);
          if (code < 63 || code > 126) {
            valid = false;
            break;
          }
        }
        if (!valid) break;

        const decodeResult = decodePolylineDetailed(part, precision);
        if (!decodeResult.complete) {
          valid = false;
          break;
        }

        const coords = decodeResult.coordinates;
        if (coords.length < 2) {
          valid = false;
          break;
        }

        for (const [lon, lat] of coords) {
          if (
            !Number.isFinite(lon) ||
            !Number.isFinite(lat) ||
            lon < -180 ||
            lon > 180 ||
            lat < -90 ||
            lat > 90
          ) {
            valid = false;
            break;
          }
        }
        if (!valid) break;

        multiCoords.push(coords);
      }

      if (!valid || multiCoords.length === 0) {
        skipped++;
        continue;
      }

      if (multiCoords.length === 1) {
        outFeatures.push({
          type: "Feature",
          properties: { ...(feature.properties ?? {}) },
          geometry: {
            type: "LineString",
            coordinates: multiCoords[0],
          },
        });
      } else {
        outFeatures.push({
          type: "Feature",
          properties: { ...(feature.properties ?? {}) },
          geometry: {
            type: "MultiLineString",
            coordinates: multiCoords,
          },
        });
      }
    }

    if (skipped > 0) {
      ctx.log(`Skipped ${skipped} feature(s) with missing or invalid polyline string`);
    }
    ctx.log(`Decoded ${outFeatures.length} line feature(s) from "${field}"`);
    ctx.addResultLayer?.("Decoded polylines", featureCollection(outFeatures));
  },
};

export const encodePolylineTool: ProcessingAlgorithm = {
  id: "encode-polyline",
  name: "Encode line to polyline",
  description:
    "Encode LineString and MultiLineString geometries into an encoded polyline attribute string",
  group: "Geometry",
  parameters: [
    {
      id: "layer",
      label: "Input layer",
      type: "layer",
      required: true,
      geometryFilter: ["line"],
    },
    {
      id: "precision",
      label: "Precision",
      type: "select",
      options: [
        { label: "5 (Google / OSRM)", value: "5" },
        { label: "6 (Valhalla / Mapbox)", value: "6" },
      ],
      default: "5",
    },
    {
      id: "targetField",
      label: "Output field name",
      type: "string",
      description: "Name of the attribute column to store encoded polylines (default: polyline)",
    },
  ],
  run: (ctx) => {
    const fc = requireFeatures(ctx);
    if (!fc) return;
    const rawPrecision = ctx.parameters.precision;
    const precision = rawPrecision === "6" || rawPrecision === 6 ? 6 : 5;
    const targetField = ((ctx.parameters.targetField as string) || "").trim() || "polyline";

    const outFeatures: Feature[] = [];
    let encodedCount = 0;

    for (const feature of fc.features) {
      const geometry = feature.geometry;
      let polylineStr = "";
      if (geometry?.type === "LineString") {
        polylineStr = encodePolyline(geometry.coordinates as [number, number][], precision);
      } else if (geometry?.type === "MultiLineString") {
        polylineStr = geometry.coordinates
          .map((lineCoords) => encodePolyline(lineCoords as [number, number][], precision))
          .filter(Boolean)
          .join(";");
      }
      if (polylineStr) encodedCount++;
      outFeatures.push({
        ...feature,
        properties: {
          ...(feature.properties ?? {}),
          [targetField]: polylineStr,
        },
      });
    }

    ctx.log(
      `Encoded ${encodedCount} line feature(s) into field "${targetField}" (precision ${precision})`,
    );
    ctx.addResultLayer?.("Encoded polylines", featureCollection(outFeatures));
  },
};
