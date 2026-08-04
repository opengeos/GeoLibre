import assert from "node:assert/strict";
import { describe, it } from "node:test";
import geohash from "ngeohash";
import {
  DEFAULT_GEOHASH_GRID_SETTINGS,
  GEOHASH_CHILDREN_PER_CELL,
  GEOHASH_VIEWPORT_CELL_LIMIT,
  MAX_GEOHASH_PRECISION,
  MIN_GEOHASH_PRECISION,
  geohashCellFeature,
  geohashGridForBounds,
  geohashLabelMinZoom,
  geohashNeighborCells,
  geohashParentCell,
  geohashResolutionForZoom,
  normalizeGeohashGridSettings,
} from "../packages/plugins/src/plugins/maplibre-geohash";

describe("Geohash plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeGeohashGridSettings(undefined), DEFAULT_GEOHASH_GRID_SETTINGS);
    assert.deepEqual(
      normalizeGeohashGridSettings({
        autoResolution: false,
        resolution: 99,
        fillColor: "#ABCDEF",
        fillOpacity: -1,
        lineColor: "bad",
        lineWidth: 100,
        showLabels: false,
        includeNeighbors: true,
        includeParent: true,
      }),
      {
        autoResolution: false,
        resolution: MAX_GEOHASH_PRECISION,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_GEOHASH_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParent: true,
      },
    );
    assert.equal(normalizeGeohashGridSettings({ resolution: 0 }).resolution, MIN_GEOHASH_PRECISION);
  });

  it("maps map zoom to a precision like vgrid-maplibre", () => {
    // floor(zoom * 0.45), clamped to [1, 12].
    assert.equal(geohashResolutionForZoom(0), 1);
    assert.equal(geohashResolutionForZoom(2), 1);
    assert.equal(geohashResolutionForZoom(5), 2);
    assert.equal(geohashResolutionForZoom(10), 4);
    assert.equal(geohashResolutionForZoom(20), 9);
    assert.equal(geohashResolutionForZoom(30), 12);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(geohashLabelMinZoom(1), 2);
    assert.equal(geohashLabelMinZoom(4), 8);
    assert.equal(geohashLabelMinZoom(12), 22);
  });

  it("fills a bounding box with cells and creates export-ready features", () => {
    const grid = geohashGridForBounds([-122.52, 37.7, -122.35, 37.82], 5);
    assert.ok(grid.features.length > 0);
    const ids = grid.features.map((feature) => feature.properties?.geohash as string);
    assert.equal(new Set(ids).size, ids.length);

    const feature = geohashCellFeature(ids[0]);
    assert.equal(feature.geometry.type, "Polygon");
    const ring = feature.geometry.coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(feature.properties?.resolution, 5);

    // The clicked point's cell must be part of the viewport fill.
    const clicked = geohash.encode(37.76, -122.43, 5);
    assert.ok(ids.includes(clicked));

    const epsilon = 1e-9;
    const covers = (lat: number, lng: number) =>
      grid.features.some((f) => {
        const [w, s] = f.geometry.coordinates[0][0];
        const [e, n] = f.geometry.coordinates[0][2];
        return lng >= w - epsilon && lng <= e + epsilon && lat >= s - epsilon && lat <= n + epsilon;
      });
    assert.ok(covers(37.7, -122.52));
    assert.ok(covers(37.82, -122.35));
  });

  it("fills bounds at every precision cheaply enough to render", () => {
    for (let precision = MIN_GEOHASH_PRECISION; precision <= MAX_GEOHASH_PRECISION; precision++) {
      const [south, west, north, east] = geohash.decode_bbox(
        geohash.encode(10.78, 106.7, precision),
      );
      const w = east - west;
      const h = north - south;
      // A ~7×7-cell viewport around the point; at precision 1 the 45° cells
      // reach the poles, so the fill is clipped and returns fewer features.
      const grid = geohashGridForBounds(
        [106.7 - 3 * w, 10.78 - 3 * h, 106.7 + 3 * w, 10.78 + 3 * h],
        precision,
      );
      assert.ok(grid.features.length >= 16, `precision ${precision}: ${grid.features.length}`);
      for (const feature of grid.features) {
        assert.equal(feature.properties?.resolution, precision);
      }
    }
  });

  it("draws antimeridian-crossing viewports in the correct world copy", () => {
    // MapLibre reports continuous bounds (east past 180) across the dateline.
    const grid = geohashGridForBounds([179.3, -0.3, 180.7, 0.3], 3);
    assert.ok(grid.features.length > 0);
    const easternIds = new Set<string>();
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      // Rings stay contiguous and inside the viewport's continuous range.
      assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
      assert.ok(Math.min(...lons) >= 178 && Math.max(...lons) <= 182);
      if (Math.max(...lons) > 180) easternIds.add(feature.properties?.geohash as string);
    }
    // Cells past the dateline carry the IDs of their normalized twins.
    assert.ok(easternIds.has(geohash.encode(0.5, -179.5, 3)));
  });

  it("rejects viewports that would exceed the cell limit", () => {
    assert.throws(
      () => geohashGridForBounds([-180, -85, 180, 85], 6, GEOHASH_VIEWPORT_CELL_LIMIT),
      RangeError,
    );
  });

  it("finds the single parent and neighbors of a cell", () => {
    const cell = geohash.encode(10.78, 106.7, 6);
    assert.equal(geohashParentCell(cell), cell.slice(0, -1));
    assert.equal(geohashParentCell(geohash.encode(10.78, 106.7, 1)), null);

    const neighbors = geohashNeighborCells(cell);
    assert.ok(neighbors.includes(cell));
    assert.equal(neighbors.length, 9);
    for (const neighbor of neighbors) {
      assert.equal(neighbor.length, 6);
    }
    // Every cell subdivides into 32 children.
    assert.equal(GEOHASH_CHILDREN_PER_CELL, 32);
  });
});
