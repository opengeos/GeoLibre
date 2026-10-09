import "./helpers/dom";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { writeArrayBuffer } from "geotiff";
import { useAppStore } from "@geolibre/core";
import {
  computeContextFeatures,
  inheritClasses,
} from "../apps/geolibre-desktop/src/lib/obia/obia-context";
import {
  emptyObiaSession,
  useObiaSession,
  type ObiaLevelRecord,
  type ObiaSegmentationRun,
} from "../apps/geolibre-desktop/src/lib/obia/obia-session";

const env = { engineVersion: "1.5.9", appVersion: "3.3.0" };

/** A 4 x 1 label raster: objects 1, 2, 3, 4 left to right. */
const labels = new Uint8Array(
  writeArrayBuffer(new Float32Array([1, 2, 3, 4]), {
    width: 4,
    height: 1,
    ModelPixelScale: [10, 10, 0],
    ModelTiepoint: [0, 0, 0, 500000, 4000000, 0],
    ProjectedCSTypeGeoKey: 32617,
    GTModelTypeGeoKey: 1,
  } as Parameters<typeof writeArrayBuffer>[1]) as ArrayBuffer,
);

/** Objects with ids and parents: 1, 2 under parent 1; 3, 4 under parent 2. */
function objects(parents: boolean): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [1, 2, 3, 4].map((id) => ({
      type: "Feature" as const,
      id,
      properties: { segment_id: id, ...(parents ? { obia_parent: id <= 2 ? 1 : 2 } : {}) },
      geometry: { type: "Point" as const, coordinates: [id, 0] },
    })),
  };
}

const run = (
  objectsLayerId: string,
  merge?: ObiaSegmentationRun["merge"],
): ObiaSegmentationRun => ({
  sourceLayerId: "image",
  sourceName: "image.tif",
  source: { name: "image.tif" },
  bandIndexes: [1],
  width: 4,
  height: 1,
  labels,
  objectsLayerId,
  objectCount: 4,
  meanObjectArea: 1,
  tool: "image_segmentation",
  args: [],
  params: { threshold: 0.8, minArea: 1, steps: 10 },
  env,
  finishedAt: `${objectsLayerId}-at`,
  ...(merge ? { merge } : {}),
});

beforeEach(() => {
  const id = useAppStore.getState().addGeoJsonLayer("level 1", objects(true));
  // A level-1 session whose level 2 is classified.
  const level2: ObiaLevelRecord = {
    level: 2,
    segmentation: run("level2", { fromLevel: 1, scale: 10, bands: [1] }),
    features: {
      segmentationAt: "level2-at",
      table: {
        fields: ["mean_b1", "area_px"],
        rows: new Map([
          [1, { mean_b1: 15, area_px: 2 }],
          [2, { mean_b1: 85, area_px: 2 }],
        ]),
      },
      options: { spectral: true, shape: false, context: false },
      calls: [],
      env,
      finishedAt: "level2-features",
    },
    classification: {
      predictions: new Map([
        [1, "water"],
        [2, "trees, shrubs"],
      ]),
      fields: [],
      imputed: {},
      trainingCount: 0,
      call: { tool: "x", args: [] },
      settings: { ...emptyObiaSession().classifier },
      featuresAt: "level2-features",
      env,
      finishedAt: "level2-classified",
    },
    splits: [],
  };
  useObiaSession.getState().restore({
    ...emptyObiaSession(),
    classes: [
      { name: "water", color: "#00f" },
      { name: "trees, shrubs", color: "#0f0" },
    ],
    segmentation: run(id),
    features: {
      segmentationAt: `${id}-at`,
      table: {
        fields: ["mean_b1", "area_px", "parent_mean_b9"],
        rows: new Map(
          [1, 2, 3, 4].map((n) => [n, { mean_b1: n * 10, area_px: 1, parent_mean_b9: 0 }]),
        ),
      },
      options: { spectral: true, shape: false, context: false },
      calls: [],
      env,
      finishedAt: "level1-features",
    },
    level: 1,
    levels: [level2],
  });
});

describe("OBIA context features and class inheritance", () => {
  it("inherits each object's parent class", () => {
    const result = inheritClasses("unclassified");
    assert.deepEqual(
      [...result.predictions],
      [
        [1, "water"],
        [2, "water"],
        [3, "trees, shrubs"],
        [4, "trees, shrubs"],
      ],
    );
    assert.equal(result.call.tool, "obia/inherit");
  });

  it("adds neighbor contrast and parent features, replacing earlier context fields", async () => {
    const { table, added } = await computeContextFeatures();
    assert.ok(!table.fields.includes("parent_mean_b9"), "earlier context fields are replaced");
    assert.deepEqual(added, [
      "nb_contrast_b1",
      "parent_mean_b1",
      "parent_area_px",
      "parent_is_water",
      "parent_is_trees_shrubs",
    ]);
    // Object 2 (20) between 1 (10) and 3 (30): no contrast.
    assert.equal(table.rows.get(2)?.nb_contrast_b1, 0);
    assert.equal(table.rows.get(3)?.parent_mean_b1, 85);
    assert.equal(table.rows.get(3)?.parent_is_trees_shrubs, 1);
    assert.equal(table.rows.get(1)?.mean_b1, 10, "measured fields are kept");
  });
});

describe("OBIA context features and the classification", () => {
  it("clears a classification that reads a field the new table drops", () => {
    const session = useObiaSession.getState();
    session.setClassification({
      predictions: new Map([[1, "water"]]),
      fields: ["parent_is_water"],
      imputed: {},
      trainingCount: 1,
      call: { tool: "x", args: [] },
      settings: { ...emptyObiaSession().classifier, method: "random-forest" },
      featuresAt: "level1-features",
      env,
      finishedAt: "now",
    });
    const call = { tool: "obia/context", args: [] };
    useObiaSession
      .getState()
      .extendFeatures({ fields: ["mean_b1", "parent_is_water"], rows: new Map() }, call);
    assert.ok(useObiaSession.getState().classification, "kept while its fields remain");
    useObiaSession.getState().extendFeatures({ fields: ["mean_b1"], rows: new Map() }, call);
    assert.equal(useObiaSession.getState().classification, null);
  });
});
