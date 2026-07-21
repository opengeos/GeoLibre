import assert from "node:assert/strict";
import test from "node:test";
import {
  arcGISSceneViewToMapViewState,
  isSameArcGISSceneView,
  mapViewStateToArcGISSceneView,
} from "../packages/map/src/engine/arcgis-scene-camera";

const initial = {
  center: [8.55, 47.37] as [number, number],
  zoom: 8,
  bearing: -15,
  pitch: 35,
};

test("converts the store camera to documented SceneView navigation properties", () => {
  assert.deepEqual(mapViewStateToArcGISSceneView(initial), {
    center: [8.55, 47.37],
    zoom: 8,
    heading: -15,
    tilt: 35,
  });
  assert.equal(mapViewStateToArcGISSceneView({ ...initial, pitch: 100 }).tilt, 85);
});

test("reads the SceneView camera without flattening 3D pitch", () => {
  assert.deepEqual(
    arcGISSceneViewToMapViewState(
      {
        center: { longitude: 7.45, latitude: 46.95 },
        zoom: 11,
        camera: { heading: 350, tilt: 60 },
      },
      initial,
    ),
    {
      center: [7.45, 46.95],
      zoom: 11,
      bearing: -10,
      pitch: 60,
    },
  );
});

test("falls back for incomplete scene snapshots and only suppresses floating-point echoes", () => {
  assert.deepEqual(
    arcGISSceneViewToMapViewState(
      { center: {}, zoom: Number.NaN, camera: { heading: Number.NaN, tilt: Number.NaN } },
      initial,
    ),
    initial,
  );
  assert.equal(isSameArcGISSceneView(initial, { ...initial, zoom: 8 + 1e-8 }), true);
  assert.equal(isSameArcGISSceneView(initial, { ...initial, zoom: 8.001 }), false);
});
