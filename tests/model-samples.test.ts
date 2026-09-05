import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHANGHAI_MODEL_SAMPLE,
  modelSampleBounds,
} from "../apps/geolibre-desktop/src/lib/model-samples";

test("Shanghai fits the complete city only at its registered placement", () => {
  const sample = SHANGHAI_MODEL_SAMPLE;
  assert.deepEqual(
    modelSampleBounds(sample.scenegraph, ...sample.location),
    [121.47, 31.22, 121.52, 31.25],
  );
  assert.equal(modelSampleBounds(sample.scenegraph, 0, 0), undefined);
  assert.equal(
    modelSampleBounds({ ...sample.scenegraph, sizeScale: 3000 }, ...sample.location),
    undefined,
  );
  assert.equal(
    modelSampleBounds({ ...sample.scenegraph, bearing: 45 }, ...sample.location),
    undefined,
  );
  assert.equal(
    modelSampleBounds({ ...sample.scenegraph, modelUrl: "custom.glb" }, ...sample.location),
    undefined,
  );
});
