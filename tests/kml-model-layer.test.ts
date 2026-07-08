import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  kmlModelBounds,
  kmlModelDisplayName,
  kmlModelRow,
  kmlModelUniformScale,
  modelNameFromPath,
} from "../apps/geolibre-desktop/src/lib/kml-model";
import type { LoadedModel } from "../apps/geolibre-desktop/src/lib/tauri-io";

function model(patch: Partial<LoadedModel> = {}): LoadedModel {
  return {
    kind: "model",
    name: "House",
    path: "town.kmz",
    url: "data:model/gltf-binary;base64,AAAA",
    longitude: -100,
    latitude: 40,
    altitude: 12,
    heading: 45,
    tilt: 0,
    roll: 0,
    scale: { x: 1, y: 1, z: 1 },
    radiusMeters: 0,
    ...patch,
  };
}

describe("kmlModelUniformScale", () => {
  it("returns a uniform scale unchanged", () => {
    assert.equal(kmlModelUniformScale({ x: 3, y: 3, z: 3 }), 3);
  });

  it("averages a non-uniform scale", () => {
    assert.equal(kmlModelUniformScale({ x: 2, y: 4, z: 6 }), 4);
  });

  it("falls back to 1 for a non-positive average", () => {
    assert.equal(kmlModelUniformScale({ x: 0, y: 0, z: 0 }), 1);
    assert.equal(kmlModelUniformScale({ x: -1, y: -1, z: -1 }), 1);
  });
});

describe("kmlModelRow", () => {
  it("maps location, altitude, heading, and scale into one row", () => {
    assert.deepEqual(kmlModelRow(model()), {
      lng: -100,
      lat: 40,
      altitude: 12,
      bearing: 45,
      scale: 1,
    });
  });
});

describe("kmlModelBounds", () => {
  it("pads a point extent that brackets the model location", () => {
    const [w, s, e, n] = kmlModelBounds(model());
    assert.ok(w < -100 && e > -100, "extent brackets the longitude");
    assert.ok(s < 40 && n > 40, "extent brackets the latitude");
  });

  it("grows the extent to frame a large model", () => {
    // A ~33 km-radius model (e.g. a geological cross-section) should get an
    // extent far wider than the point-pad fallback so it frames on load.
    const [w, s, e, n] = kmlModelBounds(model({ radiusMeters: 33_000 }));
    const [w0, s0] = kmlModelBounds(model({ radiusMeters: 0 }));
    assert.ok(e - w > 0.5, "longitude extent spans the model's width");
    assert.ok(n - s > 0.5, "latitude extent spans the model's height");
    assert.ok(w < w0 && s < s0, "large extent is wider than the point pad");
  });

  it("falls back to the point pad for a model with no known extent", () => {
    const [w, s, e, n] = kmlModelBounds(model({ radiusMeters: 0 }));
    assert.ok(Math.abs(e - w - 0.004) < 1e-9, "longitude pad is 2 * minPad");
    assert.ok(Math.abs(n - s - 0.004) < 1e-9, "latitude pad is 2 * minPad");
  });
});

describe("model naming", () => {
  it("strips the directory and extension", () => {
    assert.equal(modelNameFromPath("a/b/town.kmz"), "town");
    assert.equal(modelNameFromPath("model.dae"), "model");
  });

  it("keeps the model name when present", () => {
    assert.equal(kmlModelDisplayName(model()), "House");
  });

  it("falls back to a path-derived name when unnamed", () => {
    assert.equal(kmlModelDisplayName(model({ name: "" })), "town model");
  });
});
