import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreProject } from "@geolibre/core";
import {
  buildProjectHtml,
  DEFAULT_VIEWER_BASE_URL,
  resolveViewerBaseUrl,
} from "../apps/geolibre-desktop/src/lib/html-export";

// A minimal project that only exercises the fields the HTML builder touches.
const PROJECT = {
  version: "1.0.0",
  name: "My Map",
  layers: [],
} as unknown as GeoLibreProject;

describe("buildProjectHtml", () => {
  it("frames the viewer with embed=1 and inlines the project", () => {
    const html = buildProjectHtml({
      project: PROJECT,
      title: "My Map",
      appUrl: "https://viewer.geolibre.app/",
    });
    assert.match(html, /<title>My Map<\/title>/);
    assert.match(
      html,
      /<iframe id="geolibre-frame" src="https:\/\/viewer\.geolibre\.app\/\?embed=1"/,
    );
    // The project rides in a JSON <script> block and is replayed over the bridge.
    assert.match(html, /id="geolibre-project"/);
    assert.match(html, /"geolibre:load-project"/);
    assert.match(html, /"geolibre:ready"/);
    // The inlined JSON round-trips back to the original project.
    const json = html.match(
      /<script type="application\/json" id="geolibre-project">([\s\S]*?)<\/script>/,
    );
    assert.ok(json);
    assert.deepEqual(JSON.parse(json[1].replace(/\\u003c/g, "<")), PROJECT);
  });

  it("defaults the app URL to the hosted viewer", () => {
    const html = buildProjectHtml({ project: PROJECT, title: "T" });
    assert.match(html, /src="https:\/\/viewer\.geolibre\.app\/\?embed=1"/);
  });

  it("escapes '<' in the inlined JSON so a value cannot break out", () => {
    const project = {
      version: "1.0.0",
      name: "x</script><img>",
      layers: [],
    } as unknown as GeoLibreProject;
    const html = buildProjectHtml({ project, title: "T" });
    assert.ok(!html.includes("x</script>"));
    // Only "<" is escaped (">" is harmless inside a script element).
    assert.ok(html.includes("x\\u003c/script>\\u003cimg>"));
  });

  it("escapes the title to prevent HTML injection", () => {
    const html = buildProjectHtml({
      project: PROJECT,
      title: "<b>hi</b> & \"q\"",
    });
    assert.match(html, /<title>&lt;b&gt;hi&lt;\/b&gt; &amp; &quot;q&quot;<\/title>/);
    assert.ok(!html.includes("<b>hi</b>"));
  });

  it("uses & to append embed=1 when the app URL already has a query", () => {
    const html = buildProjectHtml({
      project: PROJECT,
      title: "T",
      appUrl: "https://example.com/app?lang=fr",
    });
    // "&" is HTML-escaped to "&amp;" in the attribute (decoded back by browsers).
    assert.match(html, /src="https:\/\/example\.com\/app\?lang=fr&amp;embed=1"/);
  });

  it("inserts embed=1 before a URL fragment", () => {
    const html = buildProjectHtml({
      project: PROJECT,
      title: "T",
      appUrl: "https://example.com/app#/view",
    });
    assert.match(html, /src="https:\/\/example\.com\/app\?embed=1#\/view"/);
  });

  it("rejects unsafe CSS width/height values", () => {
    assert.throws(
      () => buildProjectHtml({ project: PROJECT, title: "T", width: "100%;}" }),
      /Invalid CSS width/,
    );
    assert.throws(
      () =>
        buildProjectHtml({ project: PROJECT, title: "T", height: "1px;color:red" }),
      /Invalid CSS height/,
    );
  });
});

describe("resolveViewerBaseUrl", () => {
  it("falls back to the production viewer with no override", () => {
    assert.equal(resolveViewerBaseUrl(undefined), DEFAULT_VIEWER_BASE_URL);
    assert.equal(resolveViewerBaseUrl(""), DEFAULT_VIEWER_BASE_URL);
  });

  it("accepts an HTTPS override", () => {
    assert.equal(
      resolveViewerBaseUrl("https://my.example.com/app/"),
      "https://my.example.com/app/",
    );
  });

  it("accepts HTTP only on loopback", () => {
    assert.equal(
      resolveViewerBaseUrl("http://localhost:5173/"),
      "http://localhost:5173/",
    );
    assert.equal(
      resolveViewerBaseUrl("http://127.0.0.1:5173/"),
      "http://127.0.0.1:5173/",
    );
  });

  it("rejects plaintext HTTP on a public host and lookalike loopback", () => {
    assert.equal(
      resolveViewerBaseUrl("http://example.com/"),
      DEFAULT_VIEWER_BASE_URL,
    );
    assert.equal(
      resolveViewerBaseUrl("http://localhost.evil.com/"),
      DEFAULT_VIEWER_BASE_URL,
    );
    assert.equal(resolveViewerBaseUrl("not a url"), DEFAULT_VIEWER_BASE_URL);
  });
});
