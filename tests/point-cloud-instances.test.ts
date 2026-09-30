import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { LabelHistory } from "../packages/plugins/src/plugins/point-cloud-annotation/history";
import {
  PointLabelStore,
  decodeNodeEdits,
  encodeNodeEdits,
} from "../packages/plugins/src/plugins/point-cloud-annotation/label-store";
import {
  initSync,
  compress_points,
  laszip_vlr_data,
} from "../packages/plugins/src/plugins/point-cloud-annotation/laz-encoder/laz_encoder.js";
import {
  buildSegmentsLabel,
  writeLas,
  writeLaz,
  writeNpy,
} from "../packages/plugins/src/plugins/point-cloud-annotation/las-writer";

const ORIGIN: [number, number, number] = [-123.07, 44.05, 0];

describe("object id encoding", () => {
  it("round-trips 32-bit ids as varints", () => {
    const edits = new Map([
      [0, 1],
      [5, 300],
      [70_000, 0xffffffff],
    ]);
    assert.deepEqual(
      decodeNodeEdits(encodeNodeEdits(edits, true), undefined, undefined, true),
      edits,
    );
  });
});

describe("PointLabelStore object ids", () => {
  const ranges = [
    { key: "0-0-0-0", start: 0, count: 4 },
    { key: "1-0-0-0", start: 4, count: 4 },
  ];

  it("records, persists and re-applies ids by node, and forgets id 0", () => {
    const store = new PointLabelStore();
    const ids = Uint32Array.from([0, 7, 7, 0, 0, 9, 0, 0]);
    store.recordInstances("https://x/a.copc.laz", { nodeRanges: ranges }, ids, [1, 2, 5]);
    assert.equal(store.maxInstanceId(), 9);
    const saved = JSON.parse(JSON.stringify(store.encode()));
    assert.equal(saved.instances.length, 1);

    const reloaded = new PointLabelStore();
    reloaded.load(saved);
    assert.equal(reloaded.isEmpty, false);
    // Nodes arrive in a different order after a reload.
    const reordered = [
      { key: "1-0-0-0", start: 0, count: 4 },
      { key: "0-0-0-0", start: 4, count: 4 },
    ];
    const restored = new Uint32Array(8);
    assert.equal(
      reloaded.applyInstances("https://x/a.copc.laz", { nodeRanges: reordered }, restored),
      3,
    );
    assert.deepEqual([...restored], [0, 9, 0, 0, 0, 7, 7, 0]);

    // Dissolving an object removes the stored ids.
    ids[1] = 0;
    ids[2] = 0;
    ids[5] = 0;
    store.recordInstances("https://x/a.copc.laz", { nodeRanges: ranges }, ids, [1, 2, 5]);
    assert.equal(store.isEmpty, true);
    assert.equal(store.encode(), undefined);
  });

  it("skips a corrupt id record", () => {
    const store = new PointLabelStore();
    store.load({
      version: 1,
      sources: [],
      instances: [{ url: "https://x/a.laz", nodes: { file: "!!notbase64" } }],
    });
    assert.equal(store.isEmpty, true);
  });
});

describe("LabelHistory with objects", () => {
  it("undoes and redoes a class and object assignment together", () => {
    const classes = Uint8Array.from([1, 1, 1]);
    const ids = new Uint32Array(3);
    const history = new LabelHistory();
    assert.equal(history.assign("a", classes, Uint32Array.from([0, 1]), 64, { ids, id: 3 }), 2);
    assert.deepEqual([...classes], [64, 64, 1]);
    assert.deepEqual([...ids], [3, 3, 0]);
    // Same class, new object: still a change.
    assert.equal(history.assign("a", classes, Uint32Array.from([1]), 64, { ids, id: 4 }), 1);
    const undone = history.undo(
      () => classes,
      () => ids,
    );
    assert.equal(undone?.instances, true);
    assert.deepEqual([...ids], [3, 3, 0]);
    history.undo(
      () => classes,
      () => ids,
    );
    assert.deepEqual([...classes], [1, 1, 1]);
    assert.deepEqual([...ids], [0, 0, 0]);
    history.redo(
      () => classes,
      () => ids,
    );
    assert.deepEqual([...classes], [64, 64, 1]);
    assert.deepEqual([...ids], [3, 3, 0]);
  });

  it("dissolves an object without touching classes", () => {
    const classes = Uint8Array.from([6, 6]);
    const ids = Uint32Array.from([2, 2]);
    const history = new LabelHistory();
    assert.equal(history.setInstances("a", ids, Uint32Array.from([0, 1]), 0), 2);
    assert.deepEqual([...ids], [0, 0]);
    const undone = history.undo(
      () => classes,
      () => ids,
    );
    assert.deepEqual([...ids], [2, 2]);
    assert.deepEqual([...classes], [6, 6]);
    assert.equal(undone?.instances, true);
    // A plain class edit reports no object change.
    history.assign("a", classes, Uint32Array.from([0]), 2);
    assert.equal(history.undo(() => classes)?.instances, false);
  });
});

function cloudWithObjects(count: number) {
  const positions = new Float32Array(count * 3);
  const classifications = new Uint8Array(count);
  const colors = new Uint8Array(count * 4);
  const instances = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (i % 97) * 1e-6;
    positions[i * 3 + 1] = Math.floor(i / 97) * 1e-6;
    positions[i * 3 + 2] = 100 + (i % 13) * 0.5;
    classifications[i] = i % 7;
    colors.set([i % 256, (i * 3) % 256, (i * 7) % 256, 255], i * 4);
    instances[i] = i % 5 === 0 ? 0 : 1000 + Math.floor(i / 50);
  }
  return {
    positions,
    coordinateOrigin: ORIGIN,
    pointCount: count,
    classifications,
    colors,
    hasRGB: true,
    instances,
  };
}

describe("exports with objects", () => {
  it("writes an Extra Bytes VLR and a uint32 instance after each LAS record", () => {
    const cloud = cloudWithObjects(3);
    const bytes = new Uint8Array(writeLas(cloud));
    const view = new DataView(bytes.buffer);
    assert.equal(view.getUint16(105, true), 40);
    assert.equal(view.getUint32(100, true), 2);
    // Second VLR: LASF_Spec / 4 with one 192-byte descriptor.
    const wktLength = view.getUint16(375 + 20, true);
    const vlr = 375 + 54 + wktLength;
    assert.equal(new TextDecoder().decode(bytes.subarray(vlr + 2, vlr + 11)), "LASF_Spec");
    assert.equal(view.getUint16(vlr + 18, true), 4);
    assert.equal(view.getUint16(vlr + 20, true), 192);
    const descriptor = vlr + 54;
    assert.equal(bytes[descriptor + 2], 6);
    assert.equal(
      new TextDecoder().decode(bytes.subarray(descriptor + 4, descriptor + 12)),
      "instance",
    );
    const pointOffset = view.getUint32(96, true);
    assert.equal(bytes.length, pointOffset + 3 * 40);
    assert.equal(view.getUint32(pointOffset + 36, true), 0);
    assert.equal(view.getUint32(pointOffset + 40 + 36, true), 1000);
  });

  it("round-trips LAZ records, extra bytes included, through laz-perf", async () => {
    initSync({
      module: readFileSync(
        new URL(
          "../packages/plugins/src/plugins/point-cloud-annotation/laz-encoder/laz_encoder_bg.wasm",
          import.meta.url,
        ),
      ),
    });
    const cloud = cloudWithObjects(4000);
    const now = new Date(Date.UTC(2026, 8, 30));
    const las = new Uint8Array(writeLas(cloud, { now }));
    const laz = writeLaz(cloud, { compress_points, laszip_vlr_data }, { now });
    const require = createRequire(import.meta.url);
    const { createLazPerf } = require("laz-perf/lib/node");
    const LazPerf = await createLazPerf();
    const file = LazPerf._malloc(laz.length);
    LazPerf.HEAPU8.set(laz, file);
    const reader = new LazPerf.LASZip();
    reader.open(file, laz.length);
    assert.equal(reader.getCount(), 4000);
    const recordLength = reader.getPointLength();
    assert.equal(recordLength, 40);
    const point = LazPerf._malloc(recordLength);
    const lasOffset = new DataView(las.buffer).getUint32(96, true);
    for (let i = 0; i < 4000; i++) {
      reader.getPoint(point);
      const decoded = LazPerf.HEAPU8.subarray(point, point + recordLength);
      const expected = las.subarray(
        lasOffset + i * recordLength,
        lasOffset + (i + 1) * recordLength,
      );
      if (!decoded.every((byte: number, k: number) => byte === expected[k])) {
        assert.fail(`record ${i} differs`);
      }
    }
    reader.delete();
    LazPerf._free(point);
    LazPerf._free(file);
  });

  it("adds an instance field to the NumPy export", () => {
    const cloud = cloudWithObjects(2);
    cloud.hasRGB = false;
    const bytes = writeNpy(cloud);
    const view = new DataView(bytes.buffer);
    const headerLength = view.getUint16(8, true);
    const header = new TextDecoder().decode(bytes.subarray(10, 10 + headerLength));
    assert.match(header, /\('instance', '<u4'\)/);
    const recordSize = 27 + 4;
    assert.equal(bytes.length, 10 + headerLength + 2 * recordSize);
    assert.equal(view.getUint32(10 + headerLength + recordSize + 27, true), 1000);
  });

  it("gives each object its own Segments.ai annotation", () => {
    const label = buildSegmentsLabel(
      Uint8Array.from([64, 64, 2, 64, 2]),
      5,
      (code) => `c${code}`,
      Uint32Array.from([1, 1, 0, 2, 0]),
    );
    assert.deepEqual(label.point_annotations, [1, 1, 2, 3, 2]);
    assert.deepEqual(label.annotations, [
      { id: 1, category_id: 64 },
      { id: 2, category_id: 2 },
      { id: 3, category_id: 64 },
    ]);
    assert.deepEqual(
      label.categories.map((category) => category.id),
      [2, 64],
    );
  });
});
