import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeLinkUrl } from "@geolibre/core";

describe("attributeLinkUrl", () => {
  it("accepts a whole http(s) URL", () => {
    assert.equal(attributeLinkUrl("https://www.bbc.co.uk/"), "https://www.bbc.co.uk/");
    assert.equal(attributeLinkUrl("http://example.com"), "http://example.com");
    assert.equal(
      attributeLinkUrl("https://earthquake.usgs.gov/earthquakes/eventpage/us7000szf3"),
      "https://earthquake.usgs.gov/earthquakes/eventpage/us7000szf3",
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(attributeLinkUrl("  https://example.com/a?b=1#c "), "https://example.com/a?b=1#c");
  });

  it("is case-insensitive about the scheme", () => {
    assert.equal(attributeLinkUrl("HTTPS://Example.com/x"), "HTTPS://Example.com/x");
  });

  it("rejects prose that merely mentions a link", () => {
    assert.equal(attributeLinkUrl("see https://example.com for details"), null);
    assert.equal(attributeLinkUrl("https://example.com https://other.com"), null);
  });

  it("rejects schemes that must never reach an opener", () => {
    assert.equal(attributeLinkUrl("javascript:alert(1)"), null);
    assert.equal(attributeLinkUrl("file:///etc/passwd"), null);
    assert.equal(attributeLinkUrl("data:text/html,<script>alert(1)</script>"), null);
    // mailto: is a real link but not one openExternalLink can open, so the
    // popup leaves it as text rather than rendering a dead anchor.
    assert.equal(attributeLinkUrl("mailto:someone@example.com"), null);
  });

  it("rejects shapes with no authority to open", () => {
    assert.equal(attributeLinkUrl("https:"), null);
    assert.equal(attributeLinkUrl("https://"), null);
    assert.equal(attributeLinkUrl("https:///path"), null);
    assert.equal(attributeLinkUrl("www.example.com"), null);
  });

  it("rejects non-string and empty values", () => {
    assert.equal(attributeLinkUrl(null), null);
    assert.equal(attributeLinkUrl(undefined), null);
    assert.equal(attributeLinkUrl(42), null);
    assert.equal(attributeLinkUrl({ href: "https://example.com" }), null);
    assert.equal(attributeLinkUrl(""), null);
    assert.equal(attributeLinkUrl("   "), null);
  });

  it("leaves an inline image data URL alone so it still renders as a thumbnail", () => {
    assert.equal(attributeLinkUrl("data:image/png;base64,iVBORw0KGgo="), null);
  });
});
