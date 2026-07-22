/**
 * Backfills `metadata.geometryType` for vector-tile layers that don't carry it.
 *
 * A vector-tile layer has no local features, so its geometry (point / line /
 * polygon) is only known if a source set the hint — the GeoLens plugin does for
 * new layers, but layers restored from an older saved project, or added by
 * sources that don't record it, arrive with none. Without it the Layers-panel
 * swatch and the legend fall back to a neutral square for everything.
 *
 * This reads the geometry straight from the rendered tiles: once tiles settle,
 * `querySourceFeatures` reports the actual geometry types, and the dominant one
 * is written back to the store (once, idempotently). It self-heals on `idle`,
 * so a layer whose tiles load after a pan/zoom is picked up too.
 */
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { sourceId } from "@geolibre/map";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect } from "react";
import type { createAppAPI } from "./usePlugins";

/** Layer types drawn from vector tiles (no local features to inspect). */
const VECTOR_TILE_TYPES = new Set<GeoLibreLayer["type"]>(["vector-tiles", "pmtiles", "mbtiles"]);

function sourceLayerOf(layer: GeoLibreLayer): string | undefined {
  const fromSource = layer.source.sourceLayer;
  if (typeof fromSource === "string" && fromSource) return fromSource;
  const fromMeta = layer.metadata.sourceLayers;
  if (Array.isArray(fromMeta) && typeof fromMeta[0] === "string") return fromMeta[0];
  return undefined;
}

/** The dominant geometry kind among a layer's loaded tile features, or null. */
function dominantGeometry(
  map: MapLibreMap,
  layer: GeoLibreLayer,
): "point" | "line" | "polygon" | null {
  const sourceLayer = sourceLayerOf(layer);
  let features;
  try {
    features = map.querySourceFeatures(
      sourceId(layer.id),
      sourceLayer ? { sourceLayer } : undefined,
    );
  } catch {
    return null; // source not added yet
  }
  if (!features || features.length === 0) return null;
  let polygon = 0;
  let line = 0;
  let point = 0;
  for (const feature of features.slice(0, 400)) {
    const type = feature.geometry?.type ?? "";
    if (type.includes("Polygon")) polygon++;
    else if (type.includes("LineString")) line++;
    else if (type.includes("Point")) point++;
  }
  if (polygon === 0 && line === 0 && point === 0) return null;
  // Prefer the highest-dimension geometry present (polygon > line > point).
  if (polygon >= line && polygon >= point) return "polygon";
  if (line >= point) return "line";
  return "point";
}

/**
 * Keep vector-tile layers' `metadata.geometryType` populated from their tiles.
 *
 * @param app - The host app API (stably memoized by the caller).
 * @param mapReadyGeneration - Bumped when the map (re)initializes; a dependency
 *   so the effect re-runs once `app.getMap()` is available (an early mount
 *   before map init returns before attaching the `idle` listener).
 */
export function useVectorTileGeometryBackfill(
  app: ReturnType<typeof createAppAPI>,
  mapReadyGeneration: number,
): void {
  const layers = useAppStore((state) => state.layers);

  useEffect(() => {
    const map = app.getMap?.();
    if (!map) return;

    const needsGeometry = () =>
      useAppStore
        .getState()
        .layers.filter(
          (layer) =>
            VECTOR_TILE_TYPES.has(layer.type) && typeof layer.metadata.geometryType !== "string",
        );

    if (needsGeometry().length === 0) return;

    const backfill = (): void => {
      for (const layer of needsGeometry()) {
        const geometryType = dominantGeometry(map, layer);
        if (!geometryType) continue;
        const current = useAppStore.getState().layers.find((l) => l.id === layer.id);
        if (current && typeof current.metadata.geometryType !== "string") {
          useAppStore
            .getState()
            .updateLayer(layer.id, { metadata: { ...current.metadata, geometryType } });
        }
      }
    };

    // Try now (tiles may already be loaded) and again whenever the map settles.
    backfill();
    map.on("idle", backfill);
    return () => {
      map.off("idle", backfill);
    };
  }, [app, layers, mapReadyGeneration]);
}
