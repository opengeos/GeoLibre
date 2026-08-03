import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DGGAL_GRID_SETTINGS,
  DGGAL_TYPES,
  DGGAL_TYPE_NAMES,
  DGGAL_VIEWPORT_CELL_LIMIT,
  dggalGridForBounds,
  dggalLabelMinZoom,
  dggalParentZones,
  dggalResolutionForZoom,
  dggalZoneFeature,
  loadDggal,
  normalizeDggalGridSettings,
} from "../packages/plugins/src/plugins/maplibre-dggal";

describe("DGGAL plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeDggalGridSettings(undefined), DEFAULT_DGGAL_GRID_SETTINGS);
    assert.deepEqual(
      normalizeDggalGridSettings({
        dggrsType: "HEALPix",
        autoResolution: false,
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
        dggrsType: "HEALPix",
        autoResolution: false,
        // Clamped to HEALPix's maximum resolution.
        resolution: DGGAL_TYPES.HEALPix,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_DGGAL_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
      },
    );
    assert.equal(
      normalizeDggalGridSettings({ dggrsType: "NotAGrid" }).dggrsType,
      DEFAULT_DGGAL_GRID_SETTINGS.dggrsType,
    );
    // Inherited Object.prototype keys must not pass as a grid type.
    for (const key of ["constructor", "toString", "valueOf"]) {
      const normalized = normalizeDggalGridSettings({ dggrsType: key });
      assert.equal(normalized.dggrsType, DEFAULT_DGGAL_GRID_SETTINGS.dggrsType, key);
      assert.ok(Number.isInteger(normalized.resolution), key);
    }
  });

  it("maps map zoom to a resolution like vgrid-maplibre's per-type rules", () => {
    // floor(zoom * factor), clamped to the type's resolution range.
    assert.equal(dggalResolutionForZoom(10, "ISEA3H"), 11); // 1.15
    assert.equal(dggalResolutionForZoom(10, "ISEA4R"), 9); // 0.95
    assert.equal(dggalResolutionForZoom(10, "HEALPix"), 9); // 0.95
    assert.equal(dggalResolutionForZoom(10, "ISEA7H"), 6); // 0.65
    assert.equal(dggalResolutionForZoom(10, "ISEA9R"), 6); // 0.6
    assert.equal(dggalResolutionForZoom(10, "rHEALPix"), 6); // 0.6
    assert.equal(dggalResolutionForZoom(10, "GNOSISGlobalGrid"), 10); // 1
    assert.equal(dggalResolutionForZoom(-1, "ISEA3H"), 0);
    assert.equal(dggalResolutionForZoom(99, "ISEA9R"), DGGAL_TYPES.ISEA9R);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(dggalLabelMinZoom(0), 2);
    assert.equal(dggalLabelMinZoom(4), 5);
    assert.equal(dggalLabelMinZoom(12), 13);
    assert.equal(dggalLabelMinZoom(33), 18);
  });

  it("fills a bounding box with zones and creates export-ready features", async () => {
    const dggal = await loadDggal();
    const dggrs = dggal.createDGGRS("ISEA3H");
    const grid = dggalGridForBounds(dggrs, [-122.52, 37.7, -122.35, 37.82], 10);
    assert.ok(grid.features.length > 0);
    const ids = grid.features.map((feature) => feature.properties?.dggal as string);
    assert.equal(new Set(ids).size, ids.length);

    const feature = dggalZoneFeature(dggrs, ids[0]);
    assert.equal(feature.geometry.type, "Polygon");
    const ring = feature.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(feature.properties?.resolution, 10);
    assert.ok(Number.isFinite(feature.properties?.center_lat));
    assert.ok(Number.isFinite(feature.properties?.center_lng));
    // The clicked point's zone must be part of the viewport fill.
    const D2R = Math.PI / 180;
    const clicked = dggrs.getZoneTextID(
      dggrs.getZoneFromWGS84Centroid(10, { lat: 37.76 * D2R, lon: -122.43 * D2R }),
    );
    assert.ok(ids.includes(clicked));
    dggrs.delete();
  });

  it("fills bounds for every offered grid type", async () => {
    const dggal = await loadDggal();
    for (const name of DGGAL_TYPE_NAMES) {
      const dggrs = dggal.createDGGRS(name);
      const grid = dggalGridForBounds(dggrs, [-122.52, 37.7, -122.35, 37.82], 5);
      assert.ok(grid.features.length > 0, name);
      dggrs.delete();
    }
  });

  it("supports antimeridian-crossing bounds with contiguous rings", async () => {
    const dggal = await loadDggal();
    const dggrs = dggal.createDGGRS("ISEA3H");
    const grid = dggalGridForBounds(dggrs, [179.6, -0.3, 180.4, 0.3], 8);
    assert.ok(grid.features.length > 0);
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      // Contiguous rings never span the world even when they cross ±180.
      assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
    }
    dggrs.delete();
  });

  it("supports wrapped antimeridian bounds (east < west) without duplicates", async () => {
    const dggal = await loadDggal();
    const dggrs = dggal.createDGGRS("ISEA3H");
    const grid = dggalGridForBounds(dggrs, [179.6, -0.3, -179.6, 0.3], 8);
    assert.ok(grid.features.length > 0);
    const ids = grid.features.map((feature) => feature.properties?.dggal as string);
    assert.equal(new Set(ids).size, ids.length);
    dggrs.delete();
  });

  it("preserves unwrapped full-world longitude spans", async () => {
    const dggal = await loadDggal();
    const dggrs = dggal.createDGGRS("ISEA3H");
    // [0, 360] must not collapse to a zero-width box after normalizeLon.
    const grid = dggalGridForBounds(dggrs, [0, -85, 360, 85], 4);
    const ids = grid.features.map((feature) => feature.properties?.dggal as string);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, Number(dggrs.countZones(4)));
    dggrs.delete();
  });

  it("rejects viewports that would exceed the zone limit", async () => {
    const dggal = await loadDggal();
    const dggrs = dggal.createDGGRS("ISEA3H");
    assert.throws(
      () => dggalGridForBounds(dggrs, [-180, -85, 180, 85], 12, DGGAL_VIEWPORT_CELL_LIMIT),
      RangeError,
    );
    dggrs.delete();
  });

  it("filters parent zones to the level above (the binding pads with garbage)", async () => {
    const dggal = await loadDggal();
    const dggrs = dggal.createDGGRS("ISEA3H");
    const D2R = Math.PI / 180;
    const cell = dggrs.getZoneTextID(
      dggrs.getZoneFromWGS84Centroid(8, { lat: 10.8 * D2R, lon: 106.6 * D2R }),
    );
    const parents = dggalParentZones(dggrs, cell);
    assert.ok(parents.length >= 1);
    for (const parent of parents) {
      assert.equal(dggrs.getZoneLevel(dggrs.getZoneFromTextID(parent)), 7);
    }
    dggrs.delete();
  });
});
