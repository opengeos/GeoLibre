import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getNasaEarthdataControlOptions } from "../packages/plugins/src/plugins/maplibre-nasa-earthdata";

describe("NASA Earthdata control options", () => {
  // GIBS sometimes advertises a default date with no imagery behind it, so a
  // panel Add must probe and fall back to an earlier date (GeoLibre#3259). The
  // control does that itself (maplibre-gl-nasa-earthdata 0.2+) only when asked.
  it("turns on the default-date fallback", () => {
    assert.equal(getNasaEarthdataControlOptions().defaultDateFallback, true);
  });
});
