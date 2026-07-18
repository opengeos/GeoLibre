import bbox from "@turf/bbox";
import type { GeoLibreLayer } from "@geolibre/core";
import type { ProcessingAlgorithm, ProcessingContext } from "./types";

function getLayer(ctx: ProcessingContext, paramId = "layer"): GeoLibreLayer | undefined {
  const layerId = ctx.parameters[paramId] as string | undefined;
  return ctx.layers.find((l) => l.id === layerId);
}

export const calculateBoundsAlgorithm: ProcessingAlgorithm = {
  id: "calculate-bounds",
  name: "Calculate layer bounds",
  description: "Compute the bounding box of a GeoJSON layer",
  parameters: [{ id: "layer", label: "Layer", type: "layer", required: true }],
  run: (ctx) => {
    const layer = getLayer(ctx);
    if (!layer?.geojson) {
      ctx.log("Error: layer has no GeoJSON data");
      return;
    }
    const bounds = bbox(layer.geojson) as [number, number, number, number];
    ctx.log(`Bounds: [${bounds.map((n) => n.toFixed(6)).join(", ")}]`);
    ctx.fitBounds?.(bounds);
  },
};

export const countFeaturesAlgorithm: ProcessingAlgorithm = {
  id: "count-features",
  name: "Count features",
  description: "Count features in a GeoJSON layer",
  parameters: [{ id: "layer", label: "Layer", type: "layer", required: true }],
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

export const ALGORITHMS: ProcessingAlgorithm[] = [calculateBoundsAlgorithm, countFeaturesAlgorithm];

export function getAlgorithm(id: string): ProcessingAlgorithm | undefined {
  return ALGORITHMS.find((a) => a.id === id);
}
