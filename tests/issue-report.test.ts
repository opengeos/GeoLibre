import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIssueReportUrl,
  ISSUE_TEMPLATE,
  MAX_ISSUE_URL_LENGTH,
  scrubForIssueReport,
  type IssueReportContext,
  type IssueReportEntry,
} from "../apps/geolibre-desktop/src/lib/issue-report";
import { layerToNotifyForMapError } from "../apps/geolibre-desktop/src/lib/map-error-notification";
import type { GeoLibreLayer } from "@geolibre/core";

const context: IssueReportContext = {
  appVersion: "3.2.0",
  runtime: "Web",
  platform: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140",
  renderer: "maplibre",
};

function entry(overrides: Partial<IssueReportEntry> = {}): IssueReportEntry {
  return {
    timestamp: "2026-10-04T12:00:00.000Z",
    level: "error",
    category: "app",
    message: "Layer failed",
    ...overrides,
  };
}

function fields(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("scrubForIssueReport", () => {
  it("drops URL query strings, fragments and userinfo", () => {
    const text =
      "GET https://user:hunter2@tiles.example.com/a/{z}/{x}/{y}.png?access_token=abc123&style=x#k=v failed";
    const scrubbed = scrubForIssueReport(text);
    assert.equal(scrubbed, "GET https://tiles.example.com/a/{z}/{x}/{y}.png?[REDACTED] failed");
  });

  it("masks credential-named key/value pairs in free text and JSON", () => {
    const scrubbed = scrubForIssueReport(
      'apiKey=SECRET1 {"accessToken": "SECRET2", "name": "roads"} password: SECRET3 sig=SECRET4',
    );
    for (const secret of ["SECRET1", "SECRET2", "SECRET3", "SECRET4"]) {
      assert.ok(!scrubbed.includes(secret), `${secret} leaked: ${scrubbed}`);
    }
    assert.ok(scrubbed.includes('"name": "roads"'), "ordinary fields survive");
  });

  it("masks well-known token shapes wherever they appear", () => {
    const tokens = [
      "Authorization: Bearer abcdefghijklmnop",
      "pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjazEifQ.abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "AIzaSyA1234567890abcdefghijklmnopqrstuv",
      "sk-abcdefghijklmnopqrstuvwxyz012345",
    ];
    for (const token of tokens) {
      const scrubbed = scrubForIssueReport(`failed with ${token} here`);
      assert.ok(scrubbed.includes("[REDACTED]"), `${token} not masked: ${scrubbed}`);
      assert.ok(!scrubbed.includes(token.slice(-8)), `${token} leaked: ${scrubbed}`);
    }
  });

  it("replaces home-directory user names", () => {
    assert.equal(
      scrubForIssueReport("Could not read /home/alice/data/a.tif or C:\\Users\\bob\\b.shp"),
      "Could not read ~/data/a.tif or ~\\b.shp",
    );
    assert.equal(scrubForIssueReport("/Users/carol/x.gpkg"), "~/x.gpkg");
  });

  it("marks a fragment-only URL with # rather than a synthetic query", () => {
    assert.equal(
      scrubForIssueReport("https://x.test/path#secretToken"),
      "https://x.test/path#[REDACTED]",
    );
    assert.equal(
      scrubForIssueReport("https://x.test/path#[REDACTED]"),
      "https://x.test/path#[REDACTED]",
    );
  });

  it("still strips userinfo from a URL that already carries the marker", () => {
    assert.equal(
      scrubForIssueReport("https://user:pass@h.test/a?[REDACTED]"),
      "https://h.test/a?[REDACTED]",
    );
  });

  it("is idempotent", () => {
    const once = scrubForIssueReport("token=abc https://x.test/a?key=1");
    assert.equal(scrubForIssueReport(once), once);
  });
});

describe("buildIssueReportUrl", () => {
  it("fills the bug-report form with version, platform, renderer and the entry", () => {
    const url = buildIssueReportUrl(
      entry({ detail: "stack", url: "https://a.test/x.pmtiles?token=zzz", status: 403 }),
      context,
    );
    assert.ok(url.startsWith("https://github.com/opengeos/GeoLibre/issues/new?"));
    const params = fields(url);
    assert.equal(params.get("template"), ISSUE_TEMPLATE);
    assert.equal(params.get("title"), "[Bug]: Layer failed");
    assert.equal(params.get("app"), "Web v3.2.0");
    assert.equal(params.get("os"), context.platform);
    const body = params.get("screenshots") ?? "";
    assert.match(body, /Renderer: maplibre/);
    assert.match(body, /"status": 403/);
    assert.match(body, /x\.pmtiles\?\[REDACTED\]/);
    assert.ok(!url.includes("zzz"));
  });

  it("builds a general report without an entry", () => {
    const params = fields(buildIssueReportUrl(null, context));
    assert.equal(params.get("title"), "[Bug]: ");
    assert.equal(params.get("what-happened"), null);
    assert.equal(params.get("screenshots"), "Renderer: maplibre");
  });

  it("truncates a long entry to fit the URL budget", () => {
    const longDetail = "x".repeat(50_000);
    const url = buildIssueReportUrl(entry({ detail: longDetail }), context);
    assert.ok(url.length <= MAX_ISSUE_URL_LENGTH, `length ${url.length}`);
    assert.match(fields(url).get("screenshots") ?? "", /…\[truncated\]/);
  });

  it("bounds a huge url/source and omits data: payloads", () => {
    const url = buildIssueReportUrl(
      entry({ url: `data:image/png;base64,${"A".repeat(50_000)}`, source: "s".repeat(50_000) }),
      context,
    );
    assert.ok(url.length <= MAX_ISSUE_URL_LENGTH, `length ${url.length}`);
    assert.match(fields(url).get("screenshots") ?? "", /data:\[omitted\]/);
  });

  it("accounts for multi-byte encoding when truncating", () => {
    const url = buildIssueReportUrl(
      entry({ message: "图层".repeat(2000), detail: "加载失败".repeat(5000) }),
      context,
      4000,
    );
    assert.ok(url.length <= 4000, `length ${url.length}`);
    // Still a parseable URL whose title is capped.
    assert.ok((fields(url).get("title") ?? "").length < 140);
  });

  it("scrubs the title and the platform too", () => {
    const params = fields(
      buildIssueReportUrl(entry({ message: "GET https://a.test/t?apikey=SECRET failed" }), {
        ...context,
        platform: "token=SECRET",
      }),
    );
    assert.ok(!(params.get("title") ?? "").includes("SECRET"));
    assert.ok(!(params.get("os") ?? "").includes("SECRET"));
  });
});

describe("layerToNotifyForMapError", () => {
  const layers = [{ id: "abc", name: "Roads" }] as unknown as GeoLibreLayer[];

  it("maps a MapLibre or Mapbox source id to its store layer", () => {
    assert.equal(
      layerToNotifyForMapError({ message: "x", source: "source-abc" }, layers)?.name,
      "Roads",
    );
    assert.equal(
      layerToNotifyForMapError({ message: "x", source: "geolibre-mapbox-abc" }, layers)?.name,
      "Roads",
    );
  });

  it("ignores basemap and unknown sources", () => {
    assert.equal(layerToNotifyForMapError({ message: "x", source: "openmaptiles" }, layers), null);
    assert.equal(layerToNotifyForMapError({ message: "x" }, layers), null);
  });

  it("treats a 404 on a tile-template layer as an empty tile even without tile detail", () => {
    const tiled = [
      { id: "xyz", name: "Tiles", source: { tiles: ["https://t/{z}/{x}/{y}.png"] } },
    ] as unknown as GeoLibreLayer[];
    const mapbox404 = {
      message: "Not Found",
      source: "geolibre-mapbox-xyz",
      status: 404,
      detail: JSON.stringify({ source: "geolibre-mapbox-xyz", status: 404 }),
    };
    assert.equal(layerToNotifyForMapError(mapbox404, tiled), null);
    assert.equal(layerToNotifyForMapError({ ...mapbox404, status: 401 }, tiled)?.name, "Tiles");
  });

  it("ignores an empty tile (404) but not a missing whole-file source", () => {
    const tile404 = {
      message: "Not Found",
      source: "source-abc",
      status: 404,
      detail: JSON.stringify({ status: 404, tile: { z: 3 } }),
    };
    assert.equal(layerToNotifyForMapError(tile404, layers), null);
    const file404 = { message: "Not Found", source: "source-abc", status: 404 };
    assert.equal(layerToNotifyForMapError(file404, layers)?.name, "Roads");
    const tile403 = { ...tile404, status: 403 };
    assert.equal(layerToNotifyForMapError(tile403, layers)?.name, "Roads");
  });
});
