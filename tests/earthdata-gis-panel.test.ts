import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldAutoLoad } from "../packages/plugins/src/plugins/maplibre-earthdata-gis";

describe("shouldAutoLoad (Earthdata GIS results paging)", () => {
  const base = { intersecting: true, nextStart: 21, loading: false, paused: false };

  it("loads the next page when the end of the list is in view", () => {
    assert.equal(shouldAutoLoad(base), true);
  });

  it("waits while the end of the list is out of view", () => {
    assert.equal(shouldAutoLoad({ ...base, intersecting: false }), false);
  });

  it("stops after the last page", () => {
    assert.equal(shouldAutoLoad({ ...base, nextStart: null }), false);
  });

  it("does not stack a request on one in flight", () => {
    assert.equal(shouldAutoLoad({ ...base, loading: true }), false);
  });

  it("does not retry a failed page in a loop", () => {
    assert.equal(shouldAutoLoad({ ...base, paused: true }), false);
  });
});
