import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRasterMarkerSource,
  isSvgMarkerResponse,
  resolveSvgSource,
} from "../packages/core/src/marker-shape";

describe("resolveSvgSource", () => {
  it("encodes inline markup as a data URL", () => {
    const source = resolveSvgSource("<svg><circle r='4'/></svg>");
    assert.ok(source?.startsWith("data:image/svg+xml;charset=utf-8,"));
    assert.equal(
      decodeURIComponent(source!.slice("data:image/svg+xml;charset=utf-8,".length)),
      "<svg><circle r='4'/></svg>",
    );
  });

  it("passes an http(s) URL through untouched", () => {
    // Re-encoding a URL as a data URL is what left the on-map legend's marker
    // chip blank while the map drew the same marker fine (GH discussion #1711).
    const url = "https://example.com/bee.svg";
    assert.equal(resolveSvgSource(url), url);
  });

  it("passes a data: URL through untouched rather than double-encoding it", () => {
    const url = "data:image/svg+xml;base64,PHN2Zy8+";
    assert.equal(resolveSvgSource(url), url);
  });

  it("rejects blank input and unsupported schemes", () => {
    assert.equal(resolveSvgSource("   "), null);
    assert.equal(resolveSvgSource("file:///etc/passwd"), null);
    assert.equal(resolveSvgSource("javascript:alert(1)"), null);
  });
});

describe("isRasterMarkerSource", () => {
  it("recognizes raster data URLs and raster file URLs", () => {
    assert.equal(isRasterMarkerSource("data:image/png;base64,AA=="), true);
    assert.equal(isRasterMarkerSource("data:image/jpeg;base64,AA=="), true);
    assert.equal(isRasterMarkerSource("https://example.com/a/sign.PNG"), true);
    assert.equal(isRasterMarkerSource("https://example.com/photo.jpg?w=64#x"), true);
    assert.equal(isRasterMarkerSource("http://example.com/anim.gif"), true);
  });

  it("leaves SVG and unclassifiable sources to the SVG path", () => {
    assert.equal(isRasterMarkerSource("<svg/>"), false);
    assert.equal(isRasterMarkerSource("data:image/svg+xml;base64,PHN2Zy8+"), false);
    assert.equal(isRasterMarkerSource("https://example.com/tree.svg"), false);
    assert.equal(isRasterMarkerSource("https://example.com/icon?id=7"), false);
    assert.equal(isRasterMarkerSource("https://example.com/icon.png.svg"), false);
    assert.equal(isRasterMarkerSource(""), false);
  });
});

describe("isSvgMarkerResponse", () => {
  it("trusts an image content type over the extension", () => {
    assert.equal(isSvgMarkerResponse("https://x.org/a", "image/svg+xml; charset=utf-8"), true);
    assert.equal(isSvgMarkerResponse("https://x.org/a.svg", "image/png"), false);
  });

  it("reads text and XML responses as SVG", () => {
    assert.equal(isSvgMarkerResponse("https://x.org/a", "text/plain; charset=utf-8"), true);
    assert.equal(isSvgMarkerResponse("https://x.org/a", "application/xml"), true);
  });

  it("falls back to the extension for a missing or generic content type", () => {
    assert.equal(isSvgMarkerResponse("https://x.org/a.svg?v=1", null), true);
    assert.equal(isSvgMarkerResponse("https://x.org/a.svg", "application/octet-stream"), true);
    assert.equal(isSvgMarkerResponse("https://x.org/a", "application/octet-stream"), false);
  });
});
