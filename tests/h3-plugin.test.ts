import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_H3_GRID_SETTINGS,
  H3_VIEWPORT_CELL_LIMIT,
  h3CellFeature,
  h3FixTransmeridianBoundary,
  h3GridForBounds,
  h3LabelMinZoom,
  h3ResolutionForZoom,
  normalizeH3GridSettings,
} from "../packages/plugins/src/plugins/maplibre-h3";

describe("H3 grid plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeH3GridSettings(undefined), DEFAULT_H3_GRID_SETTINGS);
    assert.deepEqual(
      normalizeH3GridSettings({
        autoResolution: true,
        resolution: 99,
        fillColor: "#ABCDEF",
        fillOpacity: -1,
        lineColor: "bad",
        lineWidth: 100,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
        showIcosahedron: true,
      }),
      {
        autoResolution: true,
        resolution: 15,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_H3_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
        showIcosahedron: true,
      },
    );
  });

  it("derives the automatic resolution from the map zoom (vgrid-maplibre rule)", () => {
    assert.equal(h3ResolutionForZoom(0), 0);
    assert.equal(h3ResolutionForZoom(3), 0);
    assert.equal(h3ResolutionForZoom(5), 1);
    assert.equal(h3ResolutionForZoom(10), 6);
    assert.equal(h3ResolutionForZoom(20), 15);
    assert.equal(h3ResolutionForZoom(30), 15);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(h3LabelMinZoom(0), 3);
    assert.equal(h3LabelMinZoom(2), 5);
    assert.equal(h3LabelMinZoom(7), 10);
    assert.equal(h3LabelMinZoom(15), 18);
  });

  it("creates export-ready polygon features", () => {
    const feature = h3CellFeature("872830828ffffff");
    assert.equal(feature.geometry.type, "Polygon");
    assert.equal(feature.properties?.h3, "872830828ffffff");
    assert.equal(feature.properties?.resolution, 7);
    assert.equal(feature.geometry.coordinates[0][0].length, 2);
  });

  it("fills a viewport with unique cells at the requested resolution", () => {
    const grid = h3GridForBounds([-122.52, 37.7, -122.35, 37.82], 7);
    assert.ok(grid.features.length > 0);
    assert.ok(grid.features.length < H3_VIEWPORT_CELL_LIMIT);
    assert.ok(grid.features.every((feature) => feature.properties?.resolution === 7));
    assert.equal(
      new Set(grid.features.map((feature) => feature.properties?.h3)).size,
      grid.features.length,
    );
  });

  it("supports antimeridian-crossing bounds", () => {
    const grid = h3GridForBounds([179.8, -0.2, -179.8, 0.2], 5);
    assert.ok(grid.features.length > 0);
    assert.ok(grid.features.length < 100);
  });

  it("keeps dateline cell boundaries contiguous instead of drawing across the world", () => {
    // vgrid-maplibre's fix: a straddling ring becomes one contiguous Polygon
    // around -180, with the eastern vertices shifted into the adjacent world
    // copy (longitudes just below -180) rather than clipped at the seam.
    const feature = h3CellFeature("824797fffffffff");
    assert.equal(feature.geometry.type, "Polygon");
    const ring = feature.geometry.coordinates[0];
    assert.ok(ring.length >= 4);
    assert.deepEqual(ring.at(0), ring.at(-1));
    const longitudes = ring.map(([longitude]) => longitude);
    assert.ok(Math.max(...longitudes) - Math.min(...longitudes) < 10);

    assert.deepEqual(
      h3FixTransmeridianBoundary([
        [179, 0],
        [-179, 1],
        [179, 0],
      ]),
      [
        [-181, 0],
        [-179, 1],
        [-181, 0],
      ],
    );
    // Rings away from the seam pass through untouched.
    const plain: [number, number][] = [
      [-122.5, 37.7],
      [-122.4, 37.8],
      [-122.5, 37.7],
    ];
    assert.deepEqual(h3FixTransmeridianBoundary(plain), plain);
  });

  it("does not collapse full-world bounds onto the antimeridian", () => {
    const grid = h3GridForBounds([-180, -85, 180, 85], 2);
    assert.ok(grid.features.length > 5_000);
    assert.ok(grid.features.length < H3_VIEWPORT_CELL_LIMIT);
  });

  it("rejects oversized grids before materializing them", () => {
    assert.throws(() => h3GridForBounds([-180, -80, 180, 80], 7), /cell limit exceeded/i);
  });
});
