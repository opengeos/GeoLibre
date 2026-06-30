import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureHtmlFileName,
  ensureProjectFileName,
} from "../apps/geolibre-desktop/src/lib/file-names";

describe("ensureHtmlFileName", () => {
  it("falls back to the slug-based name when blank", () => {
    assert.equal(ensureHtmlFileName("", "my-map"), "my-map.html");
    assert.equal(ensureHtmlFileName("   ", "my-map"), "my-map.html");
  });

  it("falls back to the slug-based name for a dots-only name", () => {
    // A bare "." would otherwise become "..html"; treat it as no usable base.
    assert.equal(ensureHtmlFileName(".", "my-map"), "my-map.html");
    assert.equal(ensureHtmlFileName("..", "my-map"), "my-map.html");
  });

  it("appends .html when no HTML extension is present", () => {
    assert.equal(ensureHtmlFileName("report", "map"), "report.html");
    assert.equal(ensureHtmlFileName("  report  ", "map"), "report.html");
  });

  it("keeps an existing .html or .htm extension as-is", () => {
    assert.equal(ensureHtmlFileName("page.html", "map"), "page.html");
    assert.equal(ensureHtmlFileName("page.htm", "map"), "page.htm");
  });

  it("treats the extension case-insensitively", () => {
    assert.equal(ensureHtmlFileName("PAGE.HTML", "map"), "PAGE.HTML");
    assert.equal(ensureHtmlFileName("Page.Htm", "map"), "Page.Htm");
  });

  it("appends .html when a non-HTML dot suffix is present", () => {
    assert.equal(ensureHtmlFileName("my.map", "fallback"), "my.map.html");
    assert.equal(ensureHtmlFileName("data.json", "fallback"), "data.json.html");
  });
});

describe("ensureProjectFileName", () => {
  it("defaults to the project name when blank", () => {
    assert.match(ensureProjectFileName(""), /\.geolibre\.json$/);
    assert.match(ensureProjectFileName("   "), /\.geolibre\.json$/);
  });

  it("appends .geolibre.json when no recognized extension is present", () => {
    assert.equal(ensureProjectFileName("trip"), "trip.geolibre.json");
  });

  it("keeps a recognized extension as-is", () => {
    assert.equal(ensureProjectFileName("a.geolibre.json"), "a.geolibre.json");
    assert.equal(ensureProjectFileName("a.geolibre"), "a.geolibre");
    assert.equal(ensureProjectFileName("a.json"), "a.json");
  });
});
