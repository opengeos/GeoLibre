import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCappedBody } from "../apps/geolibre-desktop/src/lib/capped-body";

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

describe("readCappedBody", () => {
  it("returns the body when it fits under the limit", async () => {
    const response = new Response(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
    const bytes = await readCappedBody(response, 16);
    assert.deepEqual(Array.from(bytes ?? []), [1, 2, 3]);
  });

  it("refuses a declared content-length over the limit", async () => {
    const response = new Response(streamOf([new Uint8Array([1])]), {
      headers: { "content-length": "99" },
    });
    assert.equal(await readCappedBody(response, 16), null);
  });

  it("refuses a chunked body that crosses the limit", async () => {
    const response = new Response(streamOf([new Uint8Array(10), new Uint8Array(10)]));
    assert.equal(await readCappedBody(response, 16), null);
  });

  it("accepts a body of exactly the limit", async () => {
    const response = new Response(streamOf([new Uint8Array(16)]));
    const bytes = await readCappedBody(response, 16);
    assert.equal(bytes?.byteLength, 16);
  });

  it("reads a body that has no stream", async () => {
    const response = new Response(new Uint8Array([7, 8, 9]));
    const bytes = await readCappedBody(response, 16);
    assert.deepEqual(Array.from(bytes ?? []), [7, 8, 9]);
  });
});
