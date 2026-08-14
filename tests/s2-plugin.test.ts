import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_S2_GRID_SETTINGS,
  S2_VIEWPORT_CELL_LIMIT,
  normalizeS2GridSettings,
  s2CellFeature,
  s2GridForBounds,
  s2LabelMinZoom,
  s2LevelForZoom,
} from "../packages/plugins/src/plugins/maplibre-s2";

describe("S2 grid plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeS2GridSettings(undefined), DEFAULT_S2_GRID_SETTINGS);
    assert.deepEqual(
      normalizeS2GridSettings({
        autoResolution: true,
        resolution: 99,
        fillColor: "#ABCDEF",
        fillOpacity: -1,
        lineColor: "bad",
        lineWidth: 100,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
      }),
      {
        autoResolution: true,
        resolution: 30,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_S2_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
      },
    );
  });

  it("maps map zoom to an S2 level like vgrid-maplibre", () => {
    assert.equal(s2LevelForZoom(-1), 0);
    assert.equal(s2LevelForZoom(0.9), 0);
    assert.equal(s2LevelForZoom(4), 4);
    assert.equal(s2LevelForZoom(11.7), 11);
    assert.equal(s2LevelForZoom(31), 30);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(s2LabelMinZoom(0), 2);
    assert.equal(s2LabelMinZoom(4), 5);
    assert.equal(s2LabelMinZoom(12), 13);
    assert.equal(s2LabelMinZoom(30), 18);
  });

  it("creates export-ready polygon features", () => {
    const grid = s2GridForBounds([-122.52, 37.7, -122.35, 37.82], 12);
    const cell = grid.features[0].properties?.s2 as string;
    const feature = s2CellFeature(cell);
    assert.equal(feature.geometry.type, "Polygon");
    assert.equal(feature.properties?.s2, cell);
    assert.equal(feature.properties?.resolution, 12);
    // Closed quadrilateral ring: 4 corners plus the repeated first vertex.
    assert.equal(feature.geometry.coordinates[0].length, 5);
    assert.deepEqual(feature.geometry.coordinates[0][0], feature.geometry.coordinates[0][4]);
  });

  it("fills a viewport with unique cells at the requested level", () => {
    const grid = s2GridForBounds([-122.52, 37.7, -122.35, 37.82], 12);
    assert.ok(grid.features.length > 0);
    assert.ok(grid.features.length < S2_VIEWPORT_CELL_LIMIT);
    assert.ok(grid.features.every((feature) => feature.properties?.resolution === 12));
    assert.equal(
      new Set(grid.features.map((feature) => feature.properties?.s2)).size,
      grid.features.length,
    );
  });

  it("covers full-world bounds", () => {
    const grid = s2GridForBounds([-180, -85, 180, 85], 3);
    // Level 3 tiles the globe with 6 * 4^3 = 384 cells; the covering keeps
    // every cell that intersects the ±85° band.
    assert.ok(grid.features.length >= 380, `got ${grid.features.length}`);
    assert.ok(grid.features.length <= 384);
  });

  it("keeps antimeridian-crossing rings contiguous", () => {
    const grid = s2GridForBounds([170, 50, 190, 65], 7);
    assert.ok(grid.features.length > 0);
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      assert.ok(Math.max(...lons) - Math.min(...lons) < 90, `ring spans ${lons.join(", ")}`);
    }
  });

  it("rejects oversized grids before materializing them", () => {
    assert.throws(() => s2GridForBounds([-180, -80, 180, 80], 8), /cell limit exceeded/i);
  });
});
