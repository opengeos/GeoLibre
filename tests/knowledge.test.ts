import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGeosearchUrl,
  buildSummaryUrl,
  fetchArticleSummary,
  isValidLatLon,
  normalizeLon,
  parseGeosearch,
  parseSummary,
  wikipediaLang,
} from "../apps/geolibre-desktop/src/lib/knowledge";

describe("wikipediaLang", () => {
  it("keeps a plain two-letter code", () => {
    assert.equal(wikipediaLang("fr"), "fr");
  });
  it("strips a region suffix", () => {
    assert.equal(wikipediaLang("pt-BR"), "pt");
    assert.equal(wikipediaLang("zh_Hans"), "zh");
  });
  it("falls back to English for empty or malformed input", () => {
    assert.equal(wikipediaLang(""), "en");
    assert.equal(wikipediaLang(undefined), "en");
    assert.equal(wikipediaLang("123"), "en");
    assert.equal(wikipediaLang("english"), "en");
  });
});

describe("isValidLatLon", () => {
  it("accepts in-range finite coordinates", () => {
    assert.ok(isValidLatLon(0, 0));
    assert.ok(isValidLatLon(-90, 180));
  });
  it("rejects out-of-range or non-finite coordinates", () => {
    assert.ok(!isValidLatLon(91, 0));
    assert.ok(!isValidLatLon(0, 181));
    assert.ok(!isValidLatLon(Number.NaN, 0));
    assert.ok(!isValidLatLon(0, Infinity));
  });
});

describe("normalizeLon", () => {
  it("leaves an in-range longitude unchanged", () => {
    assert.equal(normalizeLon(2.2945), 2.2945);
    assert.equal(normalizeLon(-179), -179);
  });
  it("wraps longitudes past the antimeridian into [-180, 180]", () => {
    assert.equal(normalizeLon(190), -170);
    assert.equal(normalizeLon(-370), -10);
    assert.equal(normalizeLon(200), -160);
  });
  it("passes non-finite values through untouched", () => {
    assert.ok(Number.isNaN(normalizeLon(Number.NaN)));
  });
});

describe("buildGeosearchUrl", () => {
  it("wraps an unwrapped longitude into range for gscoord", () => {
    const url = new URL(buildGeosearchUrl(10, 190));
    assert.equal(url.searchParams.get("gscoord"), "10.000000|-170.000000");
  });

  it("formats near-zero coordinates as decimals, not exponential", () => {
    const url = new URL(buildGeosearchUrl(5e-8, 5e-8));
    assert.equal(url.searchParams.get("gscoord"), "0.000000|0.000000");
  });
  it("targets the language edition host with an anonymous CORS origin", () => {
    const url = new URL(buildGeosearchUrl(48.8584, 2.2945, { lang: "fr" }));
    assert.equal(url.hostname, "fr.wikipedia.org");
    assert.equal(url.pathname, "/w/api.php");
    assert.equal(url.searchParams.get("list"), "geosearch");
    assert.equal(url.searchParams.get("gscoord"), "48.858400|2.294500");
    assert.equal(url.searchParams.get("origin"), "*");
  });
  it("clamps radius and limit to the API maxima", () => {
    const url = new URL(buildGeosearchUrl(0, 0, { radiusM: 999_999, limit: 999 }));
    assert.equal(url.searchParams.get("gsradius"), "10000");
    assert.equal(url.searchParams.get("gslimit"), "50");
  });
  it("defaults to the English edition", () => {
    const url = new URL(buildGeosearchUrl(0, 0));
    assert.equal(url.hostname, "en.wikipedia.org");
  });
});

describe("buildSummaryUrl", () => {
  it("encodes spaces as underscores and escapes reserved characters", () => {
    assert.equal(
      buildSummaryUrl("Eiffel Tower", "en"),
      "https://en.wikipedia.org/api/rest_v1/page/summary/Eiffel_Tower",
    );
    assert.equal(
      buildSummaryUrl("AC/DC", "en"),
      "https://en.wikipedia.org/api/rest_v1/page/summary/AC%2FDC",
    );
  });
});

describe("parseGeosearch", () => {
  it("returns typed places sorted nearest-first and drops invalid rows", () => {
    const places = parseGeosearch({
      query: {
        geosearch: [
          { pageid: 2, title: "Far", lat: 1, lon: 1, dist: 900 },
          { pageid: 1, title: "Near", lat: 0.1, lon: 0.1, dist: 120 },
          { pageid: 3, title: "Bad coords", lat: 200, lon: 0, dist: 50 },
          { title: "Missing id", lat: 0, lon: 0, dist: 10 },
        ],
      },
    });
    assert.equal(places.length, 2);
    assert.equal(places[0].title, "Near");
    assert.equal(places[1].title, "Far");
    assert.equal(places[0].distanceM, 120);
  });
  it("returns an empty array for malformed input", () => {
    assert.deepEqual(parseGeosearch(null), []);
    assert.deepEqual(parseGeosearch({ query: {} }), []);
  });
  it("sorts a row with unknown distance last, not first", () => {
    const places = parseGeosearch({
      query: {
        geosearch: [
          { pageid: 5, title: "Unknown distance", lat: 0.2, lon: 0.2 },
          { pageid: 6, title: "Close", lat: 0.1, lon: 0.1, dist: 50 },
        ],
      },
    });
    assert.equal(places[0].title, "Close");
    assert.equal(places[1].title, "Unknown distance");
    assert.equal(places[1].distanceM, Number.POSITIVE_INFINITY);
  });
});

describe("parseSummary", () => {
  it("maps a full summary document", () => {
    const summary = parseSummary(
      {
        title: "Paris",
        description: "Capital of France",
        extract: "Paris is the capital of France.",
        thumbnail: { source: "https://example.org/paris.jpg" },
        content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/Paris" } },
        coordinates: { lat: 48.8566, lon: 2.3522 },
      },
      "en",
    );
    assert.ok(summary);
    assert.equal(summary.title, "Paris");
    assert.equal(summary.thumbnailUrl, "https://example.org/paris.jpg");
    assert.equal(summary.contentUrl, "https://en.wikipedia.org/wiki/Paris");
    assert.equal(summary.lat, 48.8566);
    assert.equal(summary.lang, "en");
  });
  it("synthesizes a content URL when the API omits one", () => {
    const summary = parseSummary({ title: "Some Place", extract: "…" }, "de");
    assert.ok(summary);
    assert.equal(summary.contentUrl, "https://de.wikipedia.org/wiki/Some_Place");
    assert.equal(summary.thumbnailUrl, undefined);
    assert.equal(summary.lat, undefined);
  });
  it("returns null for disambiguation, null, and titleless documents", () => {
    assert.equal(parseSummary({ title: "X", type: "disambiguation" }, "en"), null);
    assert.equal(parseSummary(null, "en"), null);
    assert.equal(parseSummary({ extract: "no title" }, "en"), null);
  });
});

describe("fetchArticleSummary", () => {
  function withFetch<T>(stub: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = stub as typeof globalThis.fetch;
    return run().finally(() => {
      globalThis.fetch = original;
    });
  }

  it("resolves a 404 (missing or renamed title) to null instead of throwing", async () => {
    const result = await withFetch(
      async () => ({ status: 404, ok: false, json: async () => ({}) }),
      () => fetchArticleSummary("No Such Article", { lang: "en" }),
    );
    assert.equal(result, null);
  });

  it("throws on other non-OK responses", async () => {
    await withFetch(
      async () => ({ status: 500, ok: false, json: async () => ({}) }),
      () => assert.rejects(fetchArticleSummary("Whatever", { lang: "en" })),
    );
  });

  it("parses a 200 summary body", async () => {
    const result = await withFetch(
      async () => ({
        status: 200,
        ok: true,
        json: async () => ({ title: "Paris", extract: "Capital." }),
      }),
      () => fetchArticleSummary("Paris", { lang: "en" }),
    );
    assert.equal(result?.title, "Paris");
    assert.equal(result?.extract, "Capital.");
  });
});
