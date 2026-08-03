import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeLinkUrl } from "@geolibre/core";

describe("attributeLinkUrl", () => {
  it("accepts whole HTTP and HTTPS URLs", () => {
    assert.equal(attributeLinkUrl("https://www.bbc.co.uk/"), "https://www.bbc.co.uk/");
    assert.equal(attributeLinkUrl("http://example.com"), "http://example.com");
    assert.equal(attributeLinkUrl("  https://example.com/a?b=1#c "), "https://example.com/a?b=1#c");
    assert.equal(attributeLinkUrl("HTTPS://Example.com/x"), "HTTPS://Example.com/x");
  });

  it("rejects prose and unsafe or incomplete URLs", () => {
    assert.equal(attributeLinkUrl("see https://example.com for details"), null);
    assert.equal(attributeLinkUrl("javascript:alert(1)"), null);
    assert.equal(attributeLinkUrl("file:///etc/passwd"), null);
    assert.equal(attributeLinkUrl("data:text/html,hello"), null);
    assert.equal(attributeLinkUrl("mailto:someone@example.com"), null);
    assert.equal(attributeLinkUrl("https://example.com/\u202eevil.test"), null);
    assert.equal(attributeLinkUrl("https:"), null);
    assert.equal(attributeLinkUrl("https://"), null);
    assert.equal(attributeLinkUrl("www.example.com"), null);
  });

  it("rejects non-string and empty values", () => {
    assert.equal(attributeLinkUrl(null), null);
    assert.equal(attributeLinkUrl(42), null);
    assert.equal(attributeLinkUrl({ href: "https://example.com" }), null);
    assert.equal(attributeLinkUrl("   "), null);
  });
});
