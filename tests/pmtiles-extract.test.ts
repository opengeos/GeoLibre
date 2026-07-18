import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { PMTiles } from "pmtiles";
import { initCogWasm } from "../packages/processing/src/cog-convert";
import { extractPmtiles, pmtilesTileTypeKind } from "../packages/processing/src/pmtiles-extract";

// A tiny z0-4 PNG PMTiles archive produced by scripts/gen-pmtiles-fixture.mjs
// from the striped.tif fixture. Small enough to commit; real enough that the
// reference pmtiles reader accepts the extract this suite produces from it.
const archive = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/mini.pmtiles", import.meta.url))),
);

// In the browser wasm-bindgen fetches the bundled asset; under node:test we
// feed it the wasm bytes directly (same pattern as cog-convert.test.ts).
const wasmBytes = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)),
  ),
);

/** A fetch stub serving `bytes` with HTTP Range semantics (206 slices). */
function rangeServer(
  bytes: Uint8Array,
  options?: {
    failFirst?: number;
    ignoreRange?: boolean;
    omitContentLength?: boolean;
    status429First?: number;
  },
): { fetchImpl: typeof fetch; requests: () => number } {
  let requests = 0;
  let failures = options?.failFirst ?? 0;
  let rateLimited = options?.status429First ?? 0;
  const fetchImpl = (async (_url, init) => {
    requests += 1;
    if (failures > 0) {
      failures -= 1;
      throw new TypeError("simulated network failure");
    }
    if (rateLimited > 0) {
      rateLimited -= 1;
      return new Response(null, { status: 429 });
    }
    if (options?.ignoreRange) {
      return new Response(bytes.slice() as unknown as BodyInit, {
        status: 200,
        headers: options?.omitContentLength ? {} : { "content-length": String(bytes.length) },
      });
    }
    const range = /bytes=(\d+)-(\d+)/.exec(String(new Headers(init?.headers).get("range") ?? ""));
    assert.ok(range, "extractor must send a Range header");
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1) as unknown as BodyInit, {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  }) as typeof fetch;
  return { fetchImpl, requests: () => requests };
}

/** Reads a PMTiles archive from bytes via the reference reader. */
function referenceReader(bytes: Uint8Array): PMTiles {
  return new PMTiles({
    getKey: () => "test",
    getBytes: async (offset: number, length: number) => {
      const view = bytes.slice(offset, offset + length);
      return { data: view.buffer };
    },
  });
}

const WORLD_BBOX: [number, number, number, number] = [-180, -85, 180, 85];

describe("extractPmtiles", () => {
  before(async () => {
    await initCogWasm(wasmBytes);
  });

  it("extracts an archive the reference pmtiles reader accepts", async () => {
    const { fetchImpl } = rangeServer(archive);
    const phases: string[] = [];
    const {
      archive: out,
      source,
      progress,
    } = await extractPmtiles("https://example.test/mini.pmtiles", {
      bbox: WORLD_BBOX,
      fetchImpl,
      onProgress: (p) => phases.push(p.phase),
    });

    assert.equal(source.minZoom, 0);
    assert.equal(source.maxZoom, 4);
    assert.equal(pmtilesTileTypeKind(source.tileType), "raster");
    assert.equal(progress.phase, "done");
    assert.ok(progress.tilesSelected > 0);
    assert.ok(phases.includes("data"));

    const reader = referenceReader(out);
    const header = await reader.getHeader();
    assert.equal(header.minZoom, 0);
    assert.equal(header.maxZoom, 4);
    // The source's only populated z4 tile round-trips byte-identically.
    const srcReader = referenceReader(archive);
    for (let z = 0; z <= 4; z++) {
      const n = 2 ** z;
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          const a = await srcReader.getZxy(z, x, y);
          const b = await reader.getZxy(z, x, y);
          assert.equal(Boolean(a), Boolean(b), `tile ${z}/${x}/${y} presence`);
          if (a && b) {
            assert.deepEqual(new Uint8Array(b.data), new Uint8Array(a.data));
          }
        }
      }
    }
  });

  it("respects the zoom range and reports plan details before download", async () => {
    const { fetchImpl } = rangeServer(archive);
    let planned: number | undefined;
    const { archive: out } = await extractPmtiles("https://example.test/mini.pmtiles", {
      bbox: WORLD_BBOX,
      minZoom: 0,
      maxZoom: 2,
      fetchImpl,
      confirmDownload: (p) => {
        planned = p.estimatedOutputBytes;
        return true;
      },
    });
    assert.ok(planned !== undefined && planned > 0, "plan estimate reported");
    const header = await referenceReader(out).getHeader();
    assert.equal(header.maxZoom, 2);
  });

  it("cancels when confirmDownload declines", async () => {
    const { fetchImpl } = rangeServer(archive);
    await assert.rejects(
      extractPmtiles("https://example.test/mini.pmtiles", {
        bbox: WORLD_BBOX,
        fetchImpl,
        confirmDownload: () => false,
      }),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
  });

  it("aborts via AbortSignal", async () => {
    const controller = new AbortController();
    const { fetchImpl } = rangeServer(archive);
    await assert.rejects(
      extractPmtiles("https://example.test/mini.pmtiles", {
        bbox: WORLD_BBOX,
        fetchImpl,
        signal: controller.signal,
        confirmDownload: () => {
          controller.abort();
          return true;
        },
      }),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
  });

  it("retries transient network failures", async () => {
    const { fetchImpl, requests } = rangeServer(archive, { failFirst: 1 });
    const { archive: out } = await extractPmtiles("https://example.test/mini.pmtiles", {
      bbox: WORLD_BBOX,
      fetchImpl,
    });
    assert.ok(out.length > 0);
    assert.ok(requests() >= 2, "the failed request must be retried");
  });

  it("falls back to slicing a small full-body 200 response", async () => {
    const { fetchImpl } = rangeServer(archive, { ignoreRange: true });
    const { archive: out } = await extractPmtiles("https://example.test/mini.pmtiles", {
      bbox: WORLD_BBOX,
      fetchImpl,
    });
    const header = await referenceReader(out).getHeader();
    assert.equal(header.maxZoom, 4);
  });

  it("rejects a range-less 200 without a content-length instead of buffering it", async () => {
    const { fetchImpl } = rangeServer(archive, {
      ignoreRange: true,
      omitContentLength: true,
    });
    await assert.rejects(
      extractPmtiles("https://example.test/mini.pmtiles", {
        bbox: WORLD_BBOX,
        fetchImpl,
      }),
      /range requests/i,
    );
  });

  it("retries HTTP 429 rate limiting", async () => {
    const { fetchImpl, requests } = rangeServer(archive, { status429First: 1 });
    const { archive: out } = await extractPmtiles("https://example.test/mini.pmtiles", {
      bbox: WORLD_BBOX,
      fetchImpl,
    });
    assert.ok(out.length > 0);
    assert.ok(requests() >= 2, "a 429 must be retried");
  });

  it("surfaces a clear error for an empty selection", async () => {
    const { fetchImpl } = rangeServer(archive);
    await assert.rejects(
      extractPmtiles("https://example.test/mini.pmtiles", {
        bbox: WORLD_BBOX,
        minZoom: 9,
        maxZoom: 12,
        fetchImpl,
      }),
      /zoom/i,
    );
  });
});
