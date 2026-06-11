// Must precede the @osmix imports: it aliases SharedArrayBuffer to ArrayBuffer
// before @osmix/core reads it at module-load time.
import "./osm-shared-array-buffer-shim";
import { Osm } from "@osmix/core";
import { osmEntityToGeoJSONFeature } from "@osmix/geojson";
import { readOsmPbf } from "@osmix/pbf";
import type { Feature, FeatureCollection, Geometry } from "geojson";

/**
 * The three GeoJSON layers an OSM PBF file is split into, by geometry type.
 * OSM mixes points, lines, and areas in one file, and MapLibre styles each
 * geometry type differently, so we surface them as separate layers.
 */
export interface OsmPbfLayers {
  points: FeatureCollection;
  lines: FeatureCollection;
  polygons: FeatureCollection;
  /** Combined [minLng, minLat, maxLng, maxLat] of all features, or null if empty. */
  bounds: [number, number, number, number] | null;
  counts: {
    nodes: number;
    ways: number;
    relations: number;
    points: number;
    lines: number;
    polygons: number;
    skipped: number;
  };
}

type MutableBounds = [number, number, number, number];

function extendBounds(bounds: MutableBounds, geometry: Geometry | null): void {
  if (!geometry || geometry.type === "GeometryCollection") return;
  const walk = (coords: unknown): void => {
    if (
      Array.isArray(coords) &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      const [x, y] = coords as [number, number];
      if (x < bounds[0]) bounds[0] = x;
      if (y < bounds[1]) bounds[1] = y;
      if (x > bounds[2]) bounds[2] = x;
      if (y > bounds[3]) bounds[3] = y;
      return;
    }
    if (Array.isArray(coords)) for (const part of coords) walk(part);
  };
  walk((geometry as { coordinates?: unknown }).coordinates);
}

function hasTags(tags: Record<string, unknown> | undefined): boolean {
  return tags != null && Object.keys(tags).length > 0;
}

/**
 * Parse OSM PBF bytes into an in-memory Osm index.
 *
 * This mirrors osmix's own `fromPbf` block loop (string-table mapping, dense
 * nodes, then ways, then relations, then index building) but pulls in only
 * `@osmix/core` and `@osmix/pbf` — not the full `osmix` meta-package, which
 * re-exports unrelated raster/router/gtfs modules. Spatial indexes are skipped:
 * GeoJSON conversion only needs the ID indexes for ref/member lookups.
 */
async function buildOsmFromPbf(bytes: Uint8Array): Promise<Osm> {
  const { header, blocks } = await readOsmPbf(bytes);
  const osm = new Osm({ header });

  for await (const block of blocks) {
    const blockStringIndexMap = osm.stringTable.createBlockIndexMap(
      block.stringtable,
    );
    for (const group of block.primitivegroup) {
      const { ways, relations, dense } = group;
      if (dense) {
        osm.nodes.addDenseNodes(dense, block, blockStringIndexMap);
      }
      if (ways.length > 0) {
        if (!osm.nodes.isReady()) osm.nodes.buildIndex();
        osm.ways.addWays(ways, blockStringIndexMap);
      }
      if (relations.length > 0) {
        if (!osm.ways.isReady()) osm.ways.buildIndex();
        osm.relations.addRelations(relations, blockStringIndexMap);
      }
    }
  }

  osm.buildIndexes();
  return osm;
}

function geometryBucket(
  geometry: Geometry | null,
): "points" | "lines" | "polygons" | null {
  switch (geometry?.type) {
    case "Point":
    case "MultiPoint":
      return "points";
    case "LineString":
    case "MultiLineString":
      return "lines";
    case "Polygon":
    case "MultiPolygon":
      return "polygons";
    default:
      // GeometryCollection (some relations) and null geometries are skipped.
      return null;
  }
}

/**
 * Parse OSM PBF bytes into GeoJSON layers split by geometry type.
 *
 * Only tagged nodes become point features — the vast majority of OSM nodes are
 * untagged geometry vertices for ways and would otherwise flood the points
 * layer. Ways and relations are always converted (they are meaningful features).
 *
 * The entity-classification loop runs without yielding and can be heavy for
 * large extracts (the PBF read above is async, but this part is not), so call
 * it from a worker.
 */
export async function parseOsmPbf(bytes: Uint8Array): Promise<OsmPbfLayers> {
  const osm = await buildOsmFromPbf(bytes);

  const points: Feature[] = [];
  const lines: Feature[] = [];
  const polygons: Feature[] = [];
  let skipped = 0;
  const bounds: MutableBounds = [Infinity, Infinity, -Infinity, -Infinity];

  // Defensive: osmEntityToGeoJSONFeature is typed non-null, but guard against a
  // null/undefined result (e.g. an entity whose geometry cannot be resolved)
  // rather than dereferencing .geometry and aborting the whole parse.
  const place = (feature: Feature | null | undefined) => {
    const bucket = feature ? geometryBucket(feature.geometry) : null;
    if (!feature || bucket === null) {
      skipped += 1;
      return;
    }
    if (bucket === "points") points.push(feature);
    else if (bucket === "lines") lines.push(feature);
    else polygons.push(feature);
    extendBounds(bounds, feature.geometry);
  };

  for (const node of osm.nodes) {
    if (!hasTags(node.tags)) continue;
    place(osmEntityToGeoJSONFeature(osm, node) as Feature | null);
  }
  for (const way of osm.ways) {
    place(osmEntityToGeoJSONFeature(osm, way) as Feature | null);
  }
  for (const relation of osm.relations) {
    place(osmEntityToGeoJSONFeature(osm, relation) as Feature | null);
  }

  return {
    points: { type: "FeatureCollection", features: points },
    lines: { type: "FeatureCollection", features: lines },
    polygons: { type: "FeatureCollection", features: polygons },
    bounds: Number.isFinite(bounds[0])
      ? [bounds[0], bounds[1], bounds[2], bounds[3]]
      : null,
    counts: {
      nodes: osm.nodes.size,
      ways: osm.ways.size,
      relations: osm.relations.size,
      points: points.length,
      lines: lines.length,
      polygons: polygons.length,
      skipped,
    },
  };
}
