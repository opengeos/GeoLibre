import "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import {
  discoverOgcCoverages,
  ogcCoverageUrl,
  downloadOgcCoverage,
} from "../apps/geolibre-desktop/src/lib/ogc-api-coverages";
import { CoverageError } from "../apps/geolibre-desktop/src/lib/coverage-json";
import { initCogWasm } from "../packages/processing/src/cog-convert";
import { fromArrayBuffer } from "geotiff";

const originalFetch = globalThis.fetch;
const sample = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/ogc-coverages/gdps-temperature.json", import.meta.url),
      "utf8",
    ),
  );
const metadata = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/ogc-coverages/gdps-collection.json", import.meta.url), "utf8"),
  );
afterEach(() => {
  globalThis.fetch = originalFetch;
});
function serve(answer: (url: string, init?: RequestInit) => unknown) {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    const body = answer(url, init);
    return body instanceof Response
      ? body
      : new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
  };
  return calls;
}

test("discovers real pygeoapi metadata from a collection URL and retains its negotiated format", async () => {
  const calls = serve(() => metadata());
  const items = await discoverOgcCoverages(
    "https://demo.pygeoapi.io/master/collections/gdps-temperature/coverage?f=html&token=kept",
    new AbortController().signal,
  );
  assert.equal(items[0].id, "gdps-temperature");
  assert.equal(new URL(calls[0]).searchParams.get("f"), "json");
  const url = new URL(ogcCoverageUrl(items[0], [-80, 43, -79, 44]));
  assert.equal(url.searchParams.get("bbox"), "-80,43,-79,44");
  assert.equal(url.searchParams.get("f"), "json");
  assert.equal(url.searchParams.get("token"), "kept");
});

test("follows landing/data and next links, deduplicates collections and ignores unrelated contact links", async () => {
  const item = metadata();
  item.links.push({ rel: "contact", href: "mailto:help@example.org" });
  const calls = serve((url) => {
    if (new URL(url).pathname === "/api/")
      return {
        id: "service",
        links: [
          {
            rel: "data",
            type: "application/json",
            href: "./different-catalog?f=json",
          },
        ],
      };
    if (new URL(url).searchParams.has("page")) return { collections: [item] };
    return { collections: [item], links: [{ rel: "next", href: "?page=2" }] };
  });
  const items = await discoverOgcCoverages(
    "https://demo.pygeoapi.io/api/",
    new AbortController().signal,
  );
  assert.equal(items.length, 1);
  assert.equal(new URL(calls[1]).pathname, "/api/different-catalog");
  assert.equal(calls.length, 3);
});

test("does not copy query credentials to an external coverage host", async () => {
  const item = metadata();
  item.links = [
    {
      rel: "http://www.opengis.net/def/rel/ogc/1.0/coverage",
      type: "application/prs.coverage+json",
      href: "https://other.example/coverage",
    },
  ];
  serve(() => ({ collections: [item] }));
  const [collection] = await discoverOgcCoverages(
    "https://example.org/collections?token=private",
    new AbortController().signal,
  );
  assert.equal(
    new URL(ogcCoverageUrl(collection, [-80, 43, -79, 44])).searchParams.has("token"),
    false,
  );
});

test("refuses cyclic catalogs and oversized metadata", async () => {
  serve(() => ({ collections: [], links: [{ rel: "next", href: "?f=json" }] }));
  await assert.rejects(
    discoverOgcCoverages("https://example.org/collections", new AbortController().signal),
    CoverageError,
  );
  serve(
    () =>
      new Response("{}", {
        headers: { "content-length": String(3 * 1024 * 1024) },
      }),
  );
  await assert.rejects(
    discoverOgcCoverages("https://example.org/collections", new AbortController().signal),
    { code: "metadata" },
  );
});

test("resolves linked domains/ranges after redirect and produces a Float64 numerical COG", async () => {
  await initCogWasm(
    new Uint8Array(
      readFileSync(new URL("../node_modules/geolibre-wasm/geolibre_wasm_bg.wasm", import.meta.url)),
    ),
  );
  const doc = sample(),
    item = metadata();
  const calls = serve((url, init) => {
    if (new URL(url).pathname.endsWith("domain.json")) return doc.domain;
    if (new URL(url).pathname.endsWith("values.json")) return doc.ranges.TMP;
    if (new URL(url).pathname.includes("/coverage")) {
      assert.match(String(new Headers(init?.headers).get("accept")), /cov\+json/);
      const response = new Response(
        JSON.stringify({
          ...doc,
          domain: "domain.json",
          ranges: { TMP: "values.json" },
        }),
      );
      Object.defineProperty(response, "url", {
        value: "https://demo.pygeoapi.io/resolved/coverage.json",
      });
      return response;
    }
    return item;
  });
  const [collection] = await discoverOgcCoverages(
    "https://demo.pygeoapi.io/master/collections/gdps-temperature",
    new AbortController().signal,
  );
  const url = ogcCoverageUrl(collection, [-80, 43, -79, 44]);
  const { file, bands } = await downloadOgcCoverage(collection, url, new AbortController().signal);
  assert.deepEqual(bands, ["TMP"]);
  assert.ok(calls.includes("https://demo.pygeoapi.io/resolved/domain.json"));
  const image = await (await fromArrayBuffer(await file.arrayBuffer())).getImage();
  assert.equal(image.getBitsPerSample(), 64);
  assert.deepEqual(
    Array.from(await image.readRasters({ interleave: true })),
    doc.ranges.TMP.values,
  );
});
