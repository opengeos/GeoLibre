import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeComponentsProjectState } from "../packages/plugins/src/plugins/components/gui-state";
import {
  DEFAULT_IMAGE_STATE,
  formatAspectRatio,
  imageLayout,
  MAX_IMAGE_CONTROLS,
  normalizeImageState,
  normalizeImageStates,
  normalizeImageUrl,
  parseAspectRatio,
  ratioHeight,
} from "../packages/plugins/src/plugins/components/image-model";

describe("Image control model", () => {
  it("accepts only absolute https URLs", () => {
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

  it("keeps the height a ratio implies within the size limits", () => {
    assert.equal(ratioHeight(300, 2), 150);
    assert.equal(ratioHeight(2000, 0.1), 2000);
    assert.equal(ratioHeight(20, 10), 16);
    assert.equal(
      imageLayout({ sizeMode: "ratio", width: 2000, height: 100, ratio: 0.1 }).height,
      "2000px",
    );
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
      collapsed: "yes",
      title: 5,
    });
    assert.deepEqual(state, {
      ...DEFAULT_IMAGE_STATE,
      id: "image-1",
      width: 2000,
      ratio: 0.1,
      url: "",
    });
    const kept = normalizeImageState({
      id: "logo",
      title: "North arrow",
      url: "https://x.example/a.png",
      sizeMode: "ratio",
      width: 320,
      height: 100,
      ratio: 1.5,
      position: "top-right",
      collapsed: true,
    });
    assert.deepEqual(kept, {
      id: "logo",
      title: "North arrow",
      url: "https://x.example/a.png",
      sizeMode: "ratio",
      width: 320,
      height: 100,
      ratio: 1.5,
      position: "top-right",
      collapsed: true,
    });
  });

  it("keeps several images, dropping unusable ones and renaming duplicate ids", () => {
    assert.equal(normalizeImageStates("nope"), undefined);
    const images = normalizeImageStates([
      { id: "a", url: "https://x.example/1.png" },
      { id: "a", url: "https://x.example/2.png", collapsed: true },
      { url: "javascript:alert(1)" },
      { url: "https://x.example/3.png" },
      "junk",
    ]);
    assert.deepEqual(
      images?.map((image) => [image.id, image.url, image.collapsed]),
      [
        ["a", "https://x.example/1.png", false],
        ["a-2", "https://x.example/2.png", true],
        ["image-4", "https://x.example/3.png", false],
      ],
    );
  });

  it("caps the number of images", () => {
    const many = Array.from({ length: MAX_IMAGE_CONTROLS + 5 }, (_, i) => ({
      id: `i${i}`,
      url: `https://x.example/${i}.png`,
    }));
    assert.equal(normalizeImageStates(many)?.length, MAX_IMAGE_CONTROLS);
  });

  it("is part of the Components project state", () => {
    const normalized = normalizeComponentsProjectState({
      images: [{ id: "a", url: "https://x.example/a.png" }],
    });
    assert.equal(normalized?.images?.[0]?.url, "https://x.example/a.png");
    assert.equal(normalizeComponentsProjectState({})?.images, undefined);
  });
});
