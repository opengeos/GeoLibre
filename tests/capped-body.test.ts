import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readBodyBytesWithCap } from "../apps/geolibre-desktop/src/lib/capped-body";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe("readBodyBytesWithCap", () => {
  it("returns the body when it fits under the cap", async () => {
    const response = new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
    const bytes = await readBodyBytesWithCap(response, 16, "test");
    assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  });

  it("refuses a declared content-length over the cap", async () => {
    const response = new Response(streamOf([new Uint8Array([1])]), {
      headers: { "content-length": "99" },
    });
    await assert.rejects(readBodyBytesWithCap(response, 16, "test"), /size limit/);
  });

  it("refuses a chunked body that crosses the cap", async () => {
    const response = new Response(streamOf([new Uint8Array(10), new Uint8Array(10)]));
    await assert.rejects(readBodyBytesWithCap(response, 16, "test"), /size limit/);
  });

  it("accepts a body of exactly the cap", async () => {
    const response = new Response(streamOf([new Uint8Array(16)]));
    const bytes = await readBodyBytesWithCap(response, 16, "test");
    assert.equal(bytes.byteLength, 16);
  });

  it("reads a body that has no stream", async () => {
    const response = new Response(new Uint8Array([7, 8, 9]));
    const bytes = await readBodyBytesWithCap(response, 16, "test");
    assert.deepEqual(Array.from(bytes), [7, 8, 9]);
  });

  it("falls back to arrayBuffer when the response has no stream", async () => {
    const response = {
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]),
    } as unknown as Response;
    const bytes = await readBodyBytesWithCap(response, 16, "test");
    assert.deepEqual(Array.from(bytes), [1, 2, 3]);
  });

  it("refuses an oversized body that only exposes arrayBuffer", async () => {
    const response = {
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array(32),
    } as unknown as Response;
    await assert.rejects(readBodyBytesWithCap(response, 16, "test"), /size limit/);
  });

  it("falls back to text when the response exposes neither stream nor bytes", async () => {
    const response = {
      headers: new Headers(),
      text: async () => "hi",
    } as unknown as Response;
    const bytes = await readBodyBytesWithCap(response, 16, "test");
    assert.equal(new TextDecoder().decode(bytes), "hi");
  });

  it("propagates a stream error instead of reporting it as over-cap", async () => {
    const failure = new Error("connection reset");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      pull(controller) {
        controller.error(failure);
      },
    });
    await assert.rejects(readBodyBytesWithCap(new Response(body), 16, "test"), /connection reset/);
  });
});
