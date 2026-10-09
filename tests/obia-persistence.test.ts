import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  applyProjectToStore,
  createEmptyProject,
  normalizeObiaWorkbench,
  parseProject,
  serializeProject,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  OBIA_STATE_VERSION,
  featureTableFromObjects,
  predictionsFromObjects,
  restoreObiaSession,
  snapshotObiaSession,
} from "../apps/geolibre-desktop/src/lib/obia/obia-persistence";
import {
  boundsWindow,
  planObiaArea,
  wholeImageWindow,
  type ObiaSourceInfo,
} from "../apps/geolibre-desktop/src/lib/obia/obia-source";
import {
  emptyObiaSession,
  type ObiaSessionData,
} from "../apps/geolibre-desktop/src/lib/obia/obia-session";

const env = { engineVersion: "1.5.9", appVersion: "3.3.0" };

/** An objects layer as the workbench leaves it: features and predictions on it. */
function objectsLayer(): GeoLibreLayer {
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [1, 2].map((id) => ({
      type: "Feature" as const,
      id,
      properties: {
        segment_id: id,
        mean_b1: id * 10,
        ndvi: id === 1 ? 0.5 : null,
        obia_class: id === 1 ? "tree" : undefined,
        obia_sample: id === 1 ? "training" : undefined,
        obia_predicted: id === 1 ? "tree" : "roof",
      },
      geometry: { type: "Point" as const, coordinates: [id, 0] },
    })),
  };
  return {
    id: "objects",
    name: "image objects",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: {},
    geojson,
  } as GeoLibreLayer;
}

/** A session that has segmented, measured, split and classified. */
function fullSession(): ObiaSessionData {
  const layer = objectsLayer();
  return {
    ...emptyObiaSession(),
    sourceLayerId: "image",
    bandIndexes: [1, 4],
    params: { threshold: 0.6, minArea: 40, steps: 10 },
    classes: [
      { name: "tree", color: "#16a34a" },
      { name: "roof", color: "#dc2626" },
    ],
    segmentation: {
      sourceLayerId: "image",
      sourceName: "naip.tif",
      source: { name: "naip.tif", location: "/data/naip.tif" },
      bandIndexes: [1, 4],
      width: 600,
      height: 500,
      labels: new Uint8Array([1, 2, 3]),
      objectsLayerId: layer.id,
      objectCount: 2,
      meanObjectArea: 150000,
      tool: "image_segmentation",
      args: ["--inputs=/work/band_1.tif,/work/band_4.tif", "--threshold=0.6"],
      params: { threshold: 0.6, minArea: 40, steps: 10 },
      env,
      finishedAt: "2026-10-09T10:00:00.000Z",
    },
    features: {
      segmentationAt: "2026-10-09T10:00:00.000Z",
      table: featureTableFromObjects(layer.geojson!, ["mean_b1", "ndvi"]),
      options: { spectral: true, shape: false, context: false, indices: { red: 1, nir: 4 } },
      calls: [{ tool: "object_features_spectral_basic", args: ["--segments=/work/segments.tif"] }],
      env,
      finishedAt: "2026-10-09T10:01:00.000Z",
    },
    splits: [{ fraction: 0.3, seed: 42, moved: 1, at: "2026-10-09T10:02:00.000Z" }],
    classification: {
      predictions: predictionsFromObjects(layer.geojson!),
      fields: ["mean_b1", "ndvi"],
      imputed: { ndvi: 1 },
      trainingCount: 1,
      call: { tool: "classify_objects_random_forest", args: ["--n_trees=100"] },
      settings: { ...emptyObiaSession().classifier, trees: 100 },
      featuresAt: "2026-10-09T10:01:00.000Z",
      env,
      finishedAt: "2026-10-09T10:03:00.000Z",
    },
  };
}

describe("OBIA workbench persistence", () => {
  it("saves nothing until the workbench has been used", () => {
    assert.equal(snapshotObiaSession(emptyObiaSession()), null);
  });

  it("saves settings and provenance, but not labels, tables or predictions", () => {
    const saved = snapshotObiaSession(fullSession())!;
    assert.equal(saved.version, OBIA_STATE_VERSION);
    const json = JSON.stringify(saved);
    assert.ok(!json.includes('"labels"'), "the label raster is rebuilt, not saved");
    assert.ok(!json.includes('"predictions"'), "predictions live on the objects layer");
    assert.ok(!json.includes('"rows"'), "feature values live on the objects layer");
    const runs = saved.runs as Record<string, Record<string, unknown>>;
    assert.equal(runs.segmentation.tool, "image_segmentation");
    assert.deepEqual(runs.segmentation.env, env);
    assert.deepEqual(runs.features.fields, ["mean_b1", "ndvi"]);
    assert.deepEqual(runs.splits, [
      { fraction: 0.3, seed: 42, moved: 1, at: "2026-10-09T10:02:00.000Z" },
    ]);
  });

  it("restores the session, rebuilding features and predictions from the layer", () => {
    const original = fullSession();
    const saved = JSON.parse(JSON.stringify(snapshotObiaSession(original)));
    const restored = restoreObiaSession(saved, [objectsLayer()]);
    assert.equal(restored.segmentation?.labels, null);
    assert.equal(restored.segmentation?.objectCount, 2);
    assert.deepEqual(restored.segmentation?.source, original.segmentation!.source);
    assert.deepEqual([...restored.features!.table.rows], [...original.features!.table.rows]);
    assert.deepEqual(
      [...restored.classification!.predictions],
      [
        [1, "tree"],
        [2, "roof"],
      ],
    );
    assert.deepEqual(restored.classes, original.classes);
    assert.deepEqual(restored.params, original.params);
    // Restoring and saving again gives the same project content.
    assert.deepEqual(snapshotObiaSession(restored), saved);
  });

  it("drops runs whose objects layer is gone, keeping the settings", () => {
    const saved = snapshotObiaSession(fullSession());
    const restored = restoreObiaSession(saved, []);
    assert.equal(restored.segmentation, null);
    assert.equal(restored.features, null);
    assert.equal(restored.classification, null);
    assert.deepEqual(restored.bandIndexes, [1, 4]);
    assert.equal(restored.classes.length, 2);
  });

  it("keeps batch runs while their objects layer exists", () => {
    const batch = {
      targetLayerId: "image-2",
      source: { name: "naip-2.tif", location: "/data/naip-2.tif" },
      objectsLayerId: "objects",
      objectCount: 2,
      classCounts: { tree: 1, roof: 1 },
      calls: [{ tool: "image_segmentation", args: ["--threshold=0.6"] }],
      env,
      finishedAt: "2026-10-09T10:05:00.000Z",
    };
    const saved = JSON.parse(
      JSON.stringify(snapshotObiaSession({ ...fullSession(), batches: [batch] })),
    );
    assert.deepEqual(restoreObiaSession(saved, [objectsLayer()]).batches, [batch]);
    const gone = { ...objectsLayer(), id: "other" } as GeoLibreLayer;
    const withoutBatch = restoreObiaSession(
      { ...saved, runs: { ...saved.runs, batches: [{ ...batch, objectsLayerId: "missing" }] } },
      [objectsLayer(), gone],
    );
    assert.deepEqual(withoutBatch.batches, []);
  });

  it("falls back to defaults for malformed or unknown saved state", () => {
    assert.deepEqual(restoreObiaSession({ version: 99 }, []), emptyObiaSession());
    const restored = restoreObiaSession(
      {
        version: OBIA_STATE_VERSION,
        settings: {
          params: { threshold: "high", minArea: 12 },
          classes: [{ name: "a" }, { name: "a" }, { color: "#000" }, 7],
          classifier: { method: "svm", rules: [{ field: "x", op: "=~", value: 1 }] },
          bandIndexes: [0, 2, "3"],
        },
      },
      [],
    );
    assert.deepEqual(restored.params, { threshold: 0.8, minArea: 12, steps: 10 });
    assert.deepEqual(restored.classes, [{ name: "a", color: "#64748b" }]);
    assert.equal(restored.classifier.method, "random-forest");
    assert.deepEqual(restored.classifier.rules, []);
    assert.deepEqual(restored.bandIndexes, [2]);
  });
  it("clamps saved numbers to the ranges the workbench allows", () => {
    const restored = restoreObiaSession(
      {
        version: OBIA_STATE_VERSION,
        settings: {
          params: { threshold: -3, minArea: 1e12, steps: 2.6 },
          classifier: { method: "random-forest", trees: 1e9 },
        },
      },
      [],
    );
    assert.deepEqual(restored.params, { threshold: 0.05, minArea: 16_777_216, steps: 3 });
    assert.equal(restored.classifier.trees, 1000);
  });
});

describe("OBIA read areas", () => {
  // A 1000 x 800 image with a 500 x 400 overview, 1 degree = 100 pixels,
  // its top-left corner at (10 E, 50 N).
  const info: ObiaSourceInfo = {
    levels: [
      { width: 1000, height: 800 },
      { width: 500, height: 400 },
    ],
    bandCount: 4,
    dataType: "UInt16",
    pixelSize: 10,
    unit: "m",
    toPixel: (lng, lat) => [(lng - 10) * 100, (50 - lat) * 100],
  };

  it("maps a map view to a clamped pixel window", () => {
    assert.deepEqual(boundsWindow(info, [11, 47, 12.5, 48]), [100, 200, 250, 300]);
    // Clamped to the image where the view runs past it.
    assert.deepEqual(boundsWindow(info, [9, 40, 30, 49]), [0, 100, 1000, 800]);
    assert.equal(boundsWindow(info, [30, 10, 31, 11]), null);
    assert.equal(boundsWindow({ ...info, toPixel: null }, [11, 47, 12, 48]), null);
    assert.equal(boundsWindow(info, [12, 47, 11, 48]), null, "reversed bounds are not a box");
  });

  it("falls back to an overview when the area is over the limit", () => {
    const whole = wholeImageWindow(info);
    assert.deepEqual(planObiaArea(info, whole), {
      area: { level: 0, window: [0, 0, 1000, 800] },
      width: 1000,
      height: 800,
      pixelSize: 10,
      fits: true,
    });
    // Over a 300,000-pixel limit at full resolution: the overview fits.
    assert.deepEqual(planObiaArea(info, whole, 300_000), {
      area: { level: 1, window: [0, 0, 1000, 800] },
      width: 500,
      height: 400,
      pixelSize: 20,
      fits: true,
    });
    // Over the limit even there: the coarsest level, flagged as not fitting.
    assert.deepEqual(planObiaArea(info, whole, 100_000), {
      area: { level: 1, window: [0, 0, 1000, 800] },
      width: 500,
      height: 400,
      pixelSize: 20,
      fits: false,
    });
  });

  it("round-trips a segmentation's area and drops a malformed one", () => {
    const session = fullSession();
    session.areaMode = "view";
    session.segmentation = {
      ...session.segmentation!,
      area: { level: 1, window: [10, 20, 610, 520] },
      pixelSize: 20,
    };
    const saved = JSON.parse(JSON.stringify(snapshotObiaSession(session)));
    const restored = restoreObiaSession(saved, [objectsLayer()]);
    assert.equal(restored.areaMode, "view");
    assert.deepEqual(restored.segmentation?.area, { level: 1, window: [10, 20, 610, 520] });
    assert.equal(restored.segmentation?.pixelSize, 20);
    saved.runs.segmentation.area = { level: -1, window: [0, 0, 5, 5] };
    assert.equal(restoreObiaSession(saved, [objectsLayer()]).segmentation?.area, undefined);
    saved.runs.segmentation.area = { level: 0, window: [5, 0, 5, 5] };
    assert.equal(restoreObiaSession(saved, [objectsLayer()]).segmentation?.area, undefined);
  });
});

describe("OBIA native segmentation settings", () => {
  it("saves the method and its parameters, but not the sidecar job", () => {
    const session = fullSession();
    session.method = "slic";
    session.nativeParams = { ...session.nativeParams, slic: { size: 250, compactness: 0.5 } };
    session.segmentation = {
      ...session.segmentation!,
      method: "slic",
      nativeParams: session.nativeParams,
      nativeJobId: "job-1",
    };
    const saved = JSON.parse(JSON.stringify(snapshotObiaSession(session)));
    assert.ok(!JSON.stringify(saved).includes("job-1"), "a sidecar job does not outlive it");
    const restored = restoreObiaSession(saved, [objectsLayer()]);
    assert.equal(restored.method, "slic");
    assert.deepEqual(restored.nativeParams.slic, { size: 250, compactness: 0.5 });
    assert.equal(restored.segmentation?.method, "slic");
    assert.equal(restored.segmentation?.nativeJobId, undefined);
  });

  it("clamps native parameters and drops an unknown method", () => {
    const restored = restoreObiaSession(
      {
        version: OBIA_STATE_VERSION,
        settings: {
          method: "watershed",
          nativeParams: { slic: { size: 1 }, felzenszwalb: { sigma: 99, minSize: 2.4 } },
        },
      },
      [],
    );
    assert.equal(restored.method, "region-growing");
    assert.equal(restored.nativeParams.slic.size, 4);
    assert.equal(restored.nativeParams.felzenszwalb.sigma, 20);
    assert.equal(restored.nativeParams.felzenszwalb.minSize, 2);
  });
});

describe("project obia field", () => {
  it("round-trips through save and load, and is omitted when unused", () => {
    const empty = createEmptyProject("plain");
    assert.ok(!("obia" in JSON.parse(serializeProject(empty))));
    const saved = snapshotObiaSession(fullSession())!;
    const project = parseProject(serializeProject({ ...empty, obia: saved }));
    assert.deepEqual(project.obia, saved);
    assert.deepEqual(applyProjectToStore(project).obiaWorkbench, saved);
  });

  it("drops a malformed obia value", () => {
    assert.equal(normalizeObiaWorkbench([1, 2]), null);
    assert.equal(normalizeObiaWorkbench({ settings: {} }), null);
    assert.equal(normalizeObiaWorkbench("x"), null);
  });
});
