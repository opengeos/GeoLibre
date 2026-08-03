import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TILECODE_GRID_SETTINGS,
  MAX_TILECODE_ZOOM,
  MIN_TILECODE_ZOOM,
  TILECODE_VIEWPORT_CELL_LIMIT,
  normalizeTilecodeGridSettings,
  pointToTile,
  tilecodeCellFeature,
  tilecodeGridForBounds,
  tilecodeLabelMinZoom,
  tilecodeNeighborCells,
  tilecodeParentCell,
  tilecodeResolutionForZoom,
  tilecodeToTile,
  tileToQuadkey,
  tileToTilecode,
} from "../packages/plugins/src/plugins/maplibre-tilecode";

describe("Tilecode plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeTilecodeGridSettings(undefined), DEFAULT_TILECODE_GRID_SETTINGS);
    assert.deepEqual(
      normalizeTilecodeGridSettings({
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
        resolution: MAX_TILECODE_ZOOM,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_TILECODE_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParent: true,
      },
    );
    assert.equal(normalizeTilecodeGridSettings({ resolution: -5 }).resolution, MIN_TILECODE_ZOOM);
  });

  it("converts between tiles, tilecodes, and quadkeys", () => {
    assert.equal(tileToTilecode([203, 112, 8]), "z8x203y112");
    assert.deepEqual(tilecodeToTile("z8x203y112"), [203, 112, 8]);
    assert.equal(tilecodeToTile("nonsense"), null);
    // Out-of-range x for the zoom level.
    assert.equal(tilecodeToTile("z2x9y0"), null);
    // Quadkey digits interleave the x/y bits; the z0 root is the empty key.
    assert.equal(tileToQuadkey([203, 112, 8]), "13221011");
    assert.equal(tileToQuadkey([0, 0, 0]), "");
    // Round-trip through a point: encode then decode covers the same box.
    const tile = pointToTile(10.78, 106.7, 12);
    assert.equal(tile[2], 12);
    const feature = tilecodeCellFeature(tileToTilecode(tile));
    const [w, s] = feature.geometry.coordinates[0][0];
    const [e, n] = feature.geometry.coordinates[0][2];
    assert.ok(w <= 106.7 && 106.7 <= e);
    assert.ok(s <= 10.78 && 10.78 <= n);
  });

  it("maps map zoom to a tile zoom like vgrid-maplibre", () => {
    // floor(zoom) + 1, clamped.
    assert.equal(tilecodeResolutionForZoom(0), 1);
    assert.equal(tilecodeResolutionForZoom(7.9), 8);
    assert.equal(tilecodeResolutionForZoom(12.2), 13);
    assert.equal(tilecodeResolutionForZoom(99), MAX_TILECODE_ZOOM);
    assert.equal(tilecodeResolutionForZoom(-5), MIN_TILECODE_ZOOM);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(tilecodeLabelMinZoom(0), 2);
    assert.equal(tilecodeLabelMinZoom(8), 7);
    assert.equal(tilecodeLabelMinZoom(26), 24);
  });

  it("fills a bounding box with tiles and creates export-ready features", () => {
    const grid = tilecodeGridForBounds([-122.52, 37.7, -122.35, 37.82], 12);
    assert.ok(grid.features.length > 0);
    const ids = grid.features.map((feature) => feature.properties?.tilecode as string);
    assert.equal(new Set(ids).size, ids.length);

    const feature = grid.features[0];
    assert.equal(feature.geometry.type, "Polygon");
    const ring = feature.geometry.coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(feature.properties?.resolution, 12);
    assert.equal(
      feature.properties?.quadkey,
      tileToQuadkey(tilecodeToTile(feature.properties?.tilecode as string)!),
    );

    // The clicked point's tile must be part of the viewport fill.
    const clicked = tileToTilecode(pointToTile(37.76, -122.43, 12));
    assert.ok(ids.includes(clicked));

    // Tiles cover the whole viewport including its corners.
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

  it("draws antimeridian-crossing viewports in the correct world copy", () => {
    // MapLibre reports continuous bounds (east past 180) across the dateline.
    const grid = tilecodeGridForBounds([179.3, -0.3, 180.7, 0.3], 8);
    assert.ok(grid.features.length > 0);
    const easternIds = new Set<string>();
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      // Rings stay contiguous and inside the viewport's continuous range.
      assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
      assert.ok(Math.min(...lons) >= 178 && Math.max(...lons) <= 182);
      if (Math.max(...lons) > 180) {
        easternIds.add(feature.properties?.tilecode as string);
      }
    }
    // Tiles past the dateline carry the IDs of their normalized twins (x=0).
    assert.ok(easternIds.has(tileToTilecode(pointToTile(0.1, -179.9, 8))));
  });

  it("rejects viewports that would exceed the tile limit", () => {
    assert.throws(
      () => tilecodeGridForBounds([-180, -85, 180, 85], 12, TILECODE_VIEWPORT_CELL_LIMIT),
      RangeError,
    );
  });

  it("finds the single parent and neighbors of a tile", () => {
    assert.equal(tilecodeParentCell("z8x203y112"), "z7x101y56");
    assert.equal(tilecodeParentCell("z0x0y0"), null);

    const neighbors = tilecodeNeighborCells("z8x203y112");
    assert.equal(neighbors.length, 9);
    assert.ok(neighbors.includes("z8x203y112"));
    // The x axis wraps around the world…
    const wrapped = tilecodeNeighborCells("z4x0y7");
    assert.ok(wrapped.includes("z4x15y7"));
    // …but the y axis clips at the top row (no tiles beyond the mercator cap).
    const topRow = tilecodeNeighborCells("z4x7y0");
    assert.equal(topRow.length, 6);
  });
});
