import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  A5_VIEWPORT_CELL_LIMIT,
  DEFAULT_A5_GRID_SETTINGS,
  a5CellFeature,
  a5GridForBounds,
  a5LabelMinZoom,
  a5ResolutionForZoom,
  normalizeA5GridSettings,
} from "../packages/plugins/src/plugins/maplibre-a5";

describe("A5 grid plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeA5GridSettings(undefined), DEFAULT_A5_GRID_SETTINGS);
    assert.deepEqual(
      normalizeA5GridSettings({
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
        lineColor: DEFAULT_A5_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
      },
    );
  });

  it("maps map zoom to an A5 resolution like vgrid-maplibre", () => {
    assert.equal(a5ResolutionForZoom(-1), 0);
    assert.equal(a5ResolutionForZoom(0.9), 0);
    assert.equal(a5ResolutionForZoom(4), 4);
    assert.equal(a5ResolutionForZoom(11.7), 11);
    assert.equal(a5ResolutionForZoom(31), 30);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(a5LabelMinZoom(0), 2);
    assert.equal(a5LabelMinZoom(4), 5);
    assert.equal(a5LabelMinZoom(12), 13);
    assert.equal(a5LabelMinZoom(30), 18);
  });

  it("creates export-ready polygon features", () => {
    // Derive a valid cell through the plugin's own fill rather than importing
    // a5-js here: the test would resolve the repo root's older hoisted copy
    // (deck.gl pins ^0.7), not the 0.9 the plugin uses.
    const grid = a5GridForBounds([-122.52, 37.7, -122.35, 37.82], 12);
    const cell = grid.features[0].properties?.a5 as string;
    const feature = a5CellFeature(cell);
    assert.equal(feature.geometry.type, "Polygon");
    assert.equal(feature.properties?.a5, cell);
    assert.equal(feature.properties?.resolution, 12);
    assert.equal(feature.geometry.coordinates[0][0].length, 2);
    // Closed ring: the last vertex repeats the first.
    const ring = feature.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
  });

  it("keeps antimeridian-crossing rings contiguous", () => {
    const grid = a5GridForBounds([170, 50, 190, 65], 7);
    assert.ok(grid.features.length > 0);
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      assert.ok(Math.max(...lons) - Math.min(...lons) < 90, `ring spans ${lons.join(", ")}`);
    }
  });

  it("fills a viewport with unique cells at the requested resolution", () => {
    const grid = a5GridForBounds([-122.52, 37.7, -122.35, 37.82], 12);
    assert.ok(grid.features.length > 0);
    assert.ok(grid.features.length < A5_VIEWPORT_CELL_LIMIT);
    assert.ok(grid.features.every((feature) => feature.properties?.resolution === 12));
    assert.equal(
      new Set(grid.features.map((feature) => feature.properties?.a5)).size,
      grid.features.length,
    );
  });

  it("covers full-world bounds", () => {
    const grid = a5GridForBounds([-180, -85, 180, 85], 4);
    // Resolution 4 has 3,840 cells globally; nearly all centers sit inside ±85°.
    assert.ok(grid.features.length > 3_700);
    assert.ok(grid.features.length < A5_VIEWPORT_CELL_LIMIT);
  });

  it("covers hemisphere-scale bounds without losing interior cells", () => {
    // Large polygons degrade polygonToCells, so views this size take the
    // enumerate-and-filter path; half the globe holds ~1,900 resolution-4 cells.
    const grid = a5GridForBounds([-180, -85, 0, 85], 4);
    assert.ok(grid.features.length > 1_800);
    assert.ok(grid.features.length < 2_000);
  });

  it("rejects oversized grids before materializing them", () => {
    assert.throws(() => a5GridForBounds([-180, -80, 180, 80], 8), /cell limit exceeded/i);
  });
});
