import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { isImdfArchiveEntries, isImdfZipBlob, probeImdfZipUrl } from "@geolibre/core";

const venue = () =>
  zipSync({
    "Museum/manifest.json": strToU8("{}"),
    "Museum/unit.geojson": strToU8('{"type":"FeatureCollection","features":[]}'),
  });

describe("imdf-detect", () => {
  it("recognizes IMDF entry lists, ignoring macOS metadata", () => {
    assert.equal(isImdfArchiveEntries(["a/manifest.json", "a/Venue.GeoJSON"]), true);
    assert.equal(isImdfArchiveEntries(["manifest.json", "roads.geojson"]), false);
    assert.equal(isImdfArchiveEntries(["._manifest.json", "unit.geojson"]), false);
  });

  it("reads only the central directory of a Blob", async () => {
    // A stored 2 MB payload, so reading the whole file would show.
    const payload = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
    const bytes = zipSync(
      {
        "Museum/manifest.json": strToU8("{}"),
        "Museum/unit.geojson": [payload, { level: 0 }],
      },
      { level: 0 },
    );
    let read = 0;
    const blob = new Blob([bytes as BlobPart]);
    // Only `size` and `slice` are used, so a minimal stand-in can count reads.
    const spy = {
      size: blob.size,
      slice: (start: number, end: number) => {
        read += end - start;
        return blob.slice(start, end);
      },
    } as unknown as Blob;
    assert.equal(await isImdfZipBlob(spy), true);
    assert.ok(read < 128 * 1024, `read ${read} of ${bytes.byteLength} bytes`);
    assert.equal(await isImdfZipBlob(new Blob(["not a zip"])), false);
  });

  it("probes a URL with range requests", async () => {
    const bytes = venue();
    const ranges: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range") ?? "";
      ranges.push(range);
      const suffix = /^bytes=-(\d+)$/.exec(range);
      const start = suffix ? Math.max(0, bytes.byteLength - Number(suffix[1])) : 0;
      return new Response(new Blob([bytes.subarray(start) as BlobPart]), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${bytes.byteLength - 1}/${bytes.byteLength}` },
      });
    }) as typeof fetch;
    const probe = await probeImdfZipUrl("https://example.org/Museum.zip", fetchImpl);
    assert.deepEqual(probe, { imdf: true });
    assert.ok(ranges[0].startsWith("bytes=-"));
  });
});

describe("probeImdfZipUrl on awkward hosts", () => {
  it("reads the whole archive when ranges work but Content-Range is hidden", async () => {
    const bytes = venue();
    const requests: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      requests.push(range ?? "full");
      // A cross-origin 206 whose Content-Range the browser does not expose.
      if (range) return new Response(new Blob([bytes.subarray(-100) as BlobPart]), { status: 206 });
      return new Response(new Blob([bytes as BlobPart]), { status: 200 });
    }) as typeof fetch;
    const probe = await probeImdfZipUrl("https://example.org/Museum.zip", fetchImpl);
    assert.equal(probe.imdf, true);
    assert.equal(probe.bytes?.byteLength, bytes.byteLength);
    assert.deepEqual(requests, [requests[0], "full"]);
  });

  it("does not download a large zip from a server without range support", async () => {
    let cancelled = false;
    const fetchImpl = (async () => {
      // A body that never ends: reading it would hang, cancelling it ends the probe.
      const body = new ReadableStream({
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(64 * 1024 * 1024) },
      });
    }) as typeof fetch;
    const probe = await probeImdfZipUrl("https://example.org/roads.zip", fetchImpl);
    assert.deepEqual(probe, { imdf: false });
    assert.equal(cancelled, true);
  });
});

describe("probeImdfZipUrl size cap", () => {
  it("stops reading a body without a Content-Length once it passes the cap", async () => {
    let served = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const fetchImpl = (async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          served += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const probe = await probeImdfZipUrl("https://example.org/huge.zip", fetchImpl);
    assert.deepEqual(probe, { imdf: false });
    assert.ok(served <= 40 * 1024 * 1024, `served ${served} bytes`);
  });
});
