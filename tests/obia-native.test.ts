import "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { setSidecarFetch } from "@geolibre/processing";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  DEFAULT_OBIA_NATIVE_PARAMS,
  nativeSegmentation,
  obiaLocalPath,
  runNativeMeasure,
  runNativeSegmentation,
} from "../apps/geolibre-desktop/src/lib/obia/obia-native";

const layer = (patch: Partial<GeoLibreLayer>) =>
  ({ id: "a", name: "a", type: "cog", source: {}, metadata: {}, ...patch }) as GeoLibreLayer;

/**
 * A fake sidecar: jobs finish on their second poll; `jobs` records each
 * request body and `cancelled` each cancel.
 */
function fakeSidecar(files: Record<string, string>, finalStatus = "succeeded") {
  const bodies: unknown[] = [];
  const cancelled: string[] = [];
  const polls = new Map<string, number>();
  const job = (id: string, status: string, result: unknown = null) => ({
    id,
    status,
    tool_id: id,
    created_at: "",
    updated_at: "",
    messages: [],
    outputs: {},
    result,
    error: status === "failed" ? "Segmentation failed." : null,
  });
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  setSidecarFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/obia/segment") || url.endsWith("/obia/measure")) {
      bodies.push(JSON.parse(String(init?.body)));
      return json(job(url.endsWith("segment") ? "obia-segment" : "obia-measure", "pending"));
    }
    const poll = /\/conversion\/jobs\/([\w-]+)$/.exec(url);
    if (poll) {
      const count = (polls.get(poll[1]) ?? 0) + 1;
      polls.set(poll[1], count);
      return json(
        count < 2
          ? job(poll[1], "running")
          : job(poll[1], finalStatus, { object_count: 2, width: 6, height: 4, pixel_size: 10 }),
      );
    }
    const cancel = /\/obia\/jobs\/([\w-]+)\/cancel$/.exec(url);
    if (cancel) {
      cancelled.push(cancel[1]);
      return json({});
    }
    const file = /\/files\/([\w.]+)$/.exec(url);
    if (file && files[file[1]] != null) return new Response(files[file[1]]);
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
  return { bodies, cancelled };
}

afterEach(() => {
  setSidecarFetch(null);
  mock.timers.reset();
});

/** Run a job-polling call, advancing the fake clock between polls. */
async function withClock<T>(run: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const promise = run();
    // The caller asserts on it; do not let an early rejection go unhandled.
    promise.catch(() => {});
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(1000);
    }
    return await promise;
  } finally {
    mock.timers.reset();
  }
}

describe("native OBIA", () => {
  it("reads only local GeoTIFF files", () => {
    assert.equal(obiaLocalPath(layer({ sourcePath: "/data/naip.tif" })), "/data/naip.tif");
    assert.equal(
      obiaLocalPath(layer({ sourcePath: "C:\\data\\naip.TIFF" })),
      "C:\\data\\naip.TIFF",
    );
    assert.equal(obiaLocalPath(layer({ sourcePath: "https://host/naip.tif" })), null);
    assert.equal(obiaLocalPath(layer({ sourcePath: "/data/naip.png" })), null);
    assert.equal(obiaLocalPath(layer({})), null);
  });

  it("builds the request for the chosen method only", () => {
    const request = nativeSegmentation(
      "/data/naip.tif",
      [4, 1],
      { level: 1, window: [0, 0, 10, 10] },
      "felzenszwalb",
      DEFAULT_OBIA_NATIVE_PARAMS,
    );
    assert.deepEqual(request, {
      input_path: "/data/naip.tif",
      bands: [4, 1],
      area: { level: 1, window: [0, 0, 10, 10] },
      method: "felzenszwalb",
      slic: null,
      felzenszwalb: { scale: 100, sigma: 0.5, min_size: 50 },
    });
  });

  it("segments, downloads the results and records the call without the path", async () => {
    const objects = { type: "FeatureCollection", features: [] };
    const sidecar = fakeSidecar({
      "segments.tif": "TIFF",
      "objects.geojson": JSON.stringify(objects),
    });
    const steps: string[] = [];
    const request = nativeSegmentation(
      "/data/naip.tif",
      [1],
      undefined,
      "slic",
      DEFAULT_OBIA_NATIVE_PARAMS,
    );
    const result = await withClock(() =>
      runNativeSegmentation(request, { onStep: (step) => steps.push(step) }),
    );
    assert.deepEqual(sidecar.bodies, [request]);
    assert.equal(result.objectCount, 2);
    assert.equal(new TextDecoder().decode(result.labels), "TIFF");
    assert.deepEqual(result.objects, objects);
    assert.equal(result.call.tool, "obia/segment");
    assert.ok(!result.call.args[0].includes("/data/naip.tif"), "no local path in provenance");
    assert.deepEqual(steps, ["obia-segment"]);
  });

  it("measures into a feature table with the band-mean indices", async () => {
    const sidecar = fakeSidecar({
      "features.csv": "segment_id,mean_b1,mean_b4\n1,10,30\n2,20,20\n",
    });
    const request = nativeSegmentation(
      "/data/naip.tif",
      [1, 4],
      undefined,
      "slic",
      DEFAULT_OBIA_NATIVE_PARAMS,
    );
    const { table } = await withClock(() =>
      runNativeMeasure(
        request,
        {
          spectral: true,
          shape: false,
          context: false,
          textureBand: 1,
          indices: { red: 1, nir: 4 },
        },
        "job-1",
      ),
    );
    assert.deepEqual(sidecar.bodies[0], {
      segmentation: request,
      options: { spectral: true, shape: false, context: false },
      segment_job_id: "job-1",
    });
    assert.equal(table.rows.get(1)?.ndvi, 0.5);
  });

  it("reports a failed job and cancels a cancelled one", async () => {
    fakeSidecar({}, "failed");
    const request = nativeSegmentation(
      "/data/naip.tif",
      [1],
      undefined,
      "slic",
      DEFAULT_OBIA_NATIVE_PARAMS,
    );
    await assert.rejects(
      withClock(() => runNativeSegmentation(request)),
      /Segmentation failed/,
    );

    const sidecar = fakeSidecar({});
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runNativeSegmentation(request, { signal: controller.signal }),
      (err: Error) => err.name === "AbortError",
    );
    assert.equal(sidecar.cancelled.length, 0, "a job never started is not cancelled");
    // Cancel while the job runs: the sidecar is told to stop it.
    mock.timers.enable({ apis: ["setTimeout"] });
    const running = new AbortController();
    const pending = runNativeSegmentation(request, { signal: running.signal });
    pending.catch(() => {});
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
    running.abort();
    mock.timers.tick(1000);
    await assert.rejects(pending, (err: Error) => err.name === "AbortError");
    assert.ok(sidecar.cancelled.includes("obia-segment"));
  });
});

describe("native OBIA status", () => {
  it("asks again after an unavailable answer, and keeps an available one", async () => {
    const { obiaNativeStatus } = await import("../apps/geolibre-desktop/src/lib/obia/obia-native");
    let available = false;
    let calls = 0;
    setSidecarFetch((async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ available, message: "", max_pixels: { slic: 10, felzenszwalb: 5 } }),
      );
    }) as typeof fetch);
    assert.equal((await obiaNativeStatus())?.available, false);
    available = true;
    assert.equal((await obiaNativeStatus())?.available, true);
    assert.deepEqual((await obiaNativeStatus())?.maxPixels, { slic: 10, felzenszwalb: 5 });
    assert.equal(calls, 2, "a success is cached");
  });
});
