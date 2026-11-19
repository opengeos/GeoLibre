import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_MOBILE_PIXEL_RATIO,
  resolveMapPixelRatio,
} from "../packages/map/src/mobile-pixel-ratio";

describe("resolveMapPixelRatio", () => {
  it("caps high-DPR touch devices at MAX_MOBILE_PIXEL_RATIO", () => {
    assert.equal(
      resolveMapPixelRatio({ devicePixelRatio: 3, isTouchDevice: true }),
      MAX_MOBILE_PIXEL_RATIO,
    );
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 1.5, isTouchDevice: true }), 1.5);
  });

  it("leaves desktop devicePixelRatio uncapped", () => {
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 3, isTouchDevice: false }), 3);
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 2, isTouchDevice: false }), 2);
  });

  it("handles missing or invalid pixel ratios safely", () => {
    assert.equal(resolveMapPixelRatio({ devicePixelRatio: 0, isTouchDevice: true }), undefined);
    assert.equal(
      resolveMapPixelRatio({ devicePixelRatio: Number.NaN, isTouchDevice: true }),
      undefined,
    );
  });
});
