import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadH5wasm } from "../packages/plugins/src/plugins/local-netcdf";
import { isAtl03Name, mergeAtl03Photons, openAtl03 } from "../packages/plugins/src/plugins/atl03";
import { splitBeams } from "../apps/geolibre-desktop/src/lib/atl03-client";

interface WritableGroup {
  create_group(name: string): WritableGroup;
  create_dataset(args: { name: string; data: unknown; shape?: number[] }): unknown;
  create_attribute(name: string, data: unknown): void;
}

let counter = 0;

/**
 * A miniature ATL03 in h5wasm's memory filesystem: beam gt1l with four 20 m
 * segments along 10°N (one empty), photons at lon 0.000, 0.0005, 0.001,
 * 0.0015, 0.002, 0.0025; plus a weak beam with no photons.
 */
async function atl03Path(shortName = "ATL03"): Promise<string> {
  const mod = await loadH5wasm();
  const path = `atl03-fixture-${counter++}.h5`;
  const file = new mod.File(path, "w") as unknown as WritableGroup & { close(): void };
  file.create_attribute("short_name", shortName);
  const beam = file.create_group("gt1l");
  beam.create_attribute("atlas_beam_type", "strong");
  const geo = beam.create_group("geolocation");
  geo.create_dataset({ name: "reference_photon_lat", data: new Float64Array([10, 10, 10, 10]) });
  geo.create_dataset({
    name: "reference_photon_lon",
    data: new Float64Array([0.0, 0.001, 0.0015, 0.002]),
  });
  // 1-based photon index of each segment's first photon; 0 = no photons.
  geo.create_dataset({ name: "ph_index_beg", data: new BigInt64Array([1n, 3n, 0n, 5n]) });
  geo.create_dataset({ name: "segment_ph_cnt", data: new Int32Array([2, 2, 0, 2]) });
  geo.create_dataset({
    name: "segment_dist_x",
    data: new Float64Array([1000, 1020, 1040, 1060]),
  });
  geo.create_dataset({ name: "delta_time", data: new Float64Array([1, 1.2, 1.3, 1.4]) });
  const heights = beam.create_group("heights");
  heights.create_dataset({
    name: "lat_ph",
    data: new Float64Array([10, 10, 10, 10, 10, 10]),
  });
  heights.create_dataset({
    name: "lon_ph",
    data: new Float64Array([0.0, 0.0005, 0.001, 0.0015, 0.002, 0.0025]),
  });
  heights.create_dataset({
    name: "h_ph",
    data: new Float32Array([100, 101, 102, 103, 104, 105]),
  });
  heights.create_dataset({
    name: "dist_ph_along",
    data: new Float32Array([0, 10, 0, 10, 0, 10]),
  });
  heights.create_dataset({
    name: "delta_time",
    data: new Float64Array([1, 1.1, 1.2, 1.3, 1.4, 1.5]),
  });
  heights.create_dataset({ name: "quality_ph", data: new Int8Array([0, 0, 0, 0, 0, 0]) });
  // [photons, 5] row-major: land confidence first, ocean second.
  heights.create_dataset({
    name: "signal_conf_ph",
    data: new Int8Array([
      4,
      0,
      0,
      0,
      0, //
      0,
      4,
      0,
      0,
      0, //
      3,
      1,
      0,
      0,
      0, //
      2,
      2,
      0,
      0,
      0, //
      1,
      3,
      0,
      0,
      0, //
      4,
      4,
      0,
      0,
      0,
    ]),
    shape: [6, 5],
  });
  const weak = file.create_group("gt1r");
  weak.create_attribute("atlas_beam_type", "weak");
  weak.create_group("heights").create_dataset({ name: "h_ph", data: new Float32Array([]) });
  file.close();
  return path;
}

describe("ATL03 photons", () => {
  it("recognizes ATL03 names", () => {
    assert.equal(isAtl03Name("ATL03_20251125050210_10942906_007_01.h5"), true);
    assert.equal(isAtl03Name("https://x/ATL03_2025.h5?sig=1"), true);
    assert.equal(isAtl03Name("ATL08_2025.h5"), false);
  });

  it("lists ground tracks with photons", async () => {
    const mod = await loadH5wasm();
    const file = openAtl03(mod, await atl03Path());
    assert.deepEqual(file.beams, [{ name: "gt1l", type: "strong", photons: 6 }]);
    file.close();
  });

  it("reads photons in the bbox, filtered by signal confidence", async () => {
    const mod = await loadH5wasm();
    const file = openAtl03(mod, await atl03Path());
    const r = file.readPhotons({ bbox: [-0.0001, 9.9, 0.0021, 10.1] });
    // Land confidence >= 2 keeps photons 0, 2 and 3; photon 5 is outside the bbox.
    assert.deepEqual(
      r.geojson.features.map((f) => f.properties.h_ph),
      [100, 102, 103],
    );
    assert.equal(r.matched, 3);
    const first = r.geojson.features[0];
    assert.equal(first.id, 0);
    assert.equal(first.properties.beam, "gt1l");
    assert.equal(first.properties.beam_type, "strong");
    assert.equal(first.properties.signal_conf, 4);
    assert.equal(first.properties.time, "2018-01-01T00:00:01.000Z");
    // Along-track: segment start + distance into the segment, from the first photon.
    assert.deepEqual(
      r.geojson.features.map((f) => f.properties.distance_km),
      [0, 0.02, 0.03],
    );
    file.close();
  });

  it("tests another surface's confidence and lower thresholds", async () => {
    const mod = await loadH5wasm();
    const file = openAtl03(mod, await atl03Path());
    const ocean = file.readPhotons({ bbox: [-1, 9, 1, 11], surface: "ocean", minConfidence: 3 });
    assert.deepEqual(
      ocean.geojson.features.map((f) => f.properties.h_ph),
      [101, 104, 105],
    );
    const all = file.readPhotons({ bbox: [-1, 9, 1, 11], minConfidence: 0 });
    assert.equal(all.kept, 6);
    file.close();
  });

  it("thins evenly to max points and skips bboxes with no segment", async () => {
    const mod = await loadH5wasm();
    const file = openAtl03(mod, await atl03Path());
    const capped = file.readPhotons({ bbox: [-1, 9, 1, 11], minConfidence: 0, maxPoints: 3 });
    assert.equal(capped.stride, 2);
    assert.deepEqual(
      capped.geojson.features.map((f) => f.properties.h_ph),
      [100, 102, 104],
    );
    const elsewhere = file.readPhotons({ bbox: [20, 20, 21, 21] });
    assert.equal(elsewhere.kept, 0);
    assert.deepEqual(elsewhere.perBeam, []);
    file.close();
  });

  it("merges parts read by several workers and thins across them", async () => {
    const mod = await loadH5wasm();
    const file = openAtl03(mod, await atl03Path());
    const part = file.readPhotons({ bbox: [-1, 9, 1, 11], minConfidence: 0 });
    const merged = mergeAtl03Photons([part, part], 6);
    assert.equal(merged.matched, 12);
    assert.equal(merged.stride, 2);
    assert.equal(merged.kept, 6);
    assert.deepEqual(
      merged.geojson.features.map((f) => f.id),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(merged.perBeam, [
      { beam: "gt1l", kept: 3 },
      { beam: "gt1l", kept: 3 },
    ]);
    file.close();
  });

  it("splits beams into contiguous groups", () => {
    const beams = ["gt1l", "gt1r", "gt2l", "gt2r", "gt3l", "gt3r"];
    assert.deepEqual(
      splitBeams(beams, 6),
      beams.map((b) => [b]),
    );
    assert.deepEqual(splitBeams(beams, 4), [
      ["gt1l"],
      ["gt1r", "gt2l"],
      ["gt2r"],
      ["gt3l", "gt3r"],
    ]);
    assert.deepEqual(splitBeams(["gt1l"], 6), [["gt1l"]]);
  });

  it("refuses another product", async () => {
    const mod = await loadH5wasm();
    const path = await atl03Path("ATL08");
    assert.throws(() => openAtl03(mod, path), /ATL08 granule, not ATL03/);
  });
});
