import assert from "node:assert/strict";
import { describe, it } from "node:test";
import OpenLocationCodeModule from "open-location-code-typescript";

// Same CJS/ESM default-interop normalization the plugin performs.
const OpenLocationCode = ((OpenLocationCodeModule as { default?: unknown }).default ??
  OpenLocationCodeModule) as typeof OpenLocationCodeModule;
import {
  DEFAULT_OLC_GRID_SETTINGS,
  OLC_CODE_LENGTHS,
  OLC_VIEWPORT_CELL_LIMIT,
  olcCellFeature,
  olcChildCount,
  olcGridForBounds,
  olcLabelMinZoom,
  olcNeighborCells,
  olcParentCell,
  olcResolutionForZoom,
  normalizeOlcGridSettings,
} from "../packages/plugins/src/plugins/maplibre-olc";

describe("OLC plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeOlcGridSettings(undefined), DEFAULT_OLC_GRID_SETTINGS);
    assert.deepEqual(
      normalizeOlcGridSettings({
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
        resolution: 15,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_OLC_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParent: true,
      },
    );
    // Odd lengths are not valid full codes; snap to the nearest valid one.
    assert.equal(normalizeOlcGridSettings({ resolution: 9 }).resolution, 8);
    assert.equal(normalizeOlcGridSettings({ resolution: 3 }).resolution, 2);
  });

  it("maps map zoom to a code length like vgrid-maplibre", () => {
    assert.equal(olcResolutionForZoom(0), 2);
    assert.equal(olcResolutionForZoom(6), 2);
    assert.equal(olcResolutionForZoom(7), 4);
    assert.equal(olcResolutionForZoom(12), 6);
    assert.equal(olcResolutionForZoom(16), 8);
    assert.equal(olcResolutionForZoom(20), 10);
    assert.equal(olcResolutionForZoom(23), 11);
    assert.equal(olcResolutionForZoom(30), 15);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(olcLabelMinZoom(2), 2);
    assert.equal(olcLabelMinZoom(8), 13);
    assert.equal(olcLabelMinZoom(15), 24);
  });

  it("fills a bounding box with cells and creates export-ready features", () => {
    const grid = olcGridForBounds([-122.52, 37.7, -122.35, 37.82], 6);
    assert.ok(grid.features.length > 0);
    const ids = grid.features.map((feature) => feature.properties?.olc as string);
    assert.equal(new Set(ids).size, ids.length);

    const feature = olcCellFeature(ids[0]);
    assert.equal(feature.geometry.type, "Polygon");
    const ring = feature.geometry.coordinates[0];
    assert.equal(ring.length, 5);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(feature.properties?.resolution, 6);

    // The clicked point's cell must be part of the viewport fill.
    const clicked = OpenLocationCode.encode(37.76, -122.43, 6);
    assert.ok(ids.includes(clicked));
    // Cells cover the whole viewport including its corners (decode
    // reconstructs cell bounds with float jitter, hence the epsilon).
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

  it("fills bounds at every valid code length cheaply enough to render", () => {
    for (const length of OLC_CODE_LENGTHS) {
      // A viewport sized to the cells so the fill stays under the cap.
      const area = OpenLocationCode.decode(OpenLocationCode.encode(10.78, 106.7, length));
      const w = area.getLongitudeWidth();
      const h = area.getLatitudeHeight();
      const grid = olcGridForBounds(
        [106.7 - 3 * w, 10.78 - 3 * h, 106.7 + 3 * w, 10.78 + 3 * h],
        length,
      );
      assert.ok(grid.features.length >= 36, `length ${length}: ${grid.features.length}`);
      for (const feature of grid.features) {
        assert.equal(feature.properties?.resolution, length);
      }
    }
  });

  it("draws antimeridian-crossing viewports in the correct world copy", () => {
    // MapLibre reports continuous bounds (east past 180) across the dateline.
    const grid = olcGridForBounds([179.3, -0.3, 180.7, 0.3], 4);
    assert.ok(grid.features.length > 0);
    const easternIds = new Set<string>();
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      // Rings stay contiguous and inside the viewport's continuous range.
      assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
      assert.ok(Math.min(...lons) >= 178 && Math.max(...lons) <= 182);
      if (Math.max(...lons) > 180) easternIds.add(feature.properties?.olc as string);
    }
    // Cells past the dateline carry the IDs of their normalized twins.
    assert.ok(easternIds.has(OpenLocationCode.encode(0.5, -179.5, 4)));
  });

  it("rejects viewports that would exceed the cell limit", () => {
    assert.throws(
      () => olcGridForBounds([-180, -85, 180, 85], 8, OLC_VIEWPORT_CELL_LIMIT),
      RangeError,
    );
  });

  it("finds the single parent, child count, and neighbors of a cell", () => {
    const cell = OpenLocationCode.encode(10.78, 106.7, 8);
    const parent = olcParentCell(cell);
    assert.equal(parent, OpenLocationCode.encode(10.78, 106.7, 6));
    // Level-2 cells are the roots.
    assert.equal(olcParentCell(OpenLocationCode.encode(10.78, 106.7, 2)), null);
    // Grid-refinement lengths step back to the previous valid length.
    assert.equal(
      olcParentCell(OpenLocationCode.encode(10.78, 106.7, 11)),
      OpenLocationCode.encode(10.78, 106.7, 10),
    );

    // Pair levels subdivide 20×20, grid-refinement levels 4×5.
    assert.equal(olcChildCount(cell), 400);
    assert.equal(olcChildCount(OpenLocationCode.encode(10.78, 106.7, 10)), 20);
    assert.equal(olcChildCount(OpenLocationCode.encode(10.78, 106.7, 15)), 0);

    const neighbors = olcNeighborCells(cell);
    assert.equal(neighbors.length, 9);
    assert.ok(neighbors.includes(cell));
    for (const neighbor of neighbors) {
      assert.equal(OpenLocationCode.decode(neighbor).codeLength, 8);
    }
    // At the north pole row there are no neighbors above.
    const polar = OpenLocationCode.encode(89.9, 0, 4);
    assert.equal(olcNeighborCells(polar).length, 6);
  });
});
