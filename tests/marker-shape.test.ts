import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSvgSource } from "../packages/core/src/marker-shape";

describe("resolveSvgSource", () => {
  it("encodes inline markup as a data URL", () => {
    const source = resolveSvgSource("<svg><circle r='4'/></svg>");
    assert.ok(source?.startsWith("data:image/svg+xml;charset=utf-8,"));
    assert.equal(
      decodeURIComponent(source.slice("data:image/svg+xml;charset=utf-8,".length)),
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
