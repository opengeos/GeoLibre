import { performance } from "node:perf_hooks";
import { GeoJSONVT } from "@maplibre/geojson-vt";
import { fromGeojsonVt } from "@maplibre/vt-pbf";

function pointGrid(count) {
  const features = new Array(count);
  for (let i = 0; i < count; i++) {
    const lng = (i % 100) * 0.001;
    const lat = Math.floor(i / 100) * 0.001;
    features[i] = {
      type: "Feature",
      properties: { id: i, name: `Feature_${i}`, value: i * 1.5 },
      geometry: { type: "Point", coordinates: [lng, lat] },
    };
  }
  return { type: "FeatureCollection", features };
}

function polygonGrid(count) {
  const features = new Array(count);
  for (let i = 0; i < count; i++) {
    const lng = (i % 100) * 0.01;
    const lat = Math.floor(i / 100) * 0.01;
    features[i] = {
      type: "Feature",
      properties: { id: i, name: `Poly_${i}`, area: 100.5 },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [lng, lat],
            [lng + 0.008, lat],
            [lng + 0.008, lat + 0.008],
            [lng, lat + 0.008],
            [lng, lat],
          ],
        ],
      },
    };
  }
  return { type: "FeatureCollection", features };
}

function measureWorkload(name, generator, counts) {
  console.log(`\n=== Workload: ${name} ===`);
  for (const count of counts) {
    if (global.gc) global.gc();
    const memBefore = process.memoryUsage().heapUsed;

    const t0 = performance.now();
    const collection = generator(count);
    const tDataGen = performance.now() - t0;

    // Simulate structured clone (worker transfer)
    const tClone0 = performance.now();
    const cloned = structuredClone(collection);
    const tClone = performance.now() - tClone0;

    // Build GeoJSONVT index
    const tIndex0 = performance.now();
    const index = new GeoJSONVT(cloned, {
      maxZoom: 16,
      extent: 4096,
      buffer: 64,
      tolerance: 3,
    });
    const tIndex = performance.now() - tIndex0;

    // Encode tile 0/0/0
    const tEncode0 = performance.now();
    const tile = index.getTile(0, 0, 0);
    let pbfLength = 0;
    if (tile) {
      const pbf = fromGeojsonVt({ data: tile }, { version: 2, extent: 4096 });
      pbfLength = pbf.byteLength;
    }
    const tEncode = performance.now() - tEncode0;

    const memEnd = process.memoryUsage().heapUsed;

    console.log(
      `Count: ${count.toLocaleString().padStart(8)} | ` +
        `Gen: ${tDataGen.toFixed(1).padStart(6)}ms | ` +
        `Clone: ${tClone.toFixed(1).padStart(6)}ms | ` +
        `Index: ${tIndex.toFixed(1).padStart(6)}ms | ` +
        `Encode: ${tEncode.toFixed(2).padStart(6)}ms | ` +
        `Mem: ${((memEnd - memBefore) / 1024 / 1024).toFixed(1).padStart(5)} MB | ` +
        `Pbf: ${(pbfLength / 1024).toFixed(1)} KB`,
    );
  }
}

function measureJsonParse(count) {
  console.log(`\n=== Workload: JSON.parse Overhead for ${count.toLocaleString()} Points ===`);
  const jsonStrings = new Array(count);
  for (let i = 0; i < count; i++) {
    const lng = (i % 100) * 0.001;
    const lat = Math.floor(i / 100) * 0.001;
    jsonStrings[i] = `{"type":"Point","coordinates":[${lng},${lat}]}`;
  }

  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const parsed = new Array(count);
  for (let i = 0; i < count; i++) {
    parsed[i] = JSON.parse(jsonStrings[i]);
  }
  const tParse = performance.now() - t0;
  const memAfter = process.memoryUsage().heapUsed;

  console.log(
    `Count: ${count.toLocaleString().padStart(8)} | ` +
      `JSON.parse Time: ${tParse.toFixed(1).padStart(6)}ms | ` +
      `Heap Allocated: ${((memAfter - memBefore) / 1024 / 1024).toFixed(1).padStart(5)} MB`,
  );
}

function measureWkbDecode(count) {
  console.log(`\n=== Workload: WKB Binary Decode for ${count.toLocaleString()} Points ===`);
  // Encode 1 point WKB: byteOrder(1) + type(4) + x(8) + y(8) = 21 bytes
  const wkbBuffer = new Uint8Array(21 * count);
  const view = new DataView(wkbBuffer.buffer);
  for (let i = 0; i < count; i++) {
    const offset = i * 21;
    view.setUint8(offset, 1); // little endian
    view.setUint32(offset + 1, 1, true); // Point
    view.setFloat64(offset + 5, (i % 100) * 0.001, true);
    view.setFloat64(offset + 13, Math.floor(i / 100) * 0.001, true);
  }

  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  // Decode into flat Float64Array
  const coords = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    const offset = i * 21;
    coords[i * 2] = view.getFloat64(offset + 5, true);
    coords[i * 2 + 1] = view.getFloat64(offset + 13, true);
  }
  const tDecode = performance.now() - t0;
  const memAfter = process.memoryUsage().heapUsed;

  console.log(
    `Count: ${count.toLocaleString().padStart(8)} | ` +
      `Binary Decode Time: ${tDecode.toFixed(1).padStart(6)}ms | ` +
      `Heap Allocated: ${((memAfter - memBefore) / 1024 / 1024).toFixed(1).padStart(5)} MB`,
  );

  // Measure clone/transfer of the flat coords
  const tClone0 = performance.now();
  const cloned = structuredClone(coords);
  const tClone = performance.now() - tClone0;
  console.log(
    `Count: ${count.toLocaleString().padStart(8)} | Flat Array structuredClone: ${tClone.toFixed(2)}ms (${(cloned.byteLength / 1024 / 1024).toFixed(2)} MB)`,
  );
}

console.log("Starting Baseline Vector Pipeline Benchmark...");
console.log(`Node version: ${process.version}, Arch: ${process.arch}`);

measureJsonParse(50_000);
measureJsonParse(100_000);

measureWkbDecode(50_000);
measureWkbDecode(100_000);

measureWorkload("Points Grid", pointGrid, [1_000, 10_000, 50_000, 100_000]);
measureWorkload("Polygon Grid", polygonGrid, [1_000, 10_000, 50_000]);
