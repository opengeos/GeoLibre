import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KerchunkReferenceStore,
  normalizeKerchunkReference,
  listKerchunkVariables,
  loadKerchunkReference,
  type KerchunkRefs,
} from "../packages/plugins/src/plugins/kerchunk-reference-store";

function utf8(bytes: Uint8Array | undefined): string {
  return new TextDecoder().decode(bytes);
}

// A minimal fake fetch returning a 206 over a fixed buffer, recording the Range.
function fakeRangeFetch(buffer: Uint8Array) {
  const calls: { url: string; range?: string }[] = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range;
    calls.push({ url, range });
    let slice = buffer;
    if (range) {
      const m = /bytes=(\d+)-(\d+)/.exec(range)!;
      slice = buffer.slice(Number(m[1]), Number(m[2]) + 1);
    }
    return {
      status: range ? 206 : 200,
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    };
  };
  return { fetchImpl, calls };
}

describe("KerchunkReferenceStore.get", () => {
  it("returns inline JSON metadata as UTF-8 bytes", async () => {
    const refs: KerchunkRefs = { ".zgroup": '{"zarr_format":2}' };
    const store = new KerchunkReferenceStore(refs);
    assert.equal(utf8(await store.get(".zgroup")), '{"zarr_format":2}');
  });

  it("decodes base64 inline binary", async () => {
    const raw = new Uint8Array([1, 2, 3, 250]);
    const b64 = Buffer.from(raw).toString("base64");
    const store = new KerchunkReferenceStore({ "lat/0": `base64:${b64}` });
    assert.deepEqual([...(await store.get("lat/0"))!], [1, 2, 3, 250]);
  });

  it("normalizes a leading slash in the key", async () => {
    const store = new KerchunkReferenceStore({
      "air/.zarray": '{"shape":[2,2]}',
    });
    assert.equal(utf8(await store.get("/air/.zarray")), '{"shape":[2,2]}');
  });

  it("returns undefined for a missing key", async () => {
    const store = new KerchunkReferenceStore({});
    assert.equal(await store.get("/nope"), undefined);
  });

  it("does an HTTP byte-range read for chunk refs", async () => {
    const file = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17]);
    const { fetchImpl, calls } = fakeRangeFetch(file);
    const store = new KerchunkReferenceStore(
      { "air/0.0.0": ["http://data/air.nc", 2, 3] },
      { fetchImpl },
    );
    const bytes = await store.get("air/0.0.0");
    assert.deepEqual([...bytes!], [12, 13, 14]);
    assert.equal(calls[0].url, "http://data/air.nc");
    assert.equal(calls[0].range, "bytes=2-4");
  });

  it("throws when range fetch returns an unexpected HTTP status", async () => {
    const fetchImpl = async () => ({
      status: 416,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const store = new KerchunkReferenceStore(
      { "air/0.0.0": ["http://data/air.nc", 2, 3] },
      { fetchImpl },
    );
    await assert.rejects(() => store.get("air/0.0.0"), /Kerchunk range read failed/);
  });

  it("merges custom headers into range requests", async () => {
    const { fetchImpl, calls } = fakeRangeFetch(new Uint8Array([0, 0, 0, 0]));
    const captured: Record<string, string>[] = [];
    const wrapped = async (url: string, init?: { headers?: Record<string, string> }) => {
      captured.push(init?.headers ?? {});
      return fetchImpl(url, init);
    };
    const store = new KerchunkReferenceStore(
      { "v/0": ["http://d/x", 0, 2] },
      { fetchImpl: wrapped, headers: { Authorization: "Bearer t" } },
    );
    await store.get("v/0");
    assert.equal(captured[0].Authorization, "Bearer t");
    assert.match(captured[0].Range, /^bytes=/);
    assert.ok(calls.length === 1);
  });
});

describe("normalizeKerchunkReference", () => {
  it("unwraps the v1 { version, refs } envelope", () => {
    const refs = normalizeKerchunkReference({
      version: 1,
      refs: { ".zgroup": '{"zarr_format":2}' },
    });
    assert.equal(refs[".zgroup"], '{"zarr_format":2}');
  });

  it("accepts a flat v0 reference map", () => {
    const refs = normalizeKerchunkReference({
      ".zgroup": '{"zarr_format":2}',
      "air/0.0.0": ["http://d/air.nc", 0, 5],
    });
    assert.deepEqual(refs["air/0.0.0"], ["http://d/air.nc", 0, 5]);
  });

  it("resolves relative chunk URLs against the reference URL", () => {
    const refs = normalizeKerchunkReference(
      { version: 1, refs: { "air/0.0.0": ["air.nc", 10, 20] } },
      "https://host.example/data/air.kerchunk.json",
    );
    assert.deepEqual(refs["air/0.0.0"], ["https://host.example/data/air.nc", 10, 20]);
  });

  it("leaves absolute chunk URLs unchanged", () => {
    const refs = normalizeKerchunkReference(
      { version: 1, refs: { "air/0.0.0": ["s3://bucket/air.nc", 1, 2] } },
      "https://host.example/ref.json",
    );
    assert.equal((refs["air/0.0.0"] as string[])[0], "s3://bucket/air.nc");
  });

  it("rejects templated references", () => {
    assert.throws(
      () =>
        normalizeKerchunkReference({
          version: 1,
          refs: {},
          templates: { u: "http://d/{}" },
        }),
      /templated/i,
    );
  });

  it("accepts an empty templates object (a no-op)", () => {
    const refs = normalizeKerchunkReference({
      version: 1,
      refs: { ".zgroup": '{"zarr_format":2}' },
      templates: {},
    });
    assert.equal(refs[".zgroup"], '{"zarr_format":2}');
  });

  it("does not resolve an empty chunk URL to the manifest itself", () => {
    const refs = normalizeKerchunkReference(
      { version: 1, refs: { "air/0.0.0": ["", 0, 5] } },
      "https://host.example/ref.json",
    );
    assert.equal((refs["air/0.0.0"] as [string, number, number])[0], "");
  });

  it("rejects a length-2 array ref (ambiguous: not whole-file or range)", () => {
    assert.throws(
      () =>
        normalizeKerchunkReference({
          version: 1,
          refs: { "air/0.0.0": ["air.nc", 10] as unknown as [string] },
        }),
      /got 2/,
    );
  });

  it("rejects an array ref with non-numeric offset/length", () => {
    assert.throws(
      () =>
        normalizeKerchunkReference({
          version: 1,
          refs: {
            "air/0.0.0": ["air.nc", "x", 5] as unknown as [string, number, number],
          },
        }),
      /must be numbers/,
    );
  });

  it("rejects a ref value that is neither a string nor an array", () => {
    assert.throws(
      () =>
        normalizeKerchunkReference({
          version: 1,
          refs: { "air/.zattrs": 42 as unknown as string },
        }),
      /unexpected value type/,
    );
  });

  it("throws when there are no refs", () => {
    assert.throws(() => normalizeKerchunkReference({ version: 1 }), /no `refs`/);
  });
});

describe("listKerchunkVariables", () => {
  const refs: KerchunkRefs = {
    ".zgroup": '{"zarr_format":2}',
    "air/.zarray": '{"shape":[200,25,53],"dtype":"<f8"}',
    "air/.zattrs": '{"_ARRAY_DIMENSIONS":["time","lat","lon"]}',
    "lat/.zarray": '{"shape":[25],"dtype":"<f4"}',
    "lat/0": "base64:AAA=",
    "lon/.zarray": '{"shape":[53],"dtype":"<f4"}',
  };

  it("returns gridded arrays (>=2 dims) and excludes 1-D coordinates", () => {
    const vars = listKerchunkVariables(refs);
    assert.deepEqual(
      vars.map((v) => v.name),
      ["air"],
    );
  });

  it("reports dimension names and shape", () => {
    const [air] = listKerchunkVariables(refs);
    assert.deepEqual(air.dims, ["time", "lat", "lon"]);
    assert.deepEqual(air.shape, [200, 25, 53]);
  });
});

describe("loadKerchunkReference", () => {
  it("fetches, parses, and normalizes a manifest", async () => {
    const doc = JSON.stringify({
      version: 1,
      refs: { "air/0.0.0": ["air.nc", 0, 4] },
    });
    const fetchImpl = async () => ({
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(doc).buffer as ArrayBuffer,
    });
    const refs = await loadKerchunkReference("https://h.example/d/ref.json", {
      fetchImpl,
    });
    assert.deepEqual(refs["air/0.0.0"], ["https://h.example/d/air.nc", 0, 4]);
  });

  it("forwards custom headers to the manifest fetch", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl = async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      return {
        status: 200,
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify({ version: 1, refs: {} })).buffer as ArrayBuffer,
      };
    };
    await loadKerchunkReference("https://h.example/d/ref.json", {
      fetchImpl,
      headers: { Authorization: "Bearer t" },
    });
    assert.equal(seen[0]?.Authorization, "Bearer t");
  });

  it("throws on a non-200 response", async () => {
    const fetchImpl = async () => ({
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await assert.rejects(
      () => loadKerchunkReference("https://h/ref.json", { fetchImpl }),
      /HTTP 404/,
    );
  });

  it("rejects when the response body is not valid JSON", async () => {
    const fetchImpl = async () => ({
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("not json").buffer as ArrayBuffer,
    });
    await assert.rejects(
      () => loadKerchunkReference("https://h/ref.json", { fetchImpl }),
      SyntaxError,
    );
  });
});
