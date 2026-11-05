import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, setActiveEllipsoidId, type GeoLibreLayer } from "@geolibre/core";
import { getVectorTool } from "@geolibre/processing";
import type { Feature, FeatureCollection, Geometry } from "geojson";

/** Build a point layer from [lon, lat, props] tuples. */
function pointLayer(
  id: string,
  points: [number, number, Record<string, unknown>][],
): GeoLibreLayer {
  const features: Feature<Geometry>[] = points.map(([lon, lat, properties]) => ({
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: [lon, lat] },
  }));
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features },
  };
}

/** Run a vector tool and return the result collection (or null if none added). */
function runTool(
  id: string,
  layers: GeoLibreLayer[],
  parameters: Record<string, unknown>,
): { result: FeatureCollection | null; messages: string[] } {
  const tool = getVectorTool(id);
  assert.ok(tool, `tool ${id} is registered`);
  let result: FeatureCollection | null = null;
  const messages: string[] = [];
  tool.run({
    layers,
    parameters,
    log: (m) => messages.push(m),
    addResultLayer: (_name, geojson) => {
      result = geojson;
    },
  });
  return { result, messages };
}

describe("cell-site coverage", () => {
  it("builds a sector polygon per site with computed attributes", () => {
    const sites = pointLayer("sites", [[0, 0, { name: "tower" }]]);
    const { result } = runTool("cell-sectors", [sites], {
      layer: "sites",
      azimuth: 90,
      radius: 1,
      beamwidth: 90,
      units: "kilometers",
    });
    assert.ok(result);
    assert.equal(result!.features.length, 1);
    const sector = result!.features[0];
    assert.ok(sector.geometry?.type === "Polygon" || sector.geometry?.type === "MultiPolygon");
    // Original property is preserved and the computed inputs are recorded.
    assert.equal(sector.properties?.name, "tower");
    assert.equal(sector.properties?.azimuth, 90);
    assert.equal(sector.properties?.radius, 1);
    assert.equal(sector.properties?.beamwidth, 90);
  });

  it("reads azimuth/radius/beamwidth from fields and skips zero-coverage sites", () => {
    const sites = pointLayer("sites", [
      [0, 0, { az: 0, r: 2, bw: 60 }],
      [1, 1, { az: 180, r: 0, bw: 60 }], // zero radius -> skipped
    ]);
    const { result, messages } = runTool("cell-sectors", [sites], {
      layer: "sites",
      azimuthField: "az",
      radiusField: "r",
      beamwidthField: "bw",
      units: "kilometers",
    });
    assert.equal(result!.features.length, 1);
    assert.equal(result!.features[0].properties?.radius, 2);
    assert.ok(messages.some((m) => m.includes("Skipped 1")));
  });

  it("builds a sector that sweeps through north (negative bearing1)", () => {
    // azimuth 5, beamwidth 30 -> bearing1 = -10, bearing2 = 20 (crosses north).
    const sites = pointLayer("sites", [[0, 0, {}]]);
    const { result } = runTool("cell-sectors", [sites], {
      layer: "sites",
      azimuth: 5,
      radius: 1,
      beamwidth: 30,
      units: "kilometers",
    });
    assert.equal(result!.features.length, 1);
    const sector = result!.features[0];
    assert.equal(sector.geometry?.type, "Polygon");
    assert.ok((sector.geometry as { coordinates: number[][][] }).coordinates[0].length > 3);
    assert.equal(sector.properties?.beamwidth, 30);
  });

  it("clamps a beamwidth over 360 to a full circle", () => {
    const sites = pointLayer("sites", [[0, 0, {}]]);
    const { result } = runTool("cell-sectors", [sites], {
      layer: "sites",
      azimuth: 0,
      radius: 1,
      beamwidth: 400, // > 360 -> clamped, rendered as a full circle
      units: "kilometers",
    });
    assert.equal(result!.features.length, 1);
    const sector = result!.features[0];
    assert.ok(sector.geometry?.type === "Polygon" || sector.geometry?.type === "MultiPolygon");
    assert.equal(sector.properties?.beamwidth, 360);
  });
});

describe("trajectory speed", () => {
  it("connects time-ordered fixes and computes duration and speed", () => {
    // ~1.11 km north, one hour apart -> ~1.11 km/h.
    const track = pointLayer("track", [
      [0, 0.01, { t: "2024-01-01T01:00:00Z" }], // out of order on purpose
      [0, 0, { t: "2024-01-01T00:00:00Z" }],
    ]);
    const { result } = runTool("trajectory-speed", [track], {
      layer: "track",
      timeField: "t",
      speedUnits: "km/h",
    });
    assert.equal(result!.features.length, 1);
    const seg = result!.features[0];
    assert.equal(seg.geometry?.type, "LineString");
    assert.equal(seg.properties?.duration_s, 3600);
    const speed = seg.properties?.speed as number;
    assert.ok(speed > 1 && speed < 1.3, `speed ${speed} ~ 1.11 km/h`);
  });

  it("splits trajectories by id field", () => {
    const track = pointLayer("track", [
      [0, 0, { t: 0, id: "a" }],
      [0, 0.01, { t: 3600, id: "a" }],
      [1, 1, { t: 0, id: "b" }],
      [1, 1.01, { t: 3600, id: "b" }],
    ]);
    const { result } = runTool("trajectory-speed", [track], {
      layer: "track",
      timeField: "t",
      idField: "id",
      speedUnits: "m/s",
    });
    // Two segments (one per target), not three across the id boundary.
    assert.equal(result!.features.length, 2);
  });
});

describe("the active celestial body", () => {
  // These tools measure on the active body's ellipsoid (issue #3267). Expected
  // distances were computed with GeographicLib through pyproj 3.8.0:
  // Geod(ellps="WGS84") for Earth and Geod(a=3396190, rf=169.894447) for Mars.
  it("measures trajectory segments on the body's ellipsoid", () => {
    const track = pointLayer("track", [
      [0, 0, { t: 0 }],
      [0, 0.01, { t: 3600 }],
    ]);
    const segmentOn = (body: string): Record<string, unknown> => {
      setActiveEllipsoidId(body);
      try {
        const { result } = runTool("trajectory-speed", [track], {
          layer: "track",
          timeField: "t",
          speedUnits: "km/h",
        });
        return result!.features[0].properties ?? {};
      } finally {
        setActiveEllipsoidId("earth");
      }
    };
    // 0.01° of meridian at the equator: 1,105.743 m on Earth, 585.790 m on Mars.
    const earth = segmentOn("earth");
    assert.equal(earth.distance_m, 1105.74);
    assert.equal(earth.speed, 1.106);
    const mars = segmentOn("mars");
    assert.equal(mars.distance_m, 585.79);
    assert.equal(mars.speed, 0.586);
  });

  it("holds the stop-detection threshold in the body's ground distance", () => {
    // 1,105.743 m apart on Earth and 585.790 m on Mars. A 800 m threshold
    // therefore separates them on Earth but merges them on Mars.
    const track = pointLayer("track", [
      [0, 0, { t: 0 }],
      [0, 0.01, { t: 600 }],
    ]);
    const stopsWith = (body: string): number => {
      setActiveEllipsoidId(body);
      try {
        const { result } = runTool("detect-stops", [track], {
          layer: "track",
          timeField: "t",
          maxDistance: 0.8,
          distanceUnits: "kilometers",
          minDuration: 1,
          durationUnits: "minutes",
        });
        return result?.features.length ?? 0;
      } finally {
        setActiveEllipsoidId("earth");
      }
    };
    assert.equal(stopsWith("earth"), 0);
    assert.equal(stopsWith("mars"), 1);
  });
});

describe("detect stops", () => {
  it("compares the threshold with the WGS 84 distance", () => {
    // 0.01° of meridian at the equator is 1,105.743 m on WGS 84 (GeographicLib
    // via pyproj 3.8.0) and 1,111.95 m on the sphere of mean radius, so a
    // 1,108 m threshold keeps both fixes in one stop only on the ellipsoid.
    const track = pointLayer("track", [
      [0, 0, { t: 0 }],
      [0, 0.01, { t: 600 }],
    ]);
    const { result } = runTool("detect-stops", [track], {
      layer: "track",
      timeField: "t",
      maxDistance: 1108,
      distanceUnits: "meters",
      minDuration: 1,
    });
    assert.equal(result!.features.length, 1);
    assert.equal(result!.features[0].properties?.n_points, 2);
  });

  it("merges scattered fixes into one stop and ignores brief/lone fixes", () => {
    const track = pointLayer("track", [
      [0, 0, { t: 1700000000 }], // epoch seconds
      [0.0001, 0, { t: 1700000060 }], // ~11 m away
      [0, 0.0001, { t: 1700000120 }], // ~11 m away, 120 s total
      [1, 1, { t: 1700000200 }], // far away -> not part of the stop
    ]);
    const { result } = runTool("detect-stops", [track], {
      layer: "track",
      timeField: "t",
      maxDistance: 50,
      minDuration: 60,
    });
    assert.equal(result!.features.length, 1);
    const stop = result!.features[0];
    assert.equal(stop.geometry?.type, "Point");
    assert.equal(stop.properties?.n_points, 3);
    assert.equal(stop.properties?.duration_s, 120);
  });

  it("centres a stop near the antimeridian, not at longitude 0", () => {
    // Fixes straddling ±180° are ~22 m apart and form one stop; the centroid
    // must land near ±180, not average to 0 (the Atlantic).
    const track = pointLayer("track", [
      [179.9999, 0, { t: 0 }],
      [-179.9999, 0, { t: 120 }],
    ]);
    const { result } = runTool("detect-stops", [track], {
      layer: "track",
      timeField: "t",
      maxDistance: 50,
      minDuration: 60,
    });
    assert.equal(result!.features.length, 1);
    const lon = (result!.features[0].geometry as { coordinates: number[] }).coordinates[0];
    assert.ok(Math.abs(lon) > 179, `centroid lon ${lon} should be near ±180`);
  });

  it("detects stops independently per target without merging trajectories", () => {
    // Two targets dwell at separate places; their time windows interleave.
    const track = pointLayer("track", [
      [0, 0, { t: 0, id: "A" }],
      [5, 5, { t: 30, id: "B" }],
      [0.0001, 0, { t: 60, id: "A" }],
      [5.0001, 5, { t: 90, id: "B" }],
      [0, 0.0001, { t: 120, id: "A" }],
      [5, 5.0001, { t: 150, id: "B" }],
    ]);
    const { result } = runTool("detect-stops", [track], {
      layer: "track",
      timeField: "t",
      idField: "id",
      maxDistance: 50,
      minDuration: 60,
    });
    assert.equal(result!.features.length, 2);
    const ids = result!.features.map((f) => f.properties?.id).sort();
    assert.deepEqual(ids, ["A", "B"]);
    for (const stop of result!.features) {
      assert.equal(stop.properties?.n_points, 3);
    }
  });
});

describe("space-time proximity", () => {
  it("pairs points close in space and time across different targets", () => {
    const points = pointLayer("points", [
      [0, 0, { t: 0, id: "a" }],
      [0.00005, 0, { t: 30, id: "b" }], // ~5.5 m, 30 s later, different id
      [10, 10, { t: 45, id: "c" }], // far in space -> excluded
    ]);
    const { result } = runTool("space-time-proximity", [points], {
      layer: "points",
      timeField: "t",
      idField: "id",
      maxDistance: 100,
      distanceUnits: "meters",
      maxTime: 1,
      timeUnits: "minutes",
    });
    assert.equal(result!.features.length, 1);
    const pair = result!.features[0];
    assert.equal(pair.geometry?.type, "LineString");
    assert.equal(pair.properties?.time_diff_s, 30);
    assert.equal(pair.properties?.id_a, "a");
    assert.equal(pair.properties?.id_b, "b");
  });

  it("excludes same-target pairs when an id field is set", () => {
    const points = pointLayer("points", [
      [0, 0, { t: 0, id: "a" }],
      [0, 0, { t: 5, id: "a" }], // same id, same place -> excluded
    ]);
    const { result } = runTool("space-time-proximity", [points], {
      layer: "points",
      timeField: "t",
      idField: "id",
      maxDistance: 100,
      distanceUnits: "meters",
      maxTime: 1,
      timeUnits: "minutes",
    });
    assert.equal(result!.features.length, 0);
  });

  it("pairs every nearby point when no id field is set", () => {
    const points = pointLayer("points", [
      [0, 0, { t: 0 }],
      [0.00005, 0, { t: 30 }], // ~5.5 m, 30 s later
    ]);
    const { result } = runTool("space-time-proximity", [points], {
      layer: "points",
      timeField: "t",
      maxDistance: 100,
      distanceUnits: "meters",
      maxTime: 1,
      timeUnits: "minutes",
    });
    assert.equal(result!.features.length, 1);
    // Without an id field the result carries no id columns.
    assert.equal("id_a" in (result!.features[0].properties ?? {}), false);
  });

  it("measures the pair distance on the WGS 84 ellipsoid", () => {
    // Torino–Trieste is 480,833.088 m on WGS 84 (GeographicLib via pyproj
    // 3.8.0). The sphere of mean radius gave 479,510 m, inside a 480 km band.
    const points = pointLayer("points", [
      [7.6869, 45.0703, { t: 0 }],
      [13.77, 45.65, { t: 30 }],
    ]);
    const pairsWithin = (maxDistance: number, distanceUnits: string) =>
      runTool("space-time-proximity", [points], {
        layer: "points",
        timeField: "t",
        maxDistance,
        distanceUnits,
        maxTime: 1,
        timeUnits: "minutes",
      }).result!.features;
    assert.equal(pairsWithin(480, "kilometers").length, 0);
    const [pair] = pairsWithin(481, "kilometers");
    assert.equal(pair.properties?.distance, 480.833);
    // 480,833.088 m / 1,609.344 m.
    assert.equal(pairsWithin(300, "miles")[0].properties?.distance, 298.776);
  });
});
