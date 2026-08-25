import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KERNEL_RANGE_QUERY,
  rewriteKernelProxyRangeRequest,
} from "../apps/geolibre-desktop/src/lib/kernel-proxy-range";

const marked =
  "https://session-41123-colab.googleusercontent.com/_geolibre_local/token/dem.tif?__geolibre_range_proxy=1";

describe("kernel proxy byte ranges", () => {
  it("moves Range into the query string for a marked Colab-local URL", () => {
    const [input, init] = rewriteKernelProxyRangeRequest(marked, {
      headers: { Range: "bytes=65536-131071", Accept: "image/tiff" },
    });
    const url = new URL(input.toString());
    const headers = new Headers(init?.headers);

    assert.equal(url.searchParams.get(KERNEL_RANGE_QUERY), "bytes=65536-131071");
    assert.equal(headers.get("Range"), null);
    assert.equal(headers.get("Accept"), "image/tiff");
  });

  it("supports a Request input and preserves its options", () => {
    const request = new Request(marked, {
      credentials: "include",
      headers: { Range: "bytes=0-65535" },
    });
    const [input, init] = rewriteKernelProxyRangeRequest(request);

    assert.ok(input instanceof Request);
    assert.equal(new URL(input.url).searchParams.get(KERNEL_RANGE_QUERY), "bytes=0-65535");
    assert.equal(input.credentials, "include");
    assert.equal(new Headers(init?.headers).get("Range"), null);
  });

  it("does not alter ordinary remote COG requests", () => {
    const input = "https://example.com/dem.tif";
    const init = { headers: { Range: "bytes=0-65535" } };
    const rewritten = rewriteKernelProxyRangeRequest(input, init);
    assert.equal(rewritten[0], input);
    assert.equal(rewritten[1], init);
  });
});
