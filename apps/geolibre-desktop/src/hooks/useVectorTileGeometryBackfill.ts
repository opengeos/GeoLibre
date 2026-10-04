/**
 * Backfills attributes derived from loaded features for vector-tile layers.
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
import { sourceId, mapboxSourceId } from "@geolibre/map/style-layer-ids";
import type { Feature } from "geojson";
import type { MapEngine } from "@geolibre/map";
import { useEffect } from "react";
import type { createAppAPI } from "./usePlugins";

/** Read-only tile query shared by MapLibre and Mapbox. */
interface TileFeatureMap {
  querySourceFeatures(sourceId: string, options?: { sourceLayer?: string }): Feature[];
  /** Present on both GL maps; optional so a bare query stub still type-checks. */
  getSource?(sourceId: string): unknown;
  on(event: "idle", listener: () => void): unknown;
  off(event: "idle", listener: () => void): unknown;
}

/** Select the native tile-query map without treating Mapbox as MapLibre. */
export function vectorTileMap(engine: MapEngine | null | undefined): TileFeatureMap | null {
  const map = engine?.getMap();
  if (map) return map;
  // eslint-disable-next-line local/no-renderer-kind-checks -- reaches the Mapbox engine's own map handle
  return engine?.kind === "mapbox" &&
    "getMapboxMap" in engine &&
    typeof engine.getMapboxMap === "function"
    ? engine.getMapboxMap()
    : null;
}

/** Layer types drawn from vector tiles (no local features to inspect). */
const VECTOR_TILE_TYPES = new Set<GeoLibreLayer["type"]>(["vector-tiles", "pmtiles", "mbtiles"]);

function sourceLayerOf(layer: GeoLibreLayer): string | undefined {
  const fromSource = layer.source.sourceLayer;
  if (typeof fromSource === "string" && fromSource) return fromSource;
  const fromMeta = layer.metadata.sourceLayers;
  if (Array.isArray(fromMeta) && typeof fromMeta[0] === "string") return fromMeta[0];
  return undefined;
}

/**
 * The id of the native source a layer's tiles load into on the live map.
 *
 * MapLibre adopts a control-owned source named on the record. Mapbox compiles
 * a record into its own `geolibre-mapbox-<id>` source, except the rows a
 * plugin control draws itself (Overture Maps' `overture-<theme>` archives),
 * which the engine never compiles: when the map carries the source the record
 * names, the control put it there and that is where the tiles are.
 *
 * @param map - The live map, asked whether the record's own source exists.
 * @param layer - The vector-tile layer.
 * @param renderer - The primary renderer's kind.
 * @returns The source id to query.
 */
function liveSourceId(
  map: Pick<TileFeatureMap, "getSource">,
  layer: GeoLibreLayer,
  renderer: string,
): string {
  const externalSourceId = layer.source.sourceId;
  const external =
    typeof externalSourceId === "string" && externalSourceId ? externalSourceId : null;
  // eslint-disable-next-line local/no-renderer-kind-checks -- each engine names its sources its own way
  if (renderer === "mapbox") {
    return external && map.getSource?.(external) ? external : mapboxSourceId(layer.id);
  }
  return external ?? sourceId(layer.id);
}

/**
 * Whether a layer draws from vector tiles, and so carries no local features:
 * anything read from it has to come from the tiles currently loaded.
 *
 * @param layer - The layer to test.
 * @returns `true` for vector-tile, PMTiles, and MBTiles layers.
 */
export function isVectorTileLayer(layer: GeoLibreLayer): boolean {
  return VECTOR_TILE_TYPES.has(layer.type);
}

/** A bounded sample of features currently loaded for a vector-tile layer. */
export function loadedVectorTileFeatures(
  map: Pick<TileFeatureMap, "querySourceFeatures" | "getSource">,
  layer: GeoLibreLayer,
  renderer: string = "maplibre",
): Feature[] {
  const sourceLayer = sourceLayerOf(layer);
  try {
    return map
      .querySourceFeatures(
        liveSourceId(map, layer, renderer),
        sourceLayer ? { sourceLayer } : undefined,
      )
      .slice(0, 400);
  } catch {
    return []; // source not added yet
  }
}

/** The dominant geometry kind among sampled tile features, or null. */
function dominantGeometry(features: Feature[]): "point" | "line" | "polygon" | null {
  if (!features || features.length === 0) return null;
  let polygon = 0;
  let line = 0;
  let point = 0;
  for (const feature of features) {
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

/** Sorted attribute names present in sampled tile features. */
function attributeFields(features: Feature[]): string[] {
  const fields = new Set<string>();
  for (const feature of features) {
    for (const field of Object.keys(feature.properties ?? {})) fields.add(field);
  }
  return Array.from(fields).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/**
 * Whether a vector-tile layer still lacks its geometry type or attribute fields.
 *
 * @param layer - The layer to check.
 * @returns `true` when the layer is a vector-tile layer awaiting a backfill.
 */
function needsGeometryBackfill(layer: GeoLibreLayer): boolean {
  return (
    VECTOR_TILE_TYPES.has(layer.type) &&
    (typeof layer.metadata.geometryType !== "string" ||
      !Array.isArray(layer.metadata.fields) ||
      layer.metadata.fields.length === 0)
  );
}

/**
 * The ids and sources of the layers awaiting a backfill, joined into one
 * comparable string.
 *
 * @param layers - The store's layers.
 * @returns A newline-joined id list; empty when nothing is pending.
 */
function backfillPendingKey(layers: readonly GeoLibreLayer[]): string {
  let key = "";
  for (const layer of layers) {
    // The source is part of the key: swapping a pending layer's source (same
    // id, metadata still missing) must re-attach and backfill the new one.
    if (needsGeometryBackfill(layer)) {
      key += `${JSON.stringify([layer.id, layer.source, layer.metadata.sourceLayers])}\n`;
    }
  }
  return key;
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
  // Subscribe to the ids still awaiting a backfill (a string, so it compares by
  // value), not the whole `layers` array: the host (TopToolbar) would otherwise
  // re-render on every edit of any layer. The effect only needs to re-attach
  // when that set changes.
  const pendingKey = useAppStore((state) => backfillPendingKey(state.layers));

  useEffect(() => {
    const map = app.getMap?.() ?? app.getMapboxMap?.();
    if (!map) return;

    const needsBackfill = () => useAppStore.getState().layers.filter(needsGeometryBackfill);

    if (needsBackfill().length === 0) return;

    const backfill = (): void => {
      for (const layer of needsBackfill()) {
        const features = loadedVectorTileFeatures(map, layer, app.getMapRenderer?.());
        if (features.length === 0) continue;
        const geometryType = dominantGeometry(features);
        const fields = attributeFields(features);
        const current = useAppStore.getState().layers.find((l) => l.id === layer.id);
        if (current) {
          const metadata = { ...current.metadata };
          let changed = false;
          if (geometryType && typeof metadata.geometryType !== "string") {
            metadata.geometryType = geometryType;
            changed = true;
          }
          if (
            (!Array.isArray(metadata.fields) || metadata.fields.length === 0) &&
            fields.length > 0
          ) {
            metadata.fields = fields;
            changed = true;
          }
          if (!changed) continue;
          useAppStore.getState().updateLayer(layer.id, { metadata });
        }
      }
    };

    // Try now (tiles may already be loaded) and again whenever the map settles.
    backfill();
    map.on("idle", backfill);
    return () => {
      map.off("idle", backfill);
    };
  }, [app, pendingKey, mapReadyGeneration]);
}
