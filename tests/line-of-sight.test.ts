/**
 * Tests for the interactive line of sight (issue #2858).
 *
 * Like the viewshed tests, every case has an analytically known answer -- a
 * flat plane, a single ridge at a known distance, flat ground past the
 * curvature horizon -- rather than a real DEM.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeLineOfSight,
  createTileElevationSampler,
  curvatureDrop,
  EARTH_RADIUS_METERS,
  fetchLineOfSightProfile,
  greatCircleDistance,
  interpolateGreatCircle,
  MAX_LINE_OF_SIGHT_SAMPLES,
  MAX_LINE_OF_SIGHT_TILES,
  planLineOfSightSampling,
  sampleGreatCircleProfile,
  tilesForSamples,
  type LngLat,
} from "../packages/processing/src/line-of-sight";
import { metersToLatDegrees } from "../packages/processing/src/terrain-viewshed";
import { hasSimpleStyleProperties } from "../packages/core/src/vector-color";
import {
  LOS_HIDDEN_COLOR,
  LOS_VISIBLE_COLOR,
  lineOfSightLayerCollection,
  lineOfSightOverlayCollection,
} from "../apps/geolibre-desktop/src/lib/line-of-sight-layer";

/** A point due north of the origin, `meters` away. */
const north = (meters: number): LngLat => ({ lng: 0, lat: metersToLatDegrees(meters) });
const ORIGIN: LngLat = { lng: 0, lat: 0 };

/**
 * A profile from the origin due north over terrain defined by distance.
 *
 * @param lengthMeters - Path length.
 * @param count - Sample count.
 * @param elevationAtDistance - Ground elevation at a distance from the origin.
 */
function profileNorth(
  lengthMeters: number,
  count: number,
  elevationAtDistance: (distance: number) => number,
) {
  const target = north(lengthMeters);
  return sampleGreatCircleProfile(ORIGIN, target, count, (lng, lat) =>
    elevationAtDistance(greatCircleDistance(ORIGIN, { lng, lat })),
  );
}

describe("great-circle helpers", () => {
  it("measures one degree of latitude as ~111.2 km", () => {
    const d = greatCircleDistance({ lng: 0, lat: 0 }, { lng: 0, lat: 1 });
    assert.ok(Math.abs(d - (Math.PI / 180) * EARTH_RADIUS_METERS) < 1e-6);
  });

  it("interpolates the midpoint of a meridian arc", () => {
    const mid = interpolateGreatCircle({ lng: 10, lat: 0 }, { lng: 10, lat: 20 }, 0.5);
    assert.ok(Math.abs(mid.lat - 10) < 1e-9);
    assert.ok(Math.abs(mid.lng - 10) < 1e-9);
  });

  it("follows the great circle, not the rhumb line, at high latitude", () => {
    // Between two points on the 60th parallel, the great circle bows poleward.
    const mid = interpolateGreatCircle({ lng: -30, lat: 60 }, { lng: 30, lat: 60 }, 0.5);
    assert.ok(mid.lat > 61, `midpoint latitude ${mid.lat}`);
    assert.ok(Math.abs(mid.lng) < 1e-9);
  });

  it("samples evenly spaced distances with exact endpoints", () => {
    const target = north(1000);
    const samples = sampleGreatCircleProfile(ORIGIN, target, 11, () => 5);
    assert.equal(samples.length, 11);
    assert.deepEqual([samples[0].lng, samples[0].lat], [0, 0]);
    assert.deepEqual([samples[10].lng, samples[10].lat], [target.lng, target.lat]);
    const total = greatCircleDistance(ORIGIN, target);
    for (let i = 0; i < samples.length; i += 1) {
      assert.ok(Math.abs(samples[i].distance - (i * total) / 10) < 1e-6);
    }
  });
});

describe("computeLineOfSight", () => {
  it("sees the whole of a flat plane at short range", () => {
    const result = computeLineOfSight(profileNorth(2000, 201, () => 100));
    assert.equal(result.targetVisible, true);
    assert.equal(result.firstObstruction, null);
    assert.ok(result.samples.every((sample) => sample.visible));
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0].visible, true);
    assert.equal(result.segments[0].coordinates.length, 201);
    assert.equal(result.observer.eyeMeters, 101.7);
    assert.equal(result.target.topMeters, 100);
    assert.ok(Math.abs(result.visibleFraction - 1) < 1e-9);
  });

  it("is blocked by a ridge, at the ridge's distance", () => {
    // A 50 m wall between 1000 and 1100 m along a 3 km line.
    const ridge = (d: number) => (d >= 1000 && d <= 1100 ? 150 : 100);
    const result = computeLineOfSight(profileNorth(3000, 301, ridge));
    assert.equal(result.targetVisible, false);
    assert.ok(result.firstObstruction);
    assert.ok(
      Math.abs(result.firstObstruction.distance - 1000) <= 10,
      `obstruction at ${result.firstObstruction.distance}`,
    );
    assert.equal(result.firstObstruction.elevation, 150);
    assert.equal(result.highestPoint.elevation, 150);
    // Visible up to the wall's face, hidden on its flat top and in its shadow.
    const at = (d: number) => result.samples.find((s) => Math.abs(s.distance - d) < 6)!;
    assert.equal(at(500).visible, true);
    assert.equal(at(1000).visible, true);
    assert.equal(at(1050).visible, false);
    assert.equal(at(2000).visible, false);
    assert.deepEqual(
      result.segments.map((segment) => segment.visible),
      [true, false],
    );
    // Adjacent segments share their boundary vertex, so the line has no gap.
    assert.deepEqual(result.segments[0].coordinates.at(-1), result.segments[1].coordinates[0]);
  });

  it("sees over a ridge from a tall enough mast", () => {
    const ridge = (d: number) => (d >= 1000 && d <= 1100 ? 150 : 100);
    const result = computeLineOfSight(profileNorth(3000, 301, ridge), {
      observerHeightMeters: 30,
      targetHeightMeters: 150,
    });
    assert.equal(result.targetVisible, true);
  });

  it("hides a target past the curvature horizon over flat ground", () => {
    // A 1.7 m eye sees ~5 km over flat ground; 30 km away a 0 m target is
    // ~60 m below the horizon once refraction is accounted for.
    const profile = profileNorth(30_000, 601, () => 0);
    const curved = computeLineOfSight(profile);
    assert.equal(curved.targetVisible, false);
    const flat = computeLineOfSight(profile, { curvature: false });
    assert.equal(flat.targetVisible, true);
    assert.ok(flat.samples.every((sample) => sample.visible));

    // The ground goes out of sight at the geometric horizon, sqrt(2 R' h).
    const horizon = Math.sqrt((2 * EARTH_RADIUS_METERS * 1.7) / (1 - 0.13));
    const firstHidden = curved.samples.find((sample) => !sample.visible)!;
    assert.ok(
      Math.abs(firstHidden.distance - horizon) < 200,
      `first hidden ground at ${firstHidden.distance}, horizon ${horizon}`,
    );
  });

  it("sees a tall target beyond the horizon", () => {
    // A 300 m mast 30 km away clears the ~60 m curvature drop.
    const result = computeLineOfSight(
      profileNorth(30_000, 601, () => 0),
      {
        targetHeightMeters: 300,
      },
    );
    assert.equal(result.targetVisible, true);
  });

  it("drops by d^2 (1 - k) / 2R", () => {
    assert.ok(Math.abs(curvatureDrop(10_000, 0) - 1e8 / (2 * EARTH_RADIUS_METERS)) < 1e-9);
    assert.ok(curvatureDrop(10_000) < curvatureDrop(10_000, 0));
  });

  it("sags the sight line toward a curved Earth on the chart's axis", () => {
    const result = computeLineOfSight(
      profileNorth(30_000, 3, () => 0),
      {
        targetHeightMeters: 300,
      },
    );
    const [start, middle, end] = result.samples;
    assert.ok(Math.abs(start.sightline - 1.7) < 1e-9);
    assert.ok(Math.abs(end.sightline - 300) < 1e-6);
    // A straight chord between two tops passes closest to a sphere midway, so
    // above the curved ground it sits a quarter of the full drop below the
    // average of the endpoint heights.
    const chord = (1.7 + 300) / 2;
    assert.ok(Math.abs(middle.sightline - (chord - curvatureDrop(end.distance) / 4)) < 1e-6);
  });

  it("skips missing elevations without blocking", () => {
    const profile = profileNorth(1000, 11, () => 10);
    profile[5].elevation = Number.NaN;
    const result = computeLineOfSight(profile);
    assert.equal(result.targetVisible, true);
    assert.equal(result.samples[5].visible, true);
  });

  it("refuses a profile with no elevation under an endpoint", () => {
    const profile = profileNorth(1000, 11, () => 10);
    profile[0].elevation = Number.NaN;
    assert.throws(() => computeLineOfSight(profile));
  });
});

describe("terrain sampling", () => {
  it("chooses fine tiles for a short line and coarser ones for a long line", () => {
    const short = planLineOfSightSampling(
      { lng: -121.76, lat: 46.85 },
      { lng: -121.74, lat: 46.86 },
    );
    assert.equal(short.zoom, 15);
    const long = planLineOfSightSampling({ lng: -121.76, lat: 46.85 }, { lng: -120.5, lat: 47.5 });
    assert.ok(long.zoom < short.zoom);
    for (const plan of [short, long]) {
      assert.ok(plan.tiles.size <= MAX_LINE_OF_SIGHT_TILES);
      assert.ok(plan.points.length <= MAX_LINE_OF_SIGHT_SAMPLES);
    }
  });

  it("interpolates bilinearly between pixel centres across a tile seam", () => {
    const zoom = 1;
    // Two tiles side by side: x=0 all 0 m, x=1 all 100 m.
    const tiles = new Map([
      ["0/0", new Float32Array(256 * 256).fill(0)],
      ["1/0", new Float32Array(256 * 256).fill(100)],
    ]);
    const sample = createTileElevationSampler(zoom, tiles);
    // Exactly on the seam (lng 0) is halfway between the two pixel centres.
    assert.ok(Math.abs(sample(0, 45) - 50) < 1e-6);
    assert.equal(sample(-90, 45), 0);
    assert.equal(sample(90, 45), 100);
    // Bilinear sampling at the seam reads both tiles.
    assert.deepEqual([...tilesForSamples([{ lng: 0, lat: 45 }], zoom)].sort(), ["0/0", "1/0"]);
    // A missing tile reads NaN.
    assert.ok(Number.isNaN(sample(-90, -45)));
  });

  it("returns null for a degenerate or over-long path without fetching", async () => {
    assert.equal(await fetchLineOfSightProfile({ from: ORIGIN, to: ORIGIN }), null);
    assert.equal(await fetchLineOfSightProfile({ from: ORIGIN, to: north(400_000) }), null);
  });
});

describe("line-of-sight layer features", () => {
  const ridge = (d: number) => (d >= 1000 && d <= 1100 ? 150 : 100);
  const result = computeLineOfSight(profileNorth(3000, 301, ridge));
  const settings = { observerHeightMeters: 1.7, targetHeightMeters: 0, curvature: true };

  it("saves segments, endpoints, and the obstruction with visibility attributes", () => {
    const collection = lineOfSightLayerCollection(result, settings);
    const kinds = collection.features.map((feature) => feature.properties?.kind);
    assert.deepEqual(kinds, ["segment", "segment", "observer", "target", "obstruction"]);
    const [visible, hidden, observer, target, obstruction] = collection.features;
    assert.equal(visible.properties?.visible, true);
    assert.equal(visible.properties?.stroke, LOS_VISIBLE_COLOR);
    assert.equal(hidden.properties?.visible, false);
    assert.equal(hidden.properties?.stroke, LOS_HIDDEN_COLOR);
    assert.equal(observer.properties?.target_visible, false);
    assert.equal(observer.properties?.height_m, 1.7);
    assert.equal(target.properties?.top_m, 100);
    assert.ok(Math.abs(Number(obstruction.properties?.from_observer_m) - 1000) <= 10);
    // Simplestyle colours make the new layer draw green/red without restyling.
    assert.equal(hasSimpleStyleProperties(collection), true);
  });

  it("draws a pending line while the terrain loads, then the split line", () => {
    const observer = { lng: 0, lat: 0 };
    const target = north(3000);
    const pending = lineOfSightOverlayCollection({ observer, target, result: null });
    assert.equal(pending.features[0].properties?.pending, true);
    assert.deepEqual(
      pending.features.slice(1).map((feature) => feature.properties?.role),
      ["observer", "target"],
    );
    const done = lineOfSightOverlayCollection({ observer, target, result });
    assert.deepEqual(
      done.features.map((feature) => feature.properties?.visible ?? feature.properties?.role),
      [true, false, "obstruction", "observer", "target"],
    );
    const picking = lineOfSightOverlayCollection({ observer, target: null, result: null });
    assert.equal(picking.features.length, 1);
  });
});
