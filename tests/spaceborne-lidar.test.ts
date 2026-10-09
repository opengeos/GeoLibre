import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadH5wasm } from "../packages/plugins/src/plugins/local-netcdf";
import {
  alongTrackKm,
  detectSpaceborneLidarProduct,
  openSpaceborneLidar,
} from "../packages/plugins/src/plugins/spaceborne-lidar";

/** The h5wasm write surface the fixtures need (the reader only types reads). */
interface WritableGroup {
  create_group(name: string): WritableGroup;
  create_dataset(args: { name: string; data: unknown; shape?: number[] }): WritableEntity;
  create_attribute(name: string, data: unknown): void;
}
interface WritableEntity {
  create_attribute(name: string, data: unknown): void;
}
interface WritableFile extends WritableGroup {
  close(): void;
}

let fixtureCounter = 0;

/**
 * Build an HDF5 file in h5wasm's in-memory filesystem and return its bytes, so
 * the tests need no binary fixtures on disk.
 */
async function buildHdf5(populate: (file: WritableGroup) => void): Promise<ArrayBuffer> {
  const mod = await loadH5wasm();
  const path = `spaceborne-fixture-${fixtureCounter++}.h5`;
  const file = new mod.File(path, "w") as unknown as WritableFile;
  populate(file);
  file.close();
  const fs = mod.FS as unknown as {
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  const bytes = fs.readFile(path);
  fs.unlink(path);
  return bytes.slice().buffer;
}

const F32_FILL = 3.4028235e38;

/**
 * A miniature ATL08: one strong beam crossing (0..3°E, 10°N) with four
 * segments, one of which has a fill terrain height, plus a weak beam whose
 * `land_segments` group is missing (as in granules over open water).
 */
function atl08(file: WritableGroup): void {
  file.create_attribute("short_name", "ATL08");
  const beam = file.create_group("gt1l");
  beam.create_attribute("atlas_beam_type", "strong");
  const seg = beam.create_group("land_segments");
  seg.create_dataset({ name: "latitude", data: new Float32Array([10, 10, 10, 10]) });
  seg.create_dataset({ name: "longitude", data: new Float32Array([0, 1, 2, 3]) });
  seg.create_dataset({ name: "delta_time", data: new Float64Array([0, 1, 2, 3.5]) });
  seg.create_dataset({ name: "night_flag", data: new Uint8Array([1, 1, 0, 0]) });
  const terrain = seg.create_group("terrain");
  terrain
    .create_dataset({
      name: "h_te_best_fit",
      data: new Float32Array([100.5, F32_FILL, 102.25, 103]),
    })
    .create_attribute("units", "meters");
  const canopy = seg.create_group("canopy");
  canopy.create_dataset({
    name: "h_canopy",
    data: new Float32Array([F32_FILL, 12.3, 15, 20]),
  });
  // A dataset of another length must not be offered as a footprint field.
  beam.create_group("signal_photons").create_dataset({
    name: "ph_h",
    data: new Float32Array([1, 2, 3, 4, 5, 6]),
  });
  const weak = file.create_group("gt1r");
  weak.create_attribute("atlas_beam_type", "weak");
}

/** A miniature GEDI L2A: a power beam with a 2-D `rh` and a quality flag. */
function gediL2a(file: WritableGroup): void {
  file.create_attribute("short_name", "GEDI_L2A");
  const beam = file.create_group("BEAM0101");
  beam.create_attribute("description", "Full power beam");
  beam.create_dataset({ name: "lat_lowestmode", data: new Float64Array([1, 1.001, 1.002]) });
  beam.create_dataset({ name: "lon_lowestmode", data: new Float64Array([179.999, -179.999, 5]) });
  beam.create_dataset({ name: "delta_time", data: new Float64Array([10, 11, 12]) });
  beam.create_dataset({ name: "quality_flag", data: new Uint8Array([1, 1, 0]) });
  beam.create_dataset({ name: "elev_lowestmode", data: new Float32Array([5, -9999, 7]) });
  // rh is (shots, 101): row i holds i*100 + percentile.
  const rh = new Float32Array(3 * 101);
  for (let i = 0; i < 3; i++) for (let p = 0; p <= 100; p++) rh[i * 101 + p] = i * 100 + p;
  beam.create_dataset({ name: "rh", data: rh, shape: [3, 101] });
  beam
    .create_dataset({
      name: "shot_number",
      data: new BigUint64Array([190000000000000001n, 190000000000000002n, 190000000000000003n]),
    })
    // A 64-bit fill that a float64 cannot tell apart from its neighbors.
    .create_attribute("_FillValue", new BigUint64Array([190000000000000002n]));
}

describe("detectSpaceborneLidarProduct", () => {
  it("prefers the short_name attribute", () => {
    assert.equal(detectSpaceborneLidarProduct("GEDI_L4A", "ATL08_x.h5"), "GEDI_L4A");
    assert.equal(detectSpaceborneLidarProduct("atl06"), "ATL06");
  });

  it("falls back to DAAC file names", () => {
    assert.equal(detectSpaceborneLidarProduct(undefined, "/d/ATL08_2023_007_01.h5"), "ATL08");
    assert.equal(
      detectSpaceborneLidarProduct(undefined, "GEDI_L4A_AGB_Density_V2_1.GEDI04_A_2022.h5"),
      "GEDI_L4A",
    );
    assert.equal(detectSpaceborneLidarProduct(undefined, "GEDI02_B_2022.h5"), "GEDI_L2B");
    assert.equal(detectSpaceborneLidarProduct("MOD09", "MOD09.hdf"), null);
  });
});

describe("alongTrackKm", () => {
  it("accumulates great-circle distance and skips invalid points", () => {
    const d = alongTrackKm([0, 0, Number.NaN, 0], [0, 1, 5, 2]);
    assert.equal(d[0], 0);
    // One degree of longitude on the equator is ~111.2 km.
    assert.ok(Math.abs(d[1] - 111.195) < 0.01, `got ${d[1]}`);
    assert.equal(d[2], d[1]);
    assert.ok(Math.abs(d[3] - 2 * 111.195) < 0.02, `got ${d[3]}`);
  });
});

describe("openSpaceborneLidar (ICESat-2 ATL08)", () => {
  it("lists beams with footprints and the product's fields", async () => {
    const file = await openSpaceborneLidar(await buildHdf5(atl08));
    try {
      assert.equal(file.product.id, "ATL08");
      assert.deepEqual(file.beams, [{ name: "gt1l", type: "strong", count: 4 }]);
      const fields = file.listFields();
      const defaults = fields.filter((f) => f.isDefault).map((f) => f.name);
      assert.deepEqual(defaults, ["h_te_best_fit", "h_canopy", "night_flag"]);
      assert.equal(fields.find((f) => f.name === "h_te_best_fit")?.units, "meters");
      // delta_time is aligned and numeric, so it is offered; photons are not.
      assert.ok(fields.some((f) => f.path === "land_segments/delta_time"));
      assert.ok(!fields.some((f) => f.path.startsWith("signal_photons")));
      assert.ok(!fields.some((f) => f.path === "land_segments/latitude"));
    } finally {
      file.close();
    }
  });

  it("drops fill terrain heights and nulls other fills", async () => {
    const file = await openSpaceborneLidar(await buildHdf5(atl08));
    try {
      const result = file.readFootprints();
      assert.equal(result.total, 4);
      assert.equal(result.matched, 3);
      const [first, , last] = result.geojson.features;
      assert.deepEqual(first.geometry.coordinates, [0, 10]);
      assert.equal(first.properties?.h_canopy, null);
      assert.equal(first.properties?.h_te_best_fit, 100.5);
      assert.equal(first.properties?.beam_type, "strong");
      assert.equal(first.properties?.time, "2018-01-01T00:00:00.000Z");
      assert.equal(last.properties?.time, "2018-01-01T00:00:03.500Z");
      // The skipped fill segment still counts toward distance along the track.
      assert.ok(Math.abs((last.properties?.distance_km as number) - 3 * 109.5) < 1);

      const unfiltered = file.readFootprints({ qualityFilter: false });
      assert.equal(unfiltered.matched, 4);
      assert.equal(unfiltered.geojson.features[1].properties?.h_te_best_fit, null);
      assert.equal(unfiltered.geojson.features[1].properties?.h_canopy, 12.3);
    } finally {
      file.close();
    }
  });

  it("filters by extent and thins evenly to maxPoints", async () => {
    const file = await openSpaceborneLidar(await buildHdf5(atl08));
    try {
      const boxed = file.readFootprints({ bbox: [1.5, 9, 3.5, 11] });
      assert.deepEqual(
        boxed.geojson.features.map((f) => f.geometry.coordinates[0]),
        [2, 3],
      );
      const thinned = file.readFootprints({ maxPoints: 2 });
      assert.equal(thinned.matched, 3);
      assert.equal(thinned.stride, 2);
      assert.deepEqual(
        thinned.geojson.features.map((f) => f.geometry.coordinates[0]),
        [0, 3],
      );
    } finally {
      file.close();
    }
  });
});

describe("openSpaceborneLidar (GEDI L2A)", () => {
  it("reads rh columns, GEDI fills, quality, and exact shot numbers", async () => {
    const file = await openSpaceborneLidar(await buildHdf5(gediL2a));
    try {
      assert.equal(file.product.id, "GEDI_L2A");
      assert.equal(file.beams[0].type, "power");
      const fields = [
        ...file.listFields().filter((f) => f.isDefault),
        { path: "shot_number", name: "shot_number" },
      ];
      const result = file.readFootprints({ fields });
      assert.equal(result.matched, 2);
      const [a, b] = result.geojson.features.map((f) => f.properties ?? {});
      assert.equal(a.rh98, 98);
      assert.equal(b.rh50, 150);
      assert.equal(a.elev_lowestmode, 5);
      assert.equal(b.elev_lowestmode, null);
      assert.equal(a.shot_number, "190000000000000001");
      assert.equal(b.shot_number, null);
    } finally {
      file.close();
    }
  });

  it("wraps an extent across the antimeridian", async () => {
    const file = await openSpaceborneLidar(await buildHdf5(gediL2a));
    try {
      const result = file.readFootprints({ bbox: [179, 0, -179, 2], qualityFilter: false });
      assert.equal(result.matched, 2);
      // The map reports the same view unwrapped, with east past 180.
      const unwrapped = file.readFootprints({ bbox: [179, 0, 181, 2], qualityFilter: false });
      assert.equal(unwrapped.matched, 2);
      const world = file.readFootprints({ bbox: [-200, -90, 200, 90], qualityFilter: false });
      assert.equal(world.matched, 3);
    } finally {
      file.close();
    }
  });
});

describe("openSpaceborneLidar 64-bit fills", () => {
  it("ignores a numeric fill past the safe-integer range", async () => {
    const bytes = await buildHdf5((file) => {
      file.create_attribute("short_name", "GEDI_L4A");
      const beam = file.create_group("BEAM0000");
      beam.create_dataset({ name: "lat_lowestmode", data: new Float64Array([0]) });
      beam.create_dataset({ name: "lon_lowestmode", data: new Float64Array([1]) });
      beam.create_dataset({ name: "delta_time", data: new Float64Array([0]) });
      beam
        .create_dataset({ name: "shot_number", data: new BigUint64Array([190000000000000001n]) })
        // Stored as a float64, this rounds to the same double as the shot above.
        .create_attribute("_FillValue", new Float64Array([190000000000000002]));
    });
    const file = await openSpaceborneLidar(bytes);
    try {
      const result = file.readFootprints({
        fields: [{ path: "shot_number", name: "shot_number" }],
      });
      assert.equal(result.geojson.features[0].properties?.shot_number, "190000000000000001");
    } finally {
      file.close();
    }
  });
});

describe("openSpaceborneLidar thinning", () => {
  it("caps the total across beams, not per beam", async () => {
    const bytes = await buildHdf5((file) => {
      file.create_attribute("short_name", "GEDI_L4A");
      for (const [name, lon] of [
        ["BEAM0000", 1],
        ["BEAM0101", 2],
      ] as const) {
        const beam = file.create_group(name);
        beam.create_dataset({ name: "lat_lowestmode", data: new Float64Array([0]) });
        beam.create_dataset({ name: "lon_lowestmode", data: new Float64Array([lon]) });
        beam.create_dataset({ name: "delta_time", data: new Float64Array([0]) });
        beam.create_dataset({ name: "agbd", data: new Float32Array([10]) });
      }
    });
    const file = await openSpaceborneLidar(bytes);
    try {
      const result = file.readFootprints({ maxPoints: 1 });
      assert.equal(result.matched, 2);
      assert.equal(result.stride, 2);
      assert.equal(result.kept, 1);
      assert.deepEqual(result.perBeam, [
        { beam: "BEAM0000", kept: 1 },
        { beam: "BEAM0101", kept: 0 },
      ]);
    } finally {
      file.close();
    }
  });
});

describe("openSpaceborneLidar errors", () => {
  it("rejects an HDF5 file that is not a supported product", async () => {
    const bytes = await buildHdf5((file) => file.create_attribute("short_name", "MOD09"));
    await assert.rejects(openSpaceborneLidar(bytes, "other.h5"), /found MOD09/);
  });

  it("rejects bytes that are not HDF5", async () => {
    await assert.rejects(openSpaceborneLidar(new Uint8Array([1, 2, 3]).buffer), /HDF5/);
  });
});
