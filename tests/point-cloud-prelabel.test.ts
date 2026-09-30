import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runWhiteboxToolWasm } from "@geolibre/processing";
import { initConvertTools } from "../packages/processing/src/wasm-convert";
import { LabelHistory } from "../packages/plugins/src/plugins/point-cloud-annotation/history";
import { localFrame } from "../packages/plugins/src/plugins/point-cloud-annotation/cuboid";
import { writeLas } from "../packages/plugins/src/plugins/point-cloud-annotation/las-writer";
import {
  PRELABEL_TOOLS,
  keepUntouched,
  mergePrelabels,
  readLasClassifications,
} from "../packages/plugins/src/plugins/point-cloud-annotation/prelabel";

const ORIGIN: [number, number, number] = [-123.07, 44.05, 0];
const UTM10 =
  'PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]';

/**
 * A 60 x 60 m field at 1 m spacing on gentle terrain, with a flat-roofed
 * 12 x 12 m, 8 m tall building in the middle; every point unclassified (1).
 */
function fieldWithBuilding() {
  const frame = localFrame(ORIGIN[1]);
  const metres: [number, number, number][] = [];
  const building: boolean[] = [];
  for (let x = -30; x < 30; x += 1) {
    for (let y = -30; y < 30; y += 1) {
      const ground = 100 + 0.02 * x + 0.01 * y;
      const inside = Math.abs(x) < 6 && Math.abs(y) < 6;
      metres.push([x, y, inside ? ground + 8 : ground]);
      building.push(inside);
    }
  }
  const positions = new Float32Array(metres.length * 3);
  metres.forEach(([e, n, z], i) => {
    positions[i * 3] = e / frame.mx;
    positions[i * 3 + 1] = n / frame.my;
    positions[i * 3 + 2] = z;
  });
  return {
    cloud: {
      positions,
      coordinateOrigin: ORIGIN,
      pointCount: metres.length,
      classifications: new Uint8Array(metres.length).fill(1),
      wkt: UTM10,
    },
    building,
  };
}

describe("readLasClassifications", () => {
  it("reads LAS 1.4 format 6/7 class bytes in point order", () => {
    const { cloud } = fieldWithBuilding();
    cloud.classifications[5] = 6;
    const classes = readLasClassifications(new Uint8Array(writeLas(cloud)));
    assert.equal(classes.length, cloud.pointCount);
    assert.equal(classes[5], 6);
    assert.equal(classes[6], 1);
  });

  it("rejects a malformed record geometry", () => {
    const las = new Uint8Array(writeLas(fieldWithBuilding().cloud));
    const zeroLength = las.slice();
    new DataView(zeroLength.buffer).setUint16(105, 0, true);
    assert.throws(() => readLasClassifications(zeroLength), /malformed/);
    const short = las.slice();
    new DataView(short.buffer).setUint16(105, 16, true);
    assert.throws(() => readLasClassifications(short), /malformed/);
  });

  it("reads a legacy format's 5-bit class and rejects LAZ", () => {
    const las = new Uint8Array(writeLas(fieldWithBuilding().cloud));
    const legacy = las.slice();
    legacy[104] = 1; // format 1: class in the low 5 bits of byte 15
    const offset = new DataView(legacy.buffer).getUint32(96, true);
    legacy[offset + 15] = 0b1110_0010; // flags in the high bits, class 2
    assert.equal(readLasClassifications(legacy)[0], 2);
    const laz = las.slice();
    laz[104] |= 0x80;
    assert.throws(() => readLasClassifications(laz), /compressed/);
  });
});

describe("mergePrelabels", () => {
  const current = Uint8Array.from([0, 1, 6, 1, 5]);
  const result = Uint8Array.from([2, 2, 2, 1, 2]);
  it("takes only changed, allowed points", () => {
    const merged = mergePrelabels(current, result, 5, {
      onlyUnclassified: true,
      protectedClasses: new Set(),
    });
    assert.deepEqual([...merged.indices], [0, 1]);
    assert.deepEqual([...merged.codes], [2, 2]);
    const all = mergePrelabels(current, result, 5, {
      onlyUnclassified: false,
      protectedClasses: new Set([6]),
    });
    assert.deepEqual([...all.indices], [0, 1, 4]);
  });

  it("refuses a result that dropped or reordered points", () => {
    assert.throws(
      () =>
        mergePrelabels(current, result.subarray(0, 4), 5, {
          onlyUnclassified: false,
          protectedClasses: new Set(),
        }),
      /keep every point/,
    );
  });
});

describe("keepUntouched", () => {
  it("keeps edits made while the tool ran", () => {
    const snapshot = Uint8Array.from([1, 1, 1]);
    const current = Uint8Array.from([1, 6, 1]); // point 1 relabelled mid-run
    const kept = keepUntouched(
      { indices: Uint32Array.from([0, 1, 2]), codes: Uint8Array.from([2, 2, 2]) },
      snapshot,
      current,
    );
    assert.deepEqual([...kept.indices], [0, 2]);
    assert.deepEqual([...kept.codes], [2, 2]);
  });
});

describe("LabelHistory.assignEach", () => {
  it("applies per-point codes as one undoable edit", () => {
    const classes = Uint8Array.from([1, 1, 1]);
    const history = new LabelHistory();
    assert.equal(
      history.assignEach("a", classes, Uint32Array.from([0, 2]), Uint8Array.from([2, 5])),
      2,
    );
    assert.deepEqual([...classes], [2, 1, 5]);
    history.undo(() => classes);
    assert.deepEqual([...classes], [1, 1, 1]);
    history.redo(() => classes);
    assert.deepEqual([...classes], [2, 1, 5]);
  });
});

describe("Whitebox pre-labelling through the WASM runner", () => {
  before(async () => {
    await initConvertTools(
      readFileSync(
        fileURLToPath(new URL("../node_modules/geolibre-wasm/geolibre-cli.wasm", import.meta.url)),
      ),
    );
  });

  it("returns lidar_out bytes and classifies the ground, not the roof", async () => {
    const { cloud, building } = fieldWithBuilding();
    const tool = PRELABEL_TOOLS.find((entry) => entry.id === "ground")!;
    const job = await runWhiteboxToolWasm({
      tool_id: tool.toolId,
      parameters: tool.parameters,
      layer_inputs: {
        input: { name: "input.las", kind: "lidar_in", bytes: new Uint8Array(writeLas(cloud)) },
      },
      tool: {
        id: tool.toolId,
        params: [
          { name: "input", kind: "lidar_in", required: true },
          { name: "output", kind: "lidar_out", required: true },
          { name: "classify", kind: "string" },
        ],
      },
    });
    assert.equal(job.status, "succeeded", job.error ?? "");
    const output = job.outputs.output;
    assert.ok(output instanceof Uint8Array);
    const classes = readLasClassifications(output);
    assert.equal(classes.length, cloud.pointCount);
    let groundOnGround = 0;
    let groundOnRoof = 0;
    let groundPoints = 0;
    let roofPoints = 0;
    building.forEach((onRoof, i) => {
      if (onRoof) {
        roofPoints++;
        if (classes[i] === 2) groundOnRoof++;
      } else {
        groundPoints++;
        if (classes[i] === 2) groundOnGround++;
      }
    });
    assert.ok(
      groundOnGround / groundPoints > 0.95,
      `ground recall ${groundOnGround}/${groundPoints}`,
    );
    assert.equal(
      groundOnRoof,
      0,
      `roof points classified as ground: ${groundOnRoof}/${roofPoints}`,
    );
  });
});

describe("planPrelabelTiles", async () => {
  const { planPrelabelTiles } =
    await import("../packages/plugins/src/plugins/point-cloud-annotation/prelabel");
  it("covers every point exactly once in the cores, with buffered inputs", () => {
    const { cloud } = fieldWithBuilding(); // 3,600 points on a 60 m square
    const tiles = planPrelabelTiles(cloud, 1000, 5);
    assert.ok(tiles.length >= 4, `tiles ${tiles.length}`);
    const seen = new Uint8Array(cloud.pointCount);
    for (const tile of tiles) {
      assert.ok(tile.core.length <= 1000);
      assert.ok(tile.input.length >= tile.core.length);
      const inputSet = new Set(tile.input);
      for (const i of tile.core) {
        seen[i]++;
        assert.ok(inputSet.has(i), "core point missing from its input");
      }
    }
    assert.ok(seen.every((n) => n === 1));
  });

  it("refuses a tile too dense to split instead of running out of memory", () => {
    // 5,000 points stacked on one spot.
    const positions = new Float32Array(5000 * 3);
    assert.throws(
      () => planPrelabelTiles({ positions, coordinateOrigin: ORIGIN, pointCount: 5000 }, 1000, 5),
      /Too many points/,
    );
  });

  it("returns one tile when the cloud already fits", () => {
    const { cloud } = fieldWithBuilding();
    const tiles = planPrelabelTiles(cloud, 10_000);
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].core.length, cloud.pointCount);
  });
});
