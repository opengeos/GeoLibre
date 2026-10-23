import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  buildProfilePoints,
  fieldSeries,
  isSpaceborneLidarLayer,
  nearestProfileIndex,
  profileBeams,
  profileCsv,
  profileDots,
  profileFields,
  profileGapThreshold,
  profilePath,
  profilePresets,
  spaceborneLidarProduct,
} from "../apps/geolibre-desktop/src/lib/along-track-profile";

function footprint(id: number, beam: string, distance: number, extra: Record<string, unknown>) {
  return {
    type: "Feature" as const,
    id,
    geometry: { type: "Point" as const, coordinates: [-84 + distance / 100, 35] },
    properties: {
      beam,
      beam_type: beam.endsWith("l") ? "strong" : "weak",
      time: "2023-06-29T23:02:40.000Z",
      distance_km: distance,
      ...extra,
    },
  };
}

function layer(features: ReturnType<typeof footprint>[], overrides: Partial<GeoLibreLayer> = {}) {
  return {
    id: "L1",
    name: "ATL08 ATL08_20230629",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
    metadata: {},
    geojson: { type: "FeatureCollection", features },
    ...overrides,
  } as unknown as GeoLibreLayer;
}

const ATL08 = layer([
  footprint(0, "gt1l", 0.2, { h_te_best_fit: 300, h_canopy: 12 }),
  footprint(1, "gt1l", 0.1, { h_te_best_fit: 299, h_canopy: null }),
  footprint(2, "gt1r", 0.1, { h_te_best_fit: 310, h_canopy: 5 }),
  footprint(3, "gt1l", 0.3, { h_te_best_fit: null, h_canopy: null }),
  footprint(4, "gt1l", 5.0, { h_te_best_fit: 305, h_canopy: 20 }),
]);

describe("along-track profile layers", () => {
  it("recognizes tagged and untagged footprint layers", () => {
    assert.equal(
      isSpaceborneLidarLayer(
        layer([], { metadata: { sourceKind: "spaceborne-lidar" } } as Partial<GeoLibreLayer>),
      ),
      true,
    );
    assert.equal(isSpaceborneLidarLayer(ATL08), true);
    const plain = layer([]);
    (plain.geojson as { features: unknown[] }).features = [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { name: "x" },
      },
    ];
    assert.equal(isSpaceborneLidarLayer(plain), false);
  });

  it("reads the product from metadata or the default name", () => {
    assert.equal(spaceborneLidarProduct(ATL08), "ATL08");
    assert.equal(
      spaceborneLidarProduct(
        layer([], { name: "x", metadata: { product: "GEDI_L4A" } } as Partial<GeoLibreLayer>),
      ),
      "GEDI_L4A",
    );
    assert.equal(spaceborneLidarProduct(layer([], { name: "My shots" })), null);
  });

  it("lists beams with types and counts, and plottable fields", () => {
    assert.deepEqual(profileBeams(ATL08), [
      { name: "gt1l", type: "strong", count: 4 },
      { name: "gt1r", type: "weak", count: 1 },
    ]);
    assert.deepEqual(profileFields(ATL08), ["h_te_best_fit", "h_canopy"]);
  });
});

describe("along-track profile series", () => {
  it("offers ground and canopy top for ATL08, GEDI L2A and L2B", () => {
    const [preset] = profilePresets("ATL08", ["h_te_best_fit", "h_canopy"]);
    assert.equal(preset.id, "ground-canopy");
    assert.equal(preset.series[1].value({ h_te_best_fit: 300, h_canopy: 12 }), 312);
    assert.equal(preset.series[1].value({ h_te_best_fit: 300, h_canopy: null }), null);
    assert.equal(profilePresets("GEDI_L2A", ["elev_lowestmode", "rh98"])[0].id, "ground-canopy");
    assert.equal(profilePresets("GEDI_L2B", ["elev_lowestmode", "rh100"])[0].id, "ground-canopy");
    assert.equal(profilePresets("ATL06", ["h_li"])[0].id, "surface");
    // Missing fields or another product: no preset, Fields mode only.
    assert.deepEqual(profilePresets("ATL08", ["h_te_best_fit"]), []);
    assert.deepEqual(profilePresets("GEDI_L4A", ["agbd"]), []);
  });

  it("builds one beam's points sorted by distance with store feature ids", () => {
    const [preset] = profilePresets("ATL08", profileFields(ATL08));
    const points = buildProfilePoints(ATL08, "gt1l", preset.series);
    // The footprint with no values at all is dropped.
    assert.deepEqual(
      points.map((p) => [p.distance, p.featureId, ...p.values]),
      [
        [0.1, "1", 299, null],
        [0.2, "0", 300, 312],
        [5.0, "4", 305, 325],
      ],
    );
    assert.deepEqual(points[0].coordinates, [-84 + 0.001, 35]);
  });

  it("falls back to the feature index when a feature has no id", () => {
    const noIds = layer([footprint(9, "gt1l", 1, { h_li: 5 })]);
    delete (noIds.geojson!.features[0] as { id?: unknown }).id;
    assert.equal(buildProfilePoints(noIds, "gt1l", [fieldSeries("h_li")])[0].featureId, "0");
  });

  it("finds the nearest point by distance", () => {
    const points = buildProfilePoints(ATL08, "gt1l", [fieldSeries("h_te_best_fit")]);
    assert.equal(nearestProfileIndex(points, -1), 0);
    assert.equal(nearestProfileIndex(points, 0.16), 1);
    assert.equal(nearestProfileIndex(points, 3), 2);
    assert.equal(nearestProfileIndex(points, 99), 2);
    assert.equal(nearestProfileIndex([], 1), -1);
  });

  it("breaks the line at missing values and real gaps", () => {
    const [preset] = profilePresets("ATL08", profileFields(ATL08));
    const points = buildProfilePoints(ATL08, "gt1l", preset.series);
    const x = (d: number) => d * 10;
    const y = (v: number) => v;
    // Ground: 0.1 -> 0.2 connected, then a 4.8 km jump starts a new run.
    assert.equal(profilePath(points, 0, x, y, 1), "M1.0 299.0L2.0 300.0M50.0 305.0");
    // Canopy top: the first footprint has none, so the line starts at 0.2.
    assert.equal(profilePath(points, 1, x, y, 10), "M2.0 312.0L50.0 325.0");
  });

  it("sets the gap threshold from the typical spacing", () => {
    const evenly = layer(
      [0, 0.1, 0.2, 0.3, 2.0].map((d, i) => footprint(i, "gt1l", d, { h_li: 1 })),
    );
    const points = buildProfilePoints(evenly, "gt1l", [fieldSeries("h_li")]);
    assert.ok(Math.abs(profileGapThreshold(points) - 0.5) < 1e-9);
    assert.equal(profileGapThreshold(points.slice(0, 2)), Number.POSITIVE_INFINITY);
  });

  it("plots ATL03 photon heights as dots", () => {
    const [preset] = profilePresets("ATL03", ["h_ph", "signal_conf"]);
    assert.equal(preset.id, "photons");
    assert.equal(preset.dots, true);
    const photons = layer([
      footprint(0, "gt1l", 0.1, { h_ph: 5 }),
      footprint(1, "gt1l", 0.2, { h_ph: 7 }),
    ]);
    const points = buildProfilePoints(photons, "gt1l", preset.series);
    assert.equal(
      profileDots(
        points,
        0,
        (d) => d * 10,
        (v) => v,
        2,
      ),
      "M0.0 4.0h2v2h-2zM1.0 6.0h2v2h-2z",
    );
  });

  it("exports the plotted profile as CSV", () => {
    const [preset] = profilePresets("ATL08", profileFields(ATL08));
    const points = buildProfilePoints(ATL08, "gt1l", preset.series);
    const csv = profileCsv(points, ["Ground", "Canopy top"]);
    const lines = csv.trim().split("\n");
    assert.equal(lines[0], "distance_km,longitude,latitude,Ground,Canopy top");
    assert.equal(lines[1], "0.1,-83.999,35,299,");
    assert.equal(lines.length, 4);
  });
});
