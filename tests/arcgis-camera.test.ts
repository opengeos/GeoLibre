import assert from "node:assert/strict";
import test from "node:test";
import {
  arcGISViewToMapViewState,
  isSameArcGISMapView,
  mapViewStateToArcGISView,
  normalizeArcGISRotation,
} from "../packages/map/src/engine/arcgis-camera";

const initial = {
  center: [8.55, 47.37] as [number, number],
  zoom: 8,
  bearing: -15,
  pitch: 35,
};

test("normalizes ArcGIS rotations into the shared bearing range", () => {
  assert.equal(normalizeArcGISRotation(270), -90);
  assert.equal(normalizeArcGISRotation(-270), 90);
  assert.equal(normalizeArcGISRotation(180), 180);
});

test("converts a store camera to ArcGIS MapView properties", () => {
  assert.deepEqual(mapViewStateToArcGISView(initial), {
    center: [8.55, 47.37],
    zoom: 8,
    rotation: -15,
  });
});

test("reads ArcGIS MapView state without discarding the store pitch", () => {
  assert.deepEqual(
    arcGISViewToMapViewState(
      {
        center: { longitude: 7.45, latitude: 46.95 },
        zoom: 11,
        rotation: 350,
      },
      initial,
    ),
    {
      center: [7.45, 46.95],
      zoom: 11,
      bearing: -10,
      pitch: 35,
    },
  );
});

test("uses the stored view for an incomplete ArcGIS snapshot", () => {
  assert.deepEqual(
    arcGISViewToMapViewState({ center: {}, zoom: Number.NaN, rotation: Number.NaN }, initial),
    initial,
  );
});

test("tolerates only floating-point camera echoes", () => {
  assert.equal(isSameArcGISMapView(initial, { ...initial, zoom: 8 + 1e-8 }), true);
  assert.equal(isSameArcGISMapView(initial, { ...initial, zoom: 8.001 }), false);
});
