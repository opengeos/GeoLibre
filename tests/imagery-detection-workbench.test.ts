import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VESSEL_CLASSES,
  classifyDetection,
  createDetectionFeature,
  exportAnnotationsCsv,
  exportCoco,
  exportManifestCsv,
  exportYoloObb,
  geographicToPixel,
  createCoverageGrid,
  imageryMetadataFromLayer,
  maskPolygonToOrientedCorners,
  sentinel2SclAllowsCandidate,
  vesselClassForKey,
  type ImageryMetadata,
} from "../packages/plugins/src/plugins/imagery-detection-workbench";

const imagery: ImageryMetadata = {
  layerId: "scene-1",
  layerName: "Sentinel-2 scene",
  sourceUri: "images/scene-1.tif",
  sensor: "Sentinel-2",
  modality: "optical",
  acquiredAt: "2026-08-01T10:42:00Z",
  resolutionM: 10,
  bands: "B04,B03,B02",
  processingLevel: "L2A",
  widthPx: 1000,
  heightPx: 500,
  bounds: [-10, 40, 0, 45],
};

const corners = [
  [-9, 44] as [number, number],
  [-8, 44] as [number, number],
  [-8, 43] as [number, number],
  [-9, 43] as [number, number],
] as const;

describe("Imagery Detection Workbench classes", () => {
  it("uses the finalized home-row layout", () => {
    assert.deepEqual(
      VESSEL_CLASSES.map(({ key, id }) => [key, id]),
      [
        ["a", "cargo"],
        ["s", "tanker"],
        ["d", "fishing"],
        ["f", "passenger"],
        ["g", "working_vessel"],
        ["h", "military_law_enforcement"],
        ["j", "small_boat"],
        ["k", "sailboat"],
        ["l", "unknown_vessel"],
        [";", "not_vessel"],
      ]
    );
    assert.equal(vesselClassForKey("A")?.id, "cargo");
    assert.equal(vesselClassForKey(";")?.id, "not_vessel");
  });
});

describe("imagery setup", () => {
  it("auto-populates STAC metadata from a GeoLibre layer", () => {
    const result = imageryMetadataFromLayer({
      id: "s2",
      name: "scene",
      type: "raster",
      source: {
        type: "raster",
        collectionId: "sentinel-2-l2a",
        bounds: [-2, 1, 2, 5],
      },
      visible: true,
      opacity: 1,
      style: {},
      metadata: {
        platform: "sentinel-2b",
        datetime: "2026-01-02T03:04:05Z",
        gsd: 10,
        bandNames: ["B04", "B03", "B02"],
        width: 10980,
        height: 10980,
      },
    });
    assert.equal(result.sensor, "sentinel-2b");
    assert.equal(result.acquiredAt, "2026-01-02T03:04:05Z");
    assert.equal(result.resolutionM, 10);
    assert.equal(result.bands, "B04,B03,B02");
    assert.deepEqual(result.bounds, [-2, 1, 2, 5]);
    assert.equal(result.widthPx, 10980);
  });

  it("creates a north-to-south coverage grid", () => {
    const grid = createCoverageGrid([0, 0, 4, 2], 2, 2);
    assert.equal(grid.length, 4);
    assert.deepEqual(grid[0]?.bounds, [0, 1, 2, 2]);
    assert.deepEqual(grid[3]?.bounds, [2, 0, 4, 1]);
  });

  it("fits an oriented candidate box around a mask", () => {
    const corners = maskPolygonToOrientedCorners(
      [
        [10, 10],
        [30, 10],
        [30, 20],
        [10, 20],
        [10, 10],
      ],
      100,
      100,
      [0, 0, 10, 10]
    );
    assert.ok(corners);
    assert.deepEqual(corners, [
      [1, 9],
      [3, 9],
      [3, 8],
      [1, 8],
    ]);
  });

  it("keeps water and coastal land but rejects clouds", () => {
    const scl = new Uint8Array([
      4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6, 6, 6, 6, 6, 6, 6, 9, 6, 6, 6, 6, 6, 6, 6,
    ]);
    assert.equal(sentinel2SclAllowsCandidate(scl, 5, 5, 0, 4, 1), true);
    assert.equal(sentinel2SclAllowsCandidate(scl, 5, 5, 2, 1, 1), true);
    assert.equal(sentinel2SclAllowsCandidate(scl, 5, 5, 2, 0, 1), false);
    assert.equal(sentinel2SclAllowsCandidate(scl, 5, 5, 2, 3, 2), false);
  });
});

describe("detection annotations", () => {
  it("snapshots imagery provenance and closes the polygon", () => {
    const feature = createDetectionFeature([...corners], imagery, {
      id: "det-1",
      now: "2026-08-12T00:00:00Z",
    });
    assert.equal(feature.properties.sensor, "Sentinel-2");
    assert.equal(feature.properties.imagery_layer_id, "scene-1");
    assert.equal(feature.properties.review_status, "unreviewed");
    assert.deepEqual(
      feature.geometry.coordinates[0]?.[0],
      feature.geometry.coordinates[0]?.[4]
    );
  });

  it("accepts vessel classes and rejects the negative class", () => {
    const feature = createDetectionFeature([...corners], imagery, {
      id: "det-1",
    });
    assert.equal(
      classifyDetection(feature, "cargo").properties.review_status,
      "accepted"
    );
    assert.equal(
      classifyDetection(feature, "not_vessel").properties.review_status,
      "rejected"
    );
  });
});

describe("training exports", () => {
  const accepted = classifyDetection(
    createDetectionFeature([...corners], imagery, { id: "det-1" }),
    "cargo",
    "2026-08-12T01:00:00Z"
  );
  const rejected = classifyDetection(
    createDetectionFeature([...corners], imagery, { id: "det-2" }),
    "not_vessel",
    "2026-08-12T01:00:00Z"
  );

  it("maps geographic coordinates to north-up source pixels", () => {
    assert.deepEqual(
      geographicToPixel([-10, 45], imagery.bounds!, 1000, 500),
      [0, 0]
    );
    assert.deepEqual(
      geographicToPixel([0, 40], imagery.bounds!, 1000, 500),
      [1000, 500]
    );
    assert.deepEqual(
      geographicToPixel([-5, 42.5], imagery.bounds!, 1000, 500),
      [500, 250]
    );
  });

  it("exports a provenance manifest and annotation ledger", () => {
    const manifest = exportManifestCsv(imagery, [accepted, rejected]);
    assert.match(manifest, /scene-1,images\/scene-1\.tif,Sentinel-2,optical/);
    assert.match(manifest, /,2,2\n$/);
    const annotations = exportAnnotationsCsv([accepted, rejected]);
    assert.match(annotations, /det-1,scene-1,cargo,accepted/);
    assert.match(annotations, /det-2,scene-1,not_vessel,rejected/);
  });

  it("exports accepted vessels to COCO but excludes negative decisions", () => {
    const coco = exportCoco(imagery, [accepted, rejected]) as {
      annotations: Array<{ detection_id: string; bbox: number[] }>;
    };
    assert.equal(coco.annotations.length, 1);
    assert.equal(coco.annotations[0]?.detection_id, "det-1");
    assert.deepEqual(coco.annotations[0]?.bbox, [100, 100, 100, 100]);
  });

  it("exports normalized YOLO oriented-box coordinates", () => {
    assert.equal(
      exportYoloObb(imagery, [accepted, rejected]),
      "0 0.100000 0.200000 0.200000 0.200000 0.200000 0.400000 0.100000 0.400000\n"
    );
  });

  it("refuses pixel exports without dimensions and bounds", () => {
    const incomplete = { ...imagery, widthPx: undefined };
    assert.throws(
      () => exportCoco(incomplete, [accepted]),
      /requires image width/
    );
    assert.throws(
      () => exportYoloObb(incomplete, [accepted]),
      /requires image width/
    );
  });
});
