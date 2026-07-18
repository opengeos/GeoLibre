import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSearchUrl,
  buildTitilerTemplate,
  footprintFeature,
  type OamFetch,
  type OamImage,
  OAM_DEFAULT_ENDPOINT,
  searchOpenAerialMap,
} from "../packages/plugins/src/plugins/openaerialmap-api";

const CUSTOM_ENDPOINT_PATTERN = /^https:\/\/proxy\.example\.com\/oam\/meta\?/;
const SERVICE_UNAVAILABLE_PATTERN = /503/;

/** A raw `/meta` result record, close to the real API shape. */
function rawResult(overrides: Record<string, unknown> = {}) {
  return {
    _id: "abc123",
    title: "Sample scene",
    provider: "Maxar",
    platform: "satellite",
    gsd: 0.3,
    acquisition_start: "2024-10-02T14:11:00.000Z",
    acquisition_end: "2024-10-02T14:12:00.000Z",
    uuid: "https://oin.example.com/abc123.tif",
    properties: {
      tms: "https://tiles.openaerialmap.org/abc123/{z}/{x}/{y}",
      thumbnail: "https://oin.example.com/abc123.png",
    },
    bbox: [-84.5, 33.6, -84.2, 33.9],
    ...overrides,
  };
}

/** A fetch stub that records the requested URL and returns a JSON body. */
function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): { fetchImpl: OamFetch; calls: string[]; signals: (AbortSignal | undefined)[] } {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl: OamFetch = async (url, signal) => {
    calls.push(url);
    signals.push(signal);
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    };
  };
  return { fetchImpl, calls, signals };
}

describe("buildSearchUrl", () => {
  it("encodes bbox, paging, and newest-first ordering", () => {
    const url = new URL(buildSearchUrl({ bbox: [-1, -2, 3, 4], limit: 5, page: 2 }));
    assert.equal(url.origin + url.pathname, `${OAM_DEFAULT_ENDPOINT}/meta`);
    assert.equal(url.searchParams.get("bbox"), "-1,-2,3,4");
    assert.equal(url.searchParams.get("limit"), "5");
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("order_by"), "acquisition_end");
    assert.equal(url.searchParams.get("sort"), "desc");
  });

  it("honors a custom endpoint and strips a trailing slash", () => {
    assert.match(
      buildSearchUrl({ endpoint: "https://proxy.example.com/oam/" }),
      CUSTOM_ENDPOINT_PATTERN,
    );
  });
});

describe("buildTitilerTemplate", () => {
  it("builds a CORS-enabled titiler template from the source COG", () => {
    assert.equal(
      buildTitilerTemplate("https://oin.example.com/abc123.tif"),
      "https://titiler.hotosm.org/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?url=" +
        encodeURIComponent("https://oin.example.com/abc123.tif"),
    );
  });

  it("returns null without a COG url", () => {
    assert.equal(buildTitilerTemplate(null), null);
  });
});

describe("searchOpenAerialMap", () => {
  it("normalizes a result into tile, download, thumbnail, and bbox fields", async () => {
    const { fetchImpl } = stubFetch({
      meta: { found: 1 },
      results: [rawResult()],
    });
    const { images, found } = await searchOpenAerialMap({}, fetchImpl);

    assert.equal(found, 1);
    assert.equal(images.length, 1);
    const image = images[0];
    assert.equal(image.id, "abc123");
    assert.equal(image.title, "Sample scene");
    assert.equal(image.provider, "Maxar");
    assert.equal(image.gsd, 0.3);
    assert.equal(image.cogUrl, "https://oin.example.com/abc123.tif");
    assert.equal(image.thumbnailUrl, "https://oin.example.com/abc123.png");
    assert.deepEqual(image.bbox, [-84.5, 33.6, -84.2, 33.9]);
    // Rendered via titiler directly, not the un-CORS'd tiles.openaerialmap.org.
    assert.equal(image.tileUrl, buildTitilerTemplate("https://oin.example.com/abc123.tif"));
  });

  it("falls back to geojson.bbox and property gsd", async () => {
    const { fetchImpl } = stubFetch({
      meta: { found: 1 },
      results: [
        rawResult({
          gsd: undefined,
          bbox: undefined,
          properties: { gsd: 0.05 },
          geojson: { bbox: [1, 2, 3, 4] },
        }),
      ],
    });
    const { images } = await searchOpenAerialMap({}, fetchImpl);
    assert.equal(images[0].gsd, 0.05);
    assert.deepEqual(images[0].bbox, [1, 2, 3, 4]);
  });

  it("drops records without an id and tolerates missing fields", async () => {
    const { fetchImpl } = stubFetch({
      meta: { found: 2 },
      results: [{ title: "no id here" }, { _id: "only-id" }],
    });
    const { images } = await searchOpenAerialMap({}, fetchImpl);
    assert.equal(images.length, 1);
    assert.equal(images[0].id, "only-id");
    assert.equal(images[0].title, "Untitled image");
    assert.equal(images[0].provider, "Unknown");
    assert.equal(images[0].tileUrl, null);
    assert.equal(images[0].cogUrl, null);
    assert.equal(images[0].bbox, null);
  });

  it("defaults found to the returned count when meta is missing", async () => {
    const { fetchImpl } = stubFetch({ results: [rawResult()] });
    const { found } = await searchOpenAerialMap({}, fetchImpl);
    assert.equal(found, 1);
  });

  it("coerces a numeric-string found into a number", async () => {
    const { fetchImpl } = stubFetch({
      meta: { found: "42" },
      results: [rawResult()],
    });
    const { found } = await searchOpenAerialMap({}, fetchImpl);
    assert.equal(found, 42);
  });

  it("forwards the abort signal to the fetch impl", async () => {
    const { fetchImpl, signals } = stubFetch({ meta: { found: 0 }, results: [] });
    const controller = new AbortController();
    await searchOpenAerialMap({ signal: controller.signal }, fetchImpl);
    assert.equal(signals[0], controller.signal);
  });

  it("throws a descriptive error on a non-OK response", async () => {
    const { fetchImpl } = stubFetch({}, { ok: false, status: 503 });
    await assert.rejects(() => searchOpenAerialMap({}, fetchImpl), SERVICE_UNAVAILABLE_PATTERN);
  });

  it("sends bbox and paging through to the request URL", async () => {
    const { fetchImpl, calls } = stubFetch({ meta: { found: 0 }, results: [] });
    await searchOpenAerialMap({ bbox: [10, 20, 30, 40], page: 3 }, fetchImpl);
    const url = new URL(calls[0]);
    assert.equal(url.searchParams.get("bbox"), "10,20,30,40");
    assert.equal(url.searchParams.get("page"), "3");
  });

  it("keeps the raw record and a footprint polygon geometry", async () => {
    const { fetchImpl } = stubFetch({
      meta: { found: 1 },
      results: [
        rawResult({
          geojson: {
            type: "Polygon",
            coordinates: [
              [
                [-84.5, 33.6],
                [-84.2, 33.6],
                [-84.2, 33.9],
                [-84.5, 33.9],
                [-84.5, 33.6],
              ],
            ],
          },
        }),
      ],
    });
    const { images } = await searchOpenAerialMap({}, fetchImpl);
    assert.equal(images[0].geometry?.type, "Polygon");
    assert.equal((images[0].raw as { title?: string }).title, "Sample scene");
  });
});

/** Minimal normalized image for footprint tests. */
function image(overrides: Partial<OamImage> = {}): OamImage {
  return {
    id: "img1",
    title: "Scene",
    provider: "Provider",
    platform: "",
    gsd: null,
    acquisitionStart: null,
    acquisitionEnd: null,
    thumbnailUrl: null,
    tileUrl: "https://tiler/{z}/{x}/{y}",
    cogUrl: "https://oin.example.com/img1.tif",
    bbox: [-1, -2, 3, 4],
    geometry: null,
    raw: null,
    ...overrides,
  };
}

describe("footprintFeature", () => {
  it("uses the exact polygon geometry when present", () => {
    const geometry = {
      type: "Polygon" as const,
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    const feature = footprintFeature(image({ geometry }));
    assert.equal(feature?.geometry, geometry);
    assert.equal(feature?.properties.id, "img1");
    assert.equal(feature?.properties.hasTile, true);
  });

  it("carries the image metadata as attribute-table properties", () => {
    const feature = footprintFeature(
      image({
        provider: "Maxar",
        platform: "satellite",
        acquisitionEnd: "2024-10-02T14:12:00.000Z",
        gsd: 0.3,
      }),
    );
    assert.equal(feature?.properties.provider, "Maxar");
    assert.equal(feature?.properties.platform, "satellite");
    assert.equal(feature?.properties.acquired, "2024-10-02");
    assert.equal(feature?.properties.gsd, 0.3);
    assert.equal(feature?.properties.resolution, "30.0 cm/px");
    assert.equal(feature?.properties.cogUrl, "https://oin.example.com/img1.tif");
  });

  it("traces a rectangle from the bbox when there is no geometry", () => {
    const feature = footprintFeature(image({ bbox: [-1, -2, 3, 4] }));
    assert.equal(feature?.geometry.type, "Polygon");
    assert.deepEqual((feature?.geometry as { coordinates: unknown }).coordinates, [
      [
        [-1, -2],
        [3, -2],
        [3, 4],
        [-1, 4],
        [-1, -2],
      ],
    ]);
  });

  it("marks images without a tile url as not visualizable", () => {
    const feature = footprintFeature(image({ tileUrl: null }));
    assert.equal(feature?.properties.hasTile, false);
  });

  it("returns null when the image has neither geometry nor bbox", () => {
    assert.equal(footprintFeature(image({ bbox: null, geometry: null })), null);
  });
});
