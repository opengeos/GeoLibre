import { performance } from "perf_hooks";
import v8 from "v8";
import {
  featureCollectionToGeoArrow,
  geoArrowToFeatureCollection,
} from "../packages/core/src/geoarrow.ts";
import { buildTileIndex, buildTileIndexFromBinary } from "../packages/map/src/geojson-vt-index.ts";

function getMemoryMB() {
  if (global.gc) global.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function generatePoints(n) {
  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    features[i] = {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [-122.4194 + (Math.random() - 0.5) * 2, 37.7749 + (Math.random() - 0.5) * 2],
      },
      properties: {
        id: i,
        name: `Location #${i}`,
        val: i * 1.5,
        active: i % 2 === 0,
      },
    };
  }
  return { type: "FeatureCollection", features };
}

function generateComplexPolygons(n) {
  const features = new Array(n);
  for (let i = 0; i < n; i++) {
    const cx = -120 + (i % 20) * 0.5;
    const cy = 35 + Math.floor(i / 20) * 0.5;
    const outer = [];
    for (let j = 0; j < 20; j++) {
      const angle = (j / 20) * Math.PI * 2;
      outer.push([cx + Math.cos(angle) * 0.2, cy + Math.sin(angle) * 0.2]);
    }
    outer.push(outer[0]);

    const inner = [];
    for (let j = 0; j < 10; j++) {
      const angle = (j / 10) * Math.PI * 2;
      inner.push([cx + Math.cos(angle) * 0.08, cy + Math.sin(angle) * 0.08]);
    }
    inner.push(inner[0]);

    features[i] = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [outer, inner],
      },
      properties: {
        id: i,
        area: 0.12,
        zone: `Zone-${i % 5}`,
      },
    };
  }
  return { type: "FeatureCollection", features };
}

const TILE_OPTIONS = {
  cluster: false,
  clusterRadius: 50,
  clusterMaxZoom: 14,
};

async function benchmarkWorkload(name, fc, repetitions = 5) {
  const results = {
    name,
    featureCount: fc.features.length,
    baseline: {
      serializeTime: [],
      workerTransferTime: [],
      tileIndexTime: [],
      totalTime: [],
      heapMB: [],
    },
    geoarrow: {
      binaryPrepTime: [],
      workerTransferTime: [],
      tileIndexTime: [],
      totalTime: [],
      heapMB: [],
    },
  };

  for (let r = 0; r < repetitions; r++) {
    const m0 = getMemoryMB();
    const t0 = performance.now();
    const jsonStr = JSON.stringify(fc);
    const parsedFc = JSON.parse(jsonStr);
    const tSerialize = performance.now();

    const CHUNK_SIZE = 2000;
    const chunks = [];
    for (let i = 0; i < parsedFc.features.length; i += CHUNK_SIZE) {
      chunks.push(structuredClone(parsedFc.features.slice(i, i + CHUNK_SIZE)));
    }
    const tTransfer = performance.now();

    const flatFeatures = chunks.flat();
    const vtIndex = buildTileIndex(
      { type: "FeatureCollection", features: flatFeatures },
      TILE_OPTIONS,
    );
    const tile = vtIndex.getTile(0, 0, 0);
    const tEnd = performance.now();
    const mEnd = getMemoryMB();

    results.baseline.serializeTime.push(tSerialize - t0);
    results.baseline.workerTransferTime.push(tTransfer - tSerialize);
    results.baseline.tileIndexTime.push(tEnd - tTransfer);
    results.baseline.totalTime.push(tEnd - t0);
    results.baseline.heapMB.push(Math.max(0, mEnd - m0));
  }

  for (let r = 0; r < repetitions; r++) {
    const m0 = getMemoryMB();
    const t0 = performance.now();

    // End-to-end accounting: measure conversion from GeoJSON to GeoArrow batch
    const batch = featureCollectionToGeoArrow(fc);
    const tPrep = performance.now();

    const clonedBatch = structuredClone(batch);
    const tTransfer = performance.now();

    const vtIndex = buildTileIndexFromBinary(clonedBatch, TILE_OPTIONS);
    const tile = vtIndex.getTile(0, 0, 0);
    const tEnd = performance.now();
    const mEnd = getMemoryMB();

    results.geoarrow.binaryPrepTime.push(tPrep - t0);
    results.geoarrow.workerTransferTime.push(tTransfer - tPrep);
    results.geoarrow.tileIndexTime.push(tEnd - tTransfer);
    results.geoarrow.totalTime.push(tEnd - t0);
    results.geoarrow.heapMB.push(Math.max(0, mEnd - m0));
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  return {
    name,
    features: fc.features.length,
    baselineMedianTotal: median(results.baseline.totalTime).toFixed(2),
    baselineMedianTransfer: median(results.baseline.workerTransferTime).toFixed(2),
    baselineMedianHeap: median(results.baseline.heapMB).toFixed(1),
    geoarrowMedianTotal: median(results.geoarrow.totalTime).toFixed(2),
    geoarrowMedianPrep: median(results.geoarrow.binaryPrepTime).toFixed(2),
    geoarrowMedianTransfer: median(results.geoarrow.workerTransferTime).toFixed(2),
    geoarrowMedianHeap: median(results.geoarrow.heapMB).toFixed(1),
    speedup:
      (median(results.baseline.totalTime) / median(results.geoarrow.totalTime)).toFixed(2) + "x",
    transferSpeedup:
      (
        median(results.baseline.workerTransferTime) / median(results.geoarrow.workerTransferTime)
      ).toFixed(2) + "x",
  };
}

async function runAll() {
  console.log("=== GEOARROW VECTOR PIPELINE COMPREHENSIVE BENCHMARK ===");
  console.log("Runtime: Node.js", process.version, "Platform:", process.platform, process.arch);
  console.log("Timestamp:", new Date().toISOString());

  const workloads = [
    { name: "Small dataset (1k Points)", fc: generatePoints(1000), reps: 7 },
    { name: "Medium dataset (10k Points)", fc: generatePoints(10000), reps: 7 },
    { name: "Large dataset (50k Points)", fc: generatePoints(50000), reps: 5 },
    { name: "Extra-large dataset (100k Points)", fc: generatePoints(100000), reps: 5 },
    {
      name: "Complex geometry (2k Polygons with Holes)",
      fc: generateComplexPolygons(2000),
      reps: 5,
    },
  ];

  const summary = [];
  for (const w of workloads) {
    const res = await benchmarkWorkload(w.name, w.fc, w.reps);
    summary.push(res);
    console.log(`\n[${res.name}]`);
    console.log(
      `  Baseline Total: ${res.baselineMedianTotal} ms | Transfer: ${res.baselineMedianTransfer} ms | Heap: ${res.baselineMedianHeap} MB`,
    );
    console.log(
      `  GeoArrow Total (End-to-End incl. conversion): ${res.geoarrowMedianTotal} ms (Prep: ${res.geoarrowMedianPrep} ms) | Transfer: ${res.geoarrowMedianTransfer} ms | Heap: ${res.geoarrowMedianHeap} MB`,
    );
    console.log(`  Overall Speedup: ${res.speedup} (Worker Transfer: ${res.transferSpeedup})`);
  }

  // Churn / Repeated Updates test (10 repeated loads of 20,000 features)
  console.log("\n=== REPEATED UPDATE / MEMORY LEAK TEST (10 cycles x 20,000 features) ===");
  if (!global.gc) {
    console.warn(
      "Notice: global.gc is unavailable; memory measurements require node --expose-gc for deterministic garbage collection.",
    );
  }
  const testBatch = featureCollectionToGeoArrow(generatePoints(20000));
  const initMem = getMemoryMB();
  for (let cycle = 0; cycle < 10; cycle++) {
    const cloned = structuredClone(testBatch);
    const index = buildTileIndexFromBinary(cloned, TILE_OPTIONS);
    const t = index.getTile(0, 0, 0);
  }
  const finalMem = getMemoryMB();
  const deltaMB = finalMem - initMem;
  const RETENTION_THRESHOLD_MB = 50.0;
  console.log(
    `Initial Heap: ${initMem.toFixed(2)} MB -> Final Heap: ${finalMem.toFixed(2)} MB (Delta: ${deltaMB.toFixed(2)} MB, Threshold: ${RETENTION_THRESHOLD_MB.toFixed(2)} MB)`,
  );

  if (deltaMB > RETENTION_THRESHOLD_MB) {
    console.error(
      `Memory retention test: FAILED (Delta ${deltaMB.toFixed(2)} MB exceeded threshold ${RETENTION_THRESHOLD_MB.toFixed(2)} MB)`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Memory retention test: PASSED (Delta ${deltaMB.toFixed(2)} MB within threshold ${RETENTION_THRESHOLD_MB.toFixed(2)} MB)`,
    );
  }

  console.log("\n=== FINAL BENCHMARK SUMMARY TABLE ===");
  console.table(summary);
}

runAll().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
