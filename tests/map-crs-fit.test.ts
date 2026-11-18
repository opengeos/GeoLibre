import assert from "node:assert/strict";
import { describe, it } from "node:test";
import proj4 from "proj4";
import { getMapCrsPreset } from "@geolibre/core";
import {
  cameraForMapCrsBox,
  mapCrsGridBox,
  placeExtentInMapCrs,
  projectBoundsToCrs,
} from "../packages/map/src/map-crs-fit";
import { createMapController } from "../packages/map/src/map-controller";
import type { ResolvedMapCrs } from "../packages/map/src/active-map-crs";
import type { GeoLibreLayer } from "@geolibre/core";

// Zoom to layer on a map drawn in a custom CRS (issue #3516): an extent off the
// CRS's tile grid was fitted anyway, MapLibre clamped the camera to the grid
// edge, and Knoxville landed in central Illinois with half the canvas blank.

const arctic = getMapCrsPreset("earth-arctic")!;
const converter = proj4(arctic.definition);
const grid = arctic.tileMatrixSet;

/** Knoxville buildings PMTiles header bounds (the issue's dataset). */
const KNOXVILLE: [number, number, number, number] = [-84.1, 35.85, -83.75, 36.07];
/** Northern Alaska, well inside the Arctic grid. */
const NORTH_SLOPE: [number, number, number, number] = [-156, 69, -148, 71.5];
/** The conterminous US: its northern part is on the Arctic grid, its south is not. */
const CONUS: [number, number, number, number] = [-125, 24, -66, 49.5];

describe("map-crs-fit", () => {
  it("spans the whole tile grid square", () => {
    assert.deepEqual(mapCrsGridBox(grid), [-4194304, -4194304, 4194304, 4194304]);
  });

  it("projects a lng/lat box through samples, not only its corners", () => {
    // A box spanning the pole's meridians: the corners alone miss the bulge.
    const box = projectBoundsToCrs([-180, 60, 180, 90], converter);
    assert.ok(box);
    const [x] = converter.forward([-45 + 180, 60]);
    assert.ok(box[2] >= x - 1, "covers the far side of the ring");
  });

  it("places an extent off the Arctic grid outside it", () => {
    assert.deepEqual(placeExtentInMapCrs(KNOXVILLE, converter, grid), { kind: "outside" });
  });

  it("places an extent on the Arctic grid inside it", () => {
    assert.deepEqual(placeExtentInMapCrs(NORTH_SLOPE, converter, grid), { kind: "inside" });
  });

  it("clips an extent that straddles the grid edge to the grid", () => {
    const placement = placeExtentInMapCrs(CONUS, converter, grid);
    assert.equal(placement?.kind, "clipped");
    if (placement?.kind !== "clipped") return;
    const [gridMinX, gridMinY, gridMaxX, gridMaxY] = mapCrsGridBox(grid);
    const [minX, minY, maxX, maxY] = placement.box;
    assert.ok(minX >= gridMinX && minY >= gridMinY && maxX <= gridMaxX && maxY <= gridMaxY);
    assert.ok(
      minY - gridMinY < grid.extentAtZoom0 * 0.05,
      "the southern part is cut at the grid edge",
    );
  });

  it("samples a box written across the antimeridian on its real meridians", () => {
    const plate = getMapCrsPreset("earth-cylindrical")!;
    const lngLat = proj4(plate.definition);
    // [170, 190] is Fiji-ish: wrapped, it is on the grid, not half past its edge.
    assert.deepEqual(placeExtentInMapCrs([170, -20, 190, -10], lngLat, plate.tileMatrixSet), {
      kind: "inside",
    });
  });

  it("samples a west > east box the short way across the antimeridian", () => {
    const plate = getMapCrsPreset("earth-cylindrical")!;
    const lngLat = proj4(plate.definition);
    // A grid around Greenwich sees none of a dateline box; sampled the long
    // way round, the box would sweep across it.
    const greenwich = { origin: [-5, 5] as [number, number], extentAtZoom0: 10 };
    assert.deepEqual(placeExtentInMapCrs([170, -1, -170, 1], lngLat, greenwich), {
      kind: "outside",
    });
  });

  it("finds a grid smaller than the extent's sample spacing", () => {
    const identity = {
      forward: ([x, y]: [number, number]) => [x, y],
      inverse: ([x, y]: [number, number]) => [x, y],
    };
    const tiny = { origin: [1, 1] as [number, number], extentAtZoom0: 1 };
    const placement = placeExtentInMapCrs([-180, 0, 180, 1], identity, tiny);
    assert.equal(placement?.kind, "clipped");
  });

  it("tests the footprint, not its box: a band of latitude past a polar grid's edge is outside", () => {
    const moon = getMapCrsPreset("moon-north-polar");
    assert.ok(moon, "the Moon north polar preset exists");
    const moonConverter = proj4(moon.definition);
    // The band's box covers the whole grid, but the band itself rings it.
    const box = projectBoundsToCrs([-180, 0, 180, 10], moonConverter)!;
    const gridBox = mapCrsGridBox(moon.tileMatrixSet);
    assert.ok(box[0] <= gridBox[0] && box[2] >= gridBox[2]);
    assert.deepEqual(placeExtentInMapCrs([-180, 0, 180, 10], moonConverter, moon.tileMatrixSet), {
      kind: "outside",
    });
  });

  it("returns null for an extent that does not project", () => {
    const broken = {
      forward: () => [Number.NaN, Number.NaN],
      inverse: () => [Number.NaN, Number.NaN],
    };
    assert.equal(placeExtentInMapCrs(KNOXVILLE, broken, grid), null);
  });

  it("frames a CRS box by its share of the 512 px zoom-0 grid", () => {
    // A quarter of the grid square on a 552 px canvas (512 + 2 x 20 padding)
    // fills it at zoom 2.
    const half = grid.extentAtZoom0 / 8;
    const camera = cameraForMapCrsBox(
      [-half, -half, half, half],
      converter,
      grid,
      { width: 552, height: 552 },
      20,
    );
    assert.ok(camera);
    assert.ok(Math.abs(camera.zoom - 2) < 1e-9);
    assert.ok(Math.abs(camera.center[1] - 90) < 1e-6, "centered on the pole");
  });
});

interface Internals {
  map: unknown;
  styleReady: boolean;
  activeCrs: ResolvedMapCrs | null;
  activeCrsConverter: unknown;
  guardMapCrsFits: (map: unknown) => void;
}

function crsController(): {
  controller: ReturnType<typeof createMapController>;
  calls: string[];
  flyTo: unknown[];
} {
  const calls: string[] = [];
  const flyTo: unknown[] = [];
  const map = {
    getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    getMaxZoom: () => 22,
    getZoom: () => 3,
    getPitch: () => 0,
    flyTo: (options: unknown) => {
      calls.push("flyTo");
      flyTo.push(options);
    },
    fitBounds: () => calls.push("fitBounds"),
    cameraForBounds: () => {
      calls.push("cameraForBounds");
      return undefined;
    },
    getProjection: () => ({ type: arctic.code }),
    getSource: () => undefined,
  };
  const controller = createMapController();
  const internal = controller as unknown as Internals;
  internal.map = map;
  internal.styleReady = true;
  internal.activeCrs = {
    id: arctic.id,
    code: arctic.code,
    definition: arctic.definition,
    tileMatrixSet: grid,
    bounds: arctic.bounds,
  };
  internal.activeCrsConverter = converter;
  return { controller, calls, flyTo };
}

function pmtilesLayer(bounds: [number, number, number, number]): GeoLibreLayer {
  return {
    id: "knoxville",
    name: "knoxville_buildings",
    type: "pmtiles",
    source: { type: "pmtiles", url: "https://data.geolibre.app/knoxville_buildings.pmtiles" },
    visible: true,
    opacity: 1,
    style: {},
    metadata: { bounds },
  } as unknown as GeoLibreLayer;
}

describe("MapController.fitLayer in a custom CRS", () => {
  it("does not move the camera to a layer off the CRS grid, and says why", () => {
    const { controller, calls } = crsController();
    const layer = pmtilesLayer(KNOXVILLE);
    assert.equal(controller.fitLayer(layer), false);
    assert.deepEqual(calls, [], "no fit clamps the camera to the grid edge");
    assert.equal(controller.isLayerOutsideMapCrs(layer), true);
  });

  it("fits a layer on the CRS grid the ordinary way", () => {
    const { controller, calls } = crsController();
    const layer = pmtilesLayer(NORTH_SLOPE);
    assert.equal(controller.fitLayer(layer), true);
    assert.ok(calls.includes("fitBounds"));
    assert.equal(controller.isLayerOutsideMapCrs(layer), false);
  });

  it("flies to the part of a layer that is on the CRS grid", () => {
    const { controller, calls, flyTo } = crsController();
    assert.equal(controller.fitLayer(pmtilesLayer(CONUS)), true);
    assert.deepEqual(calls, ["flyTo"]);
    const { center } = flyTo[0] as { center: [number, number] };
    const [x, y] = converter.forward(center);
    const [minX, minY, maxX, maxY] = mapCrsGridBox(grid);
    assert.ok(x > minX && x < maxX && y > minY && y < maxY, "the center is on the grid");
  });

  it("keeps the app API's fitBounds off the grid edge", () => {
    const { controller, calls } = crsController();
    controller.fitBounds(KNOXVILLE);
    assert.deepEqual(calls, []);
    controller.fitBounds(CONUS);
    assert.deepEqual(calls, ["flyTo"]);
    controller.fitBounds(NORTH_SLOPE);
    assert.deepEqual(calls, ["flyTo", "fitBounds"]);
  });

  it("guards a control's fitBounds on the MapLibre map itself (the PMTiles panel)", () => {
    const { controller, calls } = crsController();
    const internal = controller as unknown as Internals;
    const map = internal.map as { fitBounds: (...args: unknown[]) => unknown };
    internal.guardMapCrsFits(map);
    // The upstream PMTiles control frames its archive this way, header bounds as corner pairs.
    map.fitBounds(
      [
        [KNOXVILLE[0], KNOXVILLE[1]],
        [KNOXVILLE[2], KNOXVILLE[3]],
      ],
      { padding: 40, duration: 1000 },
    );
    assert.deepEqual(calls, [], "a fit off the grid is skipped");
    map.fitBounds(CONUS, { padding: 40 });
    assert.deepEqual(calls, ["flyTo"], "a straddling fit frames the on-grid part");
    map.fitBounds(NORTH_SLOPE);
    assert.deepEqual(calls, ["flyTo", "fitBounds"], "an on-grid fit passes through");
    internal.activeCrs = null;
    map.fitBounds(KNOXVILLE);
    assert.deepEqual(calls, ["flyTo", "fitBounds", "fitBounds"], "the default map passes through");
  });

  it("carries the caller's animation and zoom ceiling into a clipped fit", () => {
    const { controller, flyTo } = crsController();
    const internal = controller as unknown as Internals;
    const map = internal.map as { fitBounds: (...args: unknown[]) => unknown };
    internal.guardMapCrsFits(map);
    map.fitBounds(CONUS, { animate: false, duration: 0, maxZoom: 0 });
    assert.deepEqual(
      [
        (flyTo[0] as { animate?: boolean }).animate,
        (flyTo[0] as { duration: number }).duration,
        (flyTo[0] as { zoom: number }).zoom,
      ],
      [false, 0, 0],
    );
  });

  it("forwards the caller's eventData to a clipped camera move", () => {
    const { controller } = crsController();
    const internal = controller as unknown as Internals;
    const map = internal.map as {
      fitBounds: (...args: unknown[]) => unknown;
      flyTo: (...args: unknown[]) => unknown;
    };
    const seen: unknown[] = [];
    map.flyTo = (_options: unknown, eventData?: unknown) => seen.push(eventData);
    internal.guardMapCrsFits(map);
    map.fitBounds(CONUS, { animate: false }, { storyCameraToken: 1 });
    assert.deepEqual(seen, [{ storyCameraToken: 1 }]);
  });

  it("does not fly to a 3D Tiles center off the CRS grid", () => {
    const { controller, calls } = crsController();
    const layer = {
      ...pmtilesLayer(NORTH_SLOPE),
      type: "3d-tiles",
      metadata: { center: [-83.9, 35.96] },
    } as unknown as GeoLibreLayer;
    assert.equal(controller.fitLayer(layer), false);
    assert.deepEqual(calls, []);
    assert.equal(controller.isLayerOutsideMapCrs(layer), true);
  });

  it("frames a 3D Tiles layer by its bounds when its center is off the grid", () => {
    const { controller, calls } = crsController();
    const layer = {
      ...pmtilesLayer(CONUS),
      type: "3d-tiles",
      metadata: { center: [-83.9, 35.96], bounds: CONUS },
    } as unknown as GeoLibreLayer;
    assert.equal(controller.fitLayer(layer), true);
    assert.deepEqual(calls, ["flyTo"], "the on-grid part of its bounds");
    assert.equal(controller.isLayerOutsideMapCrs(layer), false);
  });

  it("stays put on a straddling extent when the canvas has no size", () => {
    const { controller, calls } = crsController();
    const internal = controller as unknown as Internals;
    (internal.map as { getCanvas: () => unknown }).getCanvas = () => ({
      clientWidth: 0,
      clientHeight: 0,
    });
    controller.fitBounds(CONUS);
    assert.deepEqual(calls, [], "no unclipped fit clamps the camera to the grid edge");
  });

  it("reports a 3D Tiles layer with only bounds, off the grid, as outside the CRS", () => {
    const { controller, calls } = crsController();
    const layer = { ...pmtilesLayer(KNOXVILLE), type: "3d-tiles" } as GeoLibreLayer;
    assert.equal(controller.fitLayer(layer), false);
    assert.deepEqual(calls, []);
    assert.equal(controller.isLayerOutsideMapCrs(layer), true);
  });

  it("leaves the default map's fit alone", () => {
    const { controller, calls } = crsController();
    const internal = controller as unknown as Internals;
    internal.activeCrs = null;
    internal.activeCrsConverter = null;
    const layer = pmtilesLayer(KNOXVILLE);
    assert.equal(controller.fitLayer(layer), true);
    assert.ok(calls.includes("fitBounds"));
    assert.equal(controller.isLayerOutsideMapCrs(layer), false);
  });
});
