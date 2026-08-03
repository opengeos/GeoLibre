import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DGGRID_GRID_SETTINGS,
  DGGRID_CONFIG,
  DGGRID_VIEWPORT_CELL_LIMIT,
  MAX_DGGRID_RESOLUTION,
  dggridCellFeature,
  dggridGridForBounds,
  dggridLabelMinZoom,
  dggridResolutionForZoom,
  loadDggrid,
  normalizeDggridGridSettings,
} from "../packages/plugins/src/plugins/maplibre-dggrid";

describe("DGGRID plugin helpers", () => {
  it("normalizes persisted settings", () => {
    assert.deepEqual(normalizeDggridGridSettings(undefined), DEFAULT_DGGRID_GRID_SETTINGS);
    assert.deepEqual(
      normalizeDggridGridSettings({
        topology: "HEXAGON",
        projection: "FULLER",
        aperture: 7,
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
        topology: "HEXAGON",
        projection: "FULLER",
        aperture: 7,
        autoResolution: false,
        resolution: MAX_DGGRID_RESOLUTION,
        fillColor: "#abcdef",
        fillOpacity: 0,
        lineColor: DEFAULT_DGGRID_GRID_SETTINGS.lineColor,
        lineWidth: 8,
        showLabels: false,
        includeNeighbors: true,
        includeParents: true,
      },
    );
  });

  it("pins non-hexagon topologies to aperture 4 and rejects unknown values", () => {
    // Any other aperture aborts the WASM engine for DIAMOND/TRIANGLE grids.
    assert.equal(normalizeDggridGridSettings({ topology: "DIAMOND", aperture: 7 }).aperture, 4);
    assert.equal(normalizeDggridGridSettings({ topology: "TRIANGLE", aperture: 3 }).aperture, 4);
    const defaulted = normalizeDggridGridSettings({
      topology: "SQUARE",
      projection: "MERCATOR",
      aperture: 5,
    });
    assert.equal(defaulted.topology, DEFAULT_DGGRID_GRID_SETTINGS.topology);
    assert.equal(defaulted.projection, DEFAULT_DGGRID_GRID_SETTINGS.projection);
    assert.equal(defaulted.aperture, DEFAULT_DGGRID_GRID_SETTINGS.aperture);
  });

  it("maps map zoom to a resolution like vgrid-maplibre's aperture rules", () => {
    // floor(zoom * factor), factor 0.95 for aperture 4, clamped to [0, 21].
    assert.equal(dggridResolutionForZoom(-1), 0);
    assert.equal(dggridResolutionForZoom(0.9), 0);
    assert.equal(dggridResolutionForZoom(4), 3);
    assert.equal(dggridResolutionForZoom(10), 9);
    assert.equal(dggridResolutionForZoom(30), MAX_DGGRID_RESOLUTION);
    // Aperture 3 subdivides more slowly (factor 1.15), aperture 7 faster (0.65).
    assert.equal(dggridResolutionForZoom(10, 3), 11);
    assert.equal(dggridResolutionForZoom(10, 7), 6);
  });

  it("only displays labels once the grid has enough screen space", () => {
    assert.equal(dggridLabelMinZoom(0), 2);
    assert.equal(dggridLabelMinZoom(4), 5);
    assert.equal(dggridLabelMinZoom(12), 13);
    assert.equal(dggridLabelMinZoom(21), 18);
  });

  it("fills a bounding box with cells and creates export-ready features", async () => {
    const engine = await loadDggrid();
    const grid = dggridGridForBounds(engine, [-122.52, 37.7, -122.35, 37.82], 10);
    assert.ok(grid.features.length > 0);
    const ids = grid.features.map((feature) => feature.properties?.dggrid as string);
    assert.equal(new Set(ids).size, ids.length);

    const feature = dggridCellFeature(engine, ids[0], 10);
    assert.equal(feature.geometry.type, "Polygon");
    const ring = feature.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    assert.equal(feature.properties?.resolution, 10);
    assert.ok(Number.isFinite(feature.properties?.center_lat));
    assert.ok(Number.isFinite(feature.properties?.center_lng));
    // The clicked point's cell must be part of the viewport fill.
    const centerCell = engine.geoToSequenceNum([[-122.43, 37.76]], 10)[0].toString();
    assert.ok(ids.includes(centerCell));
  });

  it("supports antimeridian-crossing bounds", async () => {
    const engine = await loadDggrid();
    const grid = dggridGridForBounds(engine, [179.6, -0.3, -179.6, 0.3], 8);
    assert.ok(grid.features.length > 0);
    // A cell that only clips the 0.8° x 0.6° box must stay contiguous.
    for (const feature of grid.features) {
      const lons = feature.geometry.coordinates[0].map(([lng]) => lng);
      assert.ok(Math.max(...lons) - Math.min(...lons) < 180);
    }
    // The box is tiny, so a normalization bug that collects distant cells fails here.
    assert.ok(grid.features.length < 200, String(grid.features.length));
  });

  it("fills bounds for the other cell types and projections", async () => {
    const engine = await loadDggrid();
    const bounds: [number, number, number, number] = [-122.52, 37.7, -122.35, 37.82];
    const base = { poleCoordinates: { lat: 0, lng: 0 }, azimuth: 0 } as const;
    for (const config of [
      { ...base, topology: "DIAMOND", projection: "ISEA", aperture: 4 },
      { ...base, topology: "HEXAGON", projection: "FULLER", aperture: 4 },
      { ...base, topology: "HEXAGON", projection: "ISEA", aperture: 3 },
      { ...base, topology: "HEXAGON", projection: "ISEA", aperture: 7 },
      // TRIANGLE has no neighbor lookup, exercising the sampling fallback.
      { ...base, topology: "TRIANGLE", projection: "ISEA", aperture: 4 },
    ] as const) {
      const grid = dggridGridForBounds(engine, bounds, 8, undefined, config);
      assert.ok(
        grid.features.length > 0,
        `${config.topology}/${config.projection}/${config.aperture}`,
      );
      const ids = grid.features.map((feature) => feature.properties?.dggrid as string);
      assert.equal(new Set(ids).size, ids.length);
    }
  });

  it("rejects viewports that would exceed the cell limit", async () => {
    const engine = await loadDggrid();
    assert.throws(
      () => dggridGridForBounds(engine, [-180, -85, 180, 85], 12, DGGRID_VIEWPORT_CELL_LIMIT),
      RangeError,
    );
  });

  it("returns every overlapping direct parent, canonical first", async () => {
    const engine = await loadDggrid();
    engine.setDggs({ ...DGGRID_CONFIG }, 5);
    const [cell] = engine.geoToSequenceNum([[106.6, 10.8]], 5);
    const parents = engine.sequenceNumAllParents([cell], 5)[0];
    assert.ok(parents.length >= 1);
    assert.equal(parents[0], engine.sequenceNumParent([cell], 5)[0]);
  });
});
