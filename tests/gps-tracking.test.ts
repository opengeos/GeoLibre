import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LineString, MultiLineString } from "geojson";
import {
  accuracyCircle,
  buildTrackGpx,
  capturePointFeature,
  DEFAULT_GPS_SETTINGS,
  fixFromPosition,
  fixMeetsAccuracy,
  formatDistance,
  formatDuration,
  formatSpeedKmh,
  type GpsFix,
  haversineMeters,
  isGpsCaptureLayer,
  lineSegments,
  normalizeGpsSettings,
  shouldLogFix,
  trackFeature,
  trackFeatureCollection,
  trackPointCount,
  trackPreview,
  trackStats,
} from "../apps/geolibre-desktop/src/lib/gps-tracking";

function fix(overrides: Partial<GpsFix> = {}): GpsFix {
  return {
    lng: -123.09,
    lat: 44.05,
    accuracy: 5,
    altitude: null,
    heading: null,
    speed: null,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("gps-tracking settings", () => {
  it("returns defaults for garbage input", () => {
    assert.deepEqual(normalizeGpsSettings(null), DEFAULT_GPS_SETTINGS);
    assert.deepEqual(normalizeGpsSettings("nope"), DEFAULT_GPS_SETTINGS);
    assert.deepEqual(normalizeGpsSettings(42), DEFAULT_GPS_SETTINGS);
  });

  it("keeps valid values and coerces numeric strings", () => {
    const s = normalizeGpsSettings({
      minDistanceM: 10,
      minTimeS: "5",
      maxAccuracyM: 25,
    });
    assert.deepEqual(s, { minDistanceM: 10, minTimeS: 5, maxAccuracyM: 25 });
  });

  it("zeroes negatives/NaN and clamps absurd values", () => {
    const s = normalizeGpsSettings({
      minDistanceM: -3,
      minTimeS: Number.NaN,
      maxAccuracyM: 1e9,
    });
    assert.equal(s.minDistanceM, 0);
    assert.equal(s.minTimeS, 0);
    assert.ok(s.maxAccuracyM <= 100_000);
  });
});

describe("gps-tracking geometry", () => {
  it("haversineMeters matches a known distance", () => {
    // One degree of latitude is ~111.2 km.
    const d = haversineMeters([0, 0], [0, 1]);
    assert.ok(Math.abs(d - 111_195) < 200, `got ${d}`);
  });

  it("accuracyCircle builds a closed ring roughly accuracy meters out", () => {
    const f = fix({ accuracy: 100 });
    const circle = accuracyCircle(f, 32);
    const ring = circle.geometry.coordinates[0];
    assert.equal(ring.length, 33);
    assert.deepEqual(ring[0], ring[ring.length - 1]);
    for (const pos of ring) {
      const d = haversineMeters([f.lng, f.lat], pos);
      assert.ok(Math.abs(d - 100) < 2, `ring point at ${d} m`);
    }
  });
});

describe("gps-tracking fix filtering", () => {
  it("always logs the first fix passing the accuracy gate", () => {
    assert.equal(shouldLogFix(null, fix(), DEFAULT_GPS_SETTINGS), true);
  });

  it("applies the accuracy gate to logging and capture", () => {
    const s = { ...DEFAULT_GPS_SETTINGS, maxAccuracyM: 10 };
    assert.equal(shouldLogFix(null, fix({ accuracy: 50 }), s), false);
    assert.equal(fixMeetsAccuracy(fix({ accuracy: 50 }), s), false);
    assert.equal(fixMeetsAccuracy(fix({ accuracy: 5 }), s), true);
    // 0 disables the gate.
    assert.equal(fixMeetsAccuracy(fix({ accuracy: 50 }), DEFAULT_GPS_SETTINGS), true);
  });

  it("enforces the minimum time between logged fixes", () => {
    const s = { ...DEFAULT_GPS_SETTINGS, minTimeS: 10 };
    const prev = fix();
    const soon = fix({ timestamp: prev.timestamp + 5_000 });
    const later = fix({ timestamp: prev.timestamp + 10_000 });
    assert.equal(shouldLogFix(prev, soon, s), false);
    assert.equal(shouldLogFix(prev, later, s), true);
  });

  it("enforces the minimum distance between logged fixes", () => {
    const s = { ...DEFAULT_GPS_SETTINGS, minDistanceM: 50 };
    const prev = fix();
    const near = fix({ lat: prev.lat + 0.0001, timestamp: prev.timestamp + 1 }); // ~11 m
    const far = fix({ lat: prev.lat + 0.001, timestamp: prev.timestamp + 1 }); // ~111 m
    assert.equal(shouldLogFix(prev, near, s), false);
    assert.equal(shouldLogFix(prev, far, s), true);
  });

  it("requires every active filter to pass when combined (AND semantics)", () => {
    const s = { ...DEFAULT_GPS_SETTINGS, minTimeS: 10, minDistanceM: 50 };
    const prev = fix();
    const farButSoon = fix({
      lat: prev.lat + 0.001, // ~111 m
      timestamp: prev.timestamp + 5_000,
    });
    const lateButNear = fix({
      lat: prev.lat + 0.0001, // ~11 m
      timestamp: prev.timestamp + 20_000,
    });
    const farAndLate = fix({
      lat: prev.lat + 0.001,
      timestamp: prev.timestamp + 20_000,
    });
    assert.equal(shouldLogFix(prev, farButSoon, s), false);
    assert.equal(shouldLogFix(prev, lateButNear, s), false);
    assert.equal(shouldLogFix(prev, farAndLate, s), true);
  });
});

describe("gps-tracking track shaping", () => {
  const fixes: GpsFix[] = [
    fix({ lat: 44.05, altitude: 120, timestamp: 1_700_000_000_000 }),
    fix({ lat: 44.051, altitude: 121, timestamp: 1_700_000_030_000 }),
    fix({ lat: 44.052, altitude: null, timestamp: 1_700_000_060_000 }),
  ];

  it("trackStats sums distances within a segment and spans the timestamps", () => {
    const stats = trackStats([fixes]);
    assert.equal(stats.pointCount, 3);
    assert.equal(stats.durationS, 60);
    assert.ok(Math.abs(stats.distanceM - 222.4) < 2, `got ${stats.distanceM}`);
  });

  it("trackStats does not count the gap between segments as distance", () => {
    // Two segments ~1.1 km apart; only intra-segment distance (~111 m each)
    // counts, while duration still spans the pause.
    const stats = trackStats([
      [
        fix({ lat: 44.0, timestamp: 1_700_000_000_000 }),
        fix({ lat: 44.001, timestamp: 1_700_000_030_000 }),
      ],
      [
        fix({ lat: 44.01, timestamp: 1_700_000_600_000 }),
        fix({ lat: 44.011, timestamp: 1_700_000_630_000 }),
      ],
    ]);
    assert.equal(stats.pointCount, 4);
    assert.equal(stats.durationS, 630);
    assert.ok(Math.abs(stats.distanceM - 222.4) < 2, `got ${stats.distanceM}`);
  });

  it("lineSegments drops stray 0/1-point segments; trackPointCount counts all", () => {
    const segments = [[], [fix()], fixes];
    assert.equal(lineSegments(segments).length, 1);
    assert.equal(trackPointCount(segments), 4);
  });

  it("trackFeature (single segment) is a LineString with altitude, flat times, and summary props", () => {
    const feature = trackFeature([fixes]);
    const line = feature.geometry as LineString;
    assert.equal(line.type, "LineString");
    assert.equal(line.coordinates.length, 3);
    assert.equal(line.coordinates[0].length, 3);
    assert.equal(line.coordinates[0][2], 120);
    assert.equal(line.coordinates[2].length, 2);
    assert.equal(feature.properties?.point_count, 3);
    assert.equal(feature.properties?.segment_count, 1);
    assert.equal(feature.properties?.duration_s, 60);
    assert.equal(feature.properties?.start_time, "2023-11-14T22:13:20.000Z");
    assert.equal(feature.properties?.end_time, "2023-11-14T22:14:20.000Z");
    assert.deepEqual(feature.properties?.times, [
      "2023-11-14T22:13:20.000Z",
      "2023-11-14T22:13:50.000Z",
      "2023-11-14T22:14:20.000Z",
    ]);
  });

  it("trackFeature (multiple segments) is a MultiLineString with nested times", () => {
    const other: GpsFix[] = [
      fix({ lat: 44.06, timestamp: 1_700_000_120_000 }),
      fix({ lat: 44.061, timestamp: 1_700_000_150_000 }),
    ];
    const feature = trackFeature([fixes, [fix()], other]);
    const multi = feature.geometry as MultiLineString;
    assert.equal(multi.type, "MultiLineString");
    assert.equal(multi.coordinates.length, 2);
    assert.equal(multi.coordinates[0].length, 3);
    assert.equal(multi.coordinates[1].length, 2);
    assert.equal(feature.properties?.point_count, 5);
    assert.equal(feature.properties?.segment_count, 2);
    const times = feature.properties?.times as string[][];
    assert.equal(times.length, 2);
    assert.equal(times[0].length, 3);
    assert.equal(times[1].length, 2);
  });

  it("trackFeatureCollection wraps the single track feature", () => {
    const fc = trackFeatureCollection([fixes]);
    assert.equal(fc.features.length, 1);
    assert.equal(fc.features[0].geometry.type, "LineString");
  });

  it("trackPreview renders one bare line per drawable segment", () => {
    const preview = trackPreview([fixes, [fix()], fixes]);
    assert.equal(preview.features.length, 2);
    for (const f of preview.features) {
      assert.equal(f.geometry.type, "LineString");
      assert.deepEqual(f.properties, {});
    }
  });

  it("capturePointFeature records time, accuracy, and optional motion props", () => {
    const f = capturePointFeature(fix({ accuracy: 7.25, speed: 1.5, heading: 90, altitude: 12 }));
    assert.deepEqual(f.geometry.coordinates, [-123.09, 44.05, 12]);
    assert.equal(f.properties?.accuracy_m, 7.3);
    assert.equal(f.properties?.speed_mps, 1.5);
    assert.equal(f.properties?.heading_deg, 90);
    assert.equal(f.properties?.ele, 12);
    assert.equal(f.properties?.time, "2023-11-14T22:13:20.000Z");
    const bare = capturePointFeature(fix());
    assert.equal("speed_mps" in (bare.properties ?? {}), false);
    assert.equal("heading_deg" in (bare.properties ?? {}), false);
  });
});

describe("gps-tracking GPX export", () => {
  it("serializes trackpoints with elevation and time", () => {
    const gpx = buildTrackGpx(
      [
        [
          fix({ altitude: 120, timestamp: 1_700_000_000_000 }),
          fix({ lat: 44.051, timestamp: 1_700_000_030_000 }),
        ],
      ],
      "Morning walk",
    );
    assert.ok(gpx.startsWith(`<?xml version="1.0" encoding="UTF-8"?>`));
    assert.ok(gpx.includes(`<gpx version="1.1"`));
    assert.ok(gpx.includes(`<name>Morning walk</name>`));
    assert.ok(gpx.includes(`<trkpt lat="44.05" lon="-123.09">`));
    assert.ok(gpx.includes(`<ele>120</ele>`));
    assert.ok(gpx.includes(`<time>2023-11-14T22:13:20.000Z</time>`));
    // The second fix has no altitude, so exactly one <ele> is written.
    assert.equal(gpx.split("<ele>").length, 2);
    assert.equal(gpx.split("<trkseg>").length, 2);
  });

  it("writes one trkseg per segment, skipping stray 1-point segments", () => {
    const seg = (lat: number, t: number) => [
      fix({ lat, timestamp: t }),
      fix({ lat: lat + 0.001, timestamp: t + 30_000 }),
    ];
    const gpx = buildTrackGpx(
      [seg(44.0, 1_700_000_000_000), [fix()], seg(44.1, 1_700_000_600_000)],
      "Segmented",
    );
    assert.equal(gpx.split("<trkseg>").length, 3);
    assert.equal(gpx.split("<trkpt").length, 5);
  });

  it("escapes XML in the track name", () => {
    const gpx = buildTrackGpx([[fix(), fix({ lat: 44.1 })]], `Trail <A> & "B"`);
    assert.ok(gpx.includes("<name>Trail &lt;A&gt; &amp; &quot;B&quot;</name>"));
  });
});

describe("gps-tracking misc", () => {
  it("fixFromPosition flattens coords and nulls NaN heading/speed", () => {
    const f = fixFromPosition({
      coords: {
        longitude: 1,
        latitude: 2,
        accuracy: 3,
        altitude: null,
        altitudeAccuracy: null,
        heading: Number.NaN,
        speed: null,
      },
      timestamp: 99,
    } as GeolocationPosition);
    assert.deepEqual(f, {
      lng: 1,
      lat: 2,
      accuracy: 3,
      altitude: null,
      heading: null,
      speed: null,
      timestamp: 99,
    });
  });

  it("isGpsCaptureLayer requires geojson type and the metadata flag", () => {
    assert.equal(isGpsCaptureLayer({ type: "geojson", metadata: { gpsCapture: true } }), true);
    assert.equal(isGpsCaptureLayer({ type: "tile", metadata: { gpsCapture: true } }), false);
    assert.equal(isGpsCaptureLayer({ type: "geojson", metadata: {} }), false);
  });

  it("formats distance, duration, and speed for the readouts", () => {
    assert.equal(formatDistance(873.4), "873 m");
    assert.equal(formatDistance(1240), "1.24 km");
    assert.equal(formatDuration(65), "1:05");
    assert.equal(formatDuration(3_725), "1:02:05");
    assert.equal(formatSpeedKmh(1.5), "5.4");
  });
});
