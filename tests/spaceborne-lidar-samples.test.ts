import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  baseName,
  downloadWithProgress,
  fieldKey,
  SAMPLE_BASE_URL,
  SAMPLES,
} from "../apps/geolibre-desktop/src/lib/spaceborne-lidar-samples";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve `chunks` as a streamed response with the given headers. */
function serve(chunks: Uint8Array[], headers: Record<string, string>, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status, headers },
    )) as typeof fetch;
}

describe("downloadWithProgress", () => {
  it("fills a preallocated buffer and reports each new percentage", async () => {
    serve([new Uint8Array([1, 2]), new Uint8Array([3, 4])], { "content-length": "4" });
    const seen: number[] = [];
    const buffer = await downloadWithProgress("https://x/a.h5", new AbortController().signal, (p) =>
      seen.push(p),
    );
    assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4]);
    assert.deepEqual(seen, [50, 100]);
  });

  it("reads a content-encoded response whole instead of preallocating", async () => {
    // The announced length is the compressed size, smaller than the stream.
    serve([new Uint8Array([1, 2, 3, 4])], { "content-length": "2", "content-encoding": "gzip" });
    const buffer = await downloadWithProgress(
      "https://x/a.h5",
      new AbortController().signal,
      () => {},
    );
    assert.equal(buffer.byteLength, 4);
  });

  it("rejects an HTTP error", async () => {
    serve([], {}, 404);
    await assert.rejects(
      downloadWithProgress("https://x/a.h5", new AbortController().signal, () => {}),
      /404/,
    );
  });
});

describe("spaceborne LiDAR sample helpers", () => {
  it("lists one HDF5 sample per product under the Source Cooperative folder", () => {
    assert.match(SAMPLE_BASE_URL, /^https:\/\/data\.source\.coop\//);
    assert.deepEqual(
      SAMPLES.map((s) => s.file.slice(0, 8)),
      ["ATL06_20", "ATL08_20", "GEDI02_A", "GEDI02_B", "GEDI04_A"],
    );
    assert.ok(SAMPLES.every((s) => s.file.endsWith(".h5")));
  });

  it("keys 2-D columns apart and strips the extension from names", () => {
    assert.equal(fieldKey({ path: "rh", column: 98 }), "rh[98]");
    assert.equal(fieldKey({ path: "agbd" }), "agbd");
    assert.equal(baseName("/data/GEDI04_A_2022.h5"), "GEDI04_A_2022");
    assert.equal(baseName("C:\\d\\ATL08_x.HDF5"), "ATL08_x");
  });
});
