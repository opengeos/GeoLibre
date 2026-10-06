import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeComponentsProjectState } from "../packages/plugins/src/plugins/components/gui-state";
import {
  DEFAULT_IMAGE_STATE,
  formatAspectRatio,
  imageLayout,
  normalizeImageState,
  normalizeImageUrl,
  parseAspectRatio,
} from "../packages/plugins/src/plugins/components/image-model";

describe("Image control model", () => {
  it("accepts only absolute http(s) URLs", () => {
    assert.equal(normalizeImageUrl(" https://x.example/a.png "), "https://x.example/a.png");
    for (const bad of [
      "",
      "a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AA",
      "file:///a",
      7,
    ]) {
      assert.equal(normalizeImageUrl(bad), "", String(bad));
    }
  });

  it("parses aspect ratios typed several ways", () => {
    assert.equal(parseAspectRatio("16:9"), 16 / 9);
    assert.equal(parseAspectRatio("16/9"), 16 / 9);
    assert.equal(parseAspectRatio(" 4 x 3 "), 4 / 3);
    assert.equal(parseAspectRatio("1.5"), 1.5);
    for (const bad of ["", "abc", "0:1", "1:0", "100:1", "1:100", "-1", "16:"]) {
      assert.equal(parseAspectRatio(bad), null, bad);
    }
  });

  it("formats common ratios as W:H and others as decimals", () => {
    assert.equal(formatAspectRatio(16 / 9), "16:9");
    assert.equal(formatAspectRatio(4 / 3), "4:3");
    assert.equal(formatAspectRatio(0.5), "1:2");
    assert.equal(formatAspectRatio(1.37), "1.37");
  });

  it("sizes the image by mode", () => {
    const base = { width: 200, height: 100, ratio: 2 };
    assert.deepEqual(imageLayout({ ...base, sizeMode: "auto" }), {
      width: "200px",
      height: "auto",
      objectFit: "contain",
    });
    assert.equal(imageLayout({ ...base, sizeMode: "fixed" }).height, "100px");
    assert.equal(imageLayout({ ...base, sizeMode: "ratio", ratio: 4 }).height, "50px");
  });

  it("normalizes untrusted project state", () => {
    assert.equal(normalizeImageState(null), undefined);
    const state = normalizeImageState({
      url: "javascript:alert(1)",
      sizeMode: "bogus",
      width: 99999,
      height: "x",
      ratio: -3,
      position: "middle",
      visible: "yes",
    });
    assert.deepEqual(state, { ...DEFAULT_IMAGE_STATE, width: 2000, ratio: 0.1, url: "" });
    const kept = normalizeImageState({
      url: "https://x.example/a.png",
      sizeMode: "ratio",
      width: 320,
      height: 100,
      ratio: 1.5,
      position: "top-right",
      visible: false,
    });
    assert.deepEqual(kept, {
      url: "https://x.example/a.png",
      sizeMode: "ratio",
      width: 320,
      height: 100,
      ratio: 1.5,
      position: "top-right",
      visible: false,
    });
  });

  it("is part of the Components project state", () => {
    const normalized = normalizeComponentsProjectState({
      image: { url: "https://x.example/a.png" },
    });
    assert.equal(normalized?.image?.url, "https://x.example/a.png");
    assert.equal(normalizeComponentsProjectState({})?.image, undefined);
  });
});
