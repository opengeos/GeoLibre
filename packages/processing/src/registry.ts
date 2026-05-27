import bbox from "@turf/bbox";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ProcessingAlgorithm, ProcessingContext } from "./types";

function getLayer(
  ctx: ProcessingContext,
  paramId = "layer",
): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === layerId);
}

export const calculateBoundsAlgorithm: ProcessingAlgorithm = {
  id: "calculate-bounds",
  name: "Calculate layer bounds",
  description: "Compute the bounding box of a GeoJSON layer",
  parameters: [
    { id: "layer", label: "Layer", type: "layer", required: true },
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const bounds = bbox(layer.geojson) as [number, number, number, number];
    ctx.log(
      `Bounds: [${bounds.map((n) => n.toFixed(6)).join(", ")}]`,
    );
    ctx.fitBounds?.(bounds);
  },
};

export const countFeaturesAlgorithm: ProcessingAlgorithm = {
  id: "count-features",
  name: "Count features",
  description: "Count features in a GeoJSON layer",
  parameters: [
    { id: "layer", label: "Layer", type: "layer", required: true },
  ],
  run: (ctx) => {
    const layer = getLayer(ctx);
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const count = layer.geojson.features?.length ?? 0;
    ctx.log(`Feature count: ${count}`);
  },
};

export const exportGeoJsonPlaceholder: ProcessingAlgorithm = {
  id: "export-geojson",
  name: "Export GeoJSON",
  description: "Export layer to GeoJSON file",
  parameters: [
    { id: "layer", label: "Layer", type: "layer", required: true },
  ],
  run: (ctx) => {
    // TODO(v0.5): Export via Tauri save dialog
    ctx.log("Not implemented — export GeoJSON planned for v0.5");
  },
};

export const bufferPlaceholder: ProcessingAlgorithm = {
  id: "buffer",
  name: "Buffer",
  description: "Buffer geometries by distance",
  parameters: [
    { id: "layer", label: "Layer", type: "layer", required: true },
    { id: "distance", label: "Distance (m)", type: "number", default: 100 },
  ],
  run: (ctx) => {
    // TODO(v0.5): Buffer via Python sidecar or Turf.js
    ctx.log("Not implemented — buffer planned for v0.5 (Python sidecar)");
  },
};

export const reprojectPlaceholder: ProcessingAlgorithm = {
  id: "reproject",
  name: "Reproject",
  description: "Reproject layer to another CRS",
  parameters: [
    { id: "layer", label: "Layer", type: "layer", required: true },
    { id: "crs", label: "Target CRS", type: "string", default: "EPSG:4326" },
  ],
  run: (ctx) => {
    // TODO(v0.5): Reproject via GDAL in Python sidecar
    ctx.log("Not implemented — reproject planned for v0.5 (GDAL sidecar)");
  },
};

export const ALGORITHMS: ProcessingAlgorithm[] = [
  calculateBoundsAlgorithm,
  countFeaturesAlgorithm,
  exportGeoJsonPlaceholder,
  bufferPlaceholder,
  reprojectPlaceholder,
];

export function getAlgorithm(id: string): ProcessingAlgorithm | undefined {
  return ALGORITHMS.find((a) => a.id === id);
}
