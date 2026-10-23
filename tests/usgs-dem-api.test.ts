import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildUsgsDemSearchUrl,
  extractRawDemName,
  filterRedundantDemItems,
  footprintCollection,
  footprintFeature,
  get24kQuadGeometry,
  parseSearchResponse,
  searchUsgsDem,
  type UsgsDemFetch,
  type UsgsDemItem,
  USGS_24K_QUAD_ENDPOINT,
  USGS_DEM_DATASETS,
  USGS_TNM_PRODUCTS_ENDPOINT,
} from "../packages/plugins/src/plugins/usgs-dem-api";

function rawDemItem(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "dem-item-123",
    title: "USGS 1 meter x56y478 WA Mount St Helens 2020",
    datasetName: "Digital Elevation Model (DEM) 1 meter",
    format: "GeoTIFF",
    downloadURL:
      "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/WA/dem123.tif",
    metaUrl: "https://data.usgs.gov/metadata/dem123.xml",
    previewUrl:
      "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/WA/dem123.jpg",
    sizeInBytes: 154857600,
    prettyFileSize: "147.69 MB",
    publicationDate: "2021-04-15T00:00:00.000Z",
    lastUpdated: "2021-04-15T12:00:00.000Z",
    spatialReference: "NAD83",
    boundingBox: {
      minX: -122.25,
      minY: 46.125,
      maxX: -122.125,
      maxY: 46.25,
    },
    ...overrides,
  };
}

function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): { fetchImpl: UsgsDemFetch; calls: string[]; signals: (AbortSignal | undefined)[] } {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fetchImpl: UsgsDemFetch = async (url, signal) => {
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

describe("buildUsgsDemSearchUrl", () => {
  it("encodes bbox, datasets, formats, and paging parameters correctly", () => {
    const urlStr = buildUsgsDemSearchUrl({
      bbox: [-122.5, 46.1, -122.0, 46.5],
      datasets: ["Digital Elevation Model (DEM) 1 meter"],
      prodFormats: ["GeoTIFF"],
      max: 50,
      offset: 10,
    });
    const url = new URL(urlStr);
    assert.equal(url.origin + url.pathname, USGS_TNM_PRODUCTS_ENDPOINT);
    assert.equal(url.searchParams.get("bbox"), "-122.5,46.1,-122,46.5");
    assert.equal(url.searchParams.get("datasets"), "Digital Elevation Model (DEM) 1 meter");
    assert.equal(url.searchParams.get("prodFormats"), "GeoTIFF");
    assert.equal(url.searchParams.get("max"), "50");
    assert.equal(url.searchParams.get("offset"), "10");
  });

  it("encodes polygon geometry when provided", () => {
    const polygon: [number, number][] = [
      [-122.5, 46.1],
      [-122.0, 46.1],
      [-122.0, 46.5],
      [-122.5, 46.1],
    ];
    const urlStr = buildUsgsDemSearchUrl({ polygon });
    const url = new URL(urlStr);
    const polyParam = url.searchParams.get("polygon");
    assert.ok(polyParam);
    const parsed = JSON.parse(polyParam);
    assert.equal(parsed.type, "Polygon");
    assert.deepEqual(parsed.coordinates, [polygon]);
  });

  it("allows overriding endpoint and date filters", () => {
    const urlStr = buildUsgsDemSearchUrl({
      endpoint: "https://custom.endpoint.gov/api/v1/products",
      dateType: "dateCreated",
      start: "2020-01-01",
      end: "2023-12-31",
    });
    const url = new URL(urlStr);
    assert.equal(url.origin + url.pathname, "https://custom.endpoint.gov/api/v1/products");
    assert.equal(url.searchParams.get("dateType"), "dateCreated");
    assert.equal(url.searchParams.get("start"), "2020-01-01");
    assert.equal(url.searchParams.get("end"), "2023-12-31");
  });
});

describe("extractRawDemName & filterRedundantDemItems", () => {
  it("normalizes USGS DEM title base names", () => {
    const raw1 = "USGS 1 meter x56y478 WA Mount St Helens 2020 GeoTIFF";
    assert.equal(extractRawDemName(raw1), "x56y478");

    const raw2 = "USGS NED 1/3 arc-second n47w123 1 x 1 degree ArcGrid";
    assert.ok(extractRawDemName(raw2).includes("n47w123"));
  });

  it("filters redundant DEM items preserving newer and GeoTIFF files", () => {
    const item1: UsgsDemItem = {
      id: "item1",
      sourceId: "item1",
      title: "USGS 1 meter x56y478 WA 2018",
      dataset: "Digital Elevation Model (DEM) 1 meter",
      format: "GeoTIFF",
      downloadUrl: "https://example.com/item1.tif",
      metaUrl: null,
      previewUrl: null,
      sizeBytes: 1000,
      prettyFileSize: "1 KB",
      publicationDate: "2018-01-01",
      lastUpdated: "2018-01-01",
      spatialReference: "NAD83",
      bbox: [-122.25, 46.125, -122.125, 46.25],
      raw: {},
    };

    const item2: UsgsDemItem = {
      ...item1,
      id: "item2",
      sourceId: "item2",
      title: "USGS 1 meter x56y478 WA 2022",
      downloadUrl: "https://example.com/item2.tif",
      publicationDate: "2022-01-01",
    };

    const item3: UsgsDemItem = {
      ...item1,
      id: "item3",
      sourceId: "item3",
      title: "USGS 1 meter x88y999 WA 2020",
      downloadUrl: "https://example.com/item3.tif",
      publicationDate: "2020-01-01",
    };

    const filtered = filterRedundantDemItems([item1, item2, item3]);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0]?.id, "item2");
    assert.equal(filtered[1]?.id, "item3");
  });
});

describe("searchUsgsDem & parseSearchResponse", () => {
  it("parses and normalizes a valid USGS TNM API response", async () => {
    const raw = rawDemItem();
    const { fetchImpl } = stubFetch({
      total: 1,
      items: [raw],
    });

    const res = await searchUsgsDem({ bbox: [-122.5, 46.1, -122.0, 46.5] }, fetchImpl);
    assert.equal(res.total, 1);
    assert.equal(res.items.length, 1);

    const item = res.items[0];
    assert.equal(item?.id, "dem-item-123");
    assert.equal(item?.title, "USGS 1 meter x56y478 WA Mount St Helens 2020");
    assert.equal(item?.dataset, "Digital Elevation Model (DEM) 1 meter");
    assert.equal(item?.format, "GeoTIFF");
    assert.equal(
      item?.downloadUrl,
      "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/WA/dem123.tif",
    );
    assert.equal(item?.sizeBytes, 154857600);
    assert.equal(item?.prettyFileSize, "147.69 MB");
    assert.deepEqual(item?.bbox, [-122.25, 46.125, -122.125, 46.25]);
  });

  it("handles empty and malformed API response gracefully", () => {
    const res1 = parseSearchResponse(null);
    assert.equal(res1.items.length, 0);
    assert.equal(res1.total, 0);

    const res2 = parseSearchResponse({ items: [null, {}] });
    assert.equal(res2.items.length, 0);
  });

  it("throws error when response is not OK", async () => {
    const { fetchImpl } = stubFetch({}, { ok: false, status: 500 });
    await assert.rejects(
      async () => {
        await searchUsgsDem({}, fetchImpl);
      },
      { message: /USGS DEM search failed: HTTP 500/ },
    );
  });
});

describe("get24kQuadGeometry", () => {
  it("queries USGS 24K Topo MapServer and extracts bbox", async () => {
    const mockGeoJson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          bbox: [-122.25, 46.125, -122.125, 46.25],
          properties: { CELL_NAME: "Mount St. Helens", PRIMARY_STATE: "WA" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-122.25, 46.125],
                [-122.125, 46.125],
                [-122.125, 46.25],
                [-122.25, 46.25],
                [-122.25, 46.125],
              ],
            ],
          },
        },
      ],
    };

    const { fetchImpl, calls } = stubFetch(mockGeoJson);
    const result = await get24kQuadGeometry("Mount St. Helens", "WA", fetchImpl);

    assert.ok(result);
    assert.deepEqual(result?.bbox, [-122.25, 46.125, -122.125, 46.25]);
    assert.ok(calls[0]?.includes("CELL_NAME"));
    assert.ok(calls[0]?.includes("Mount"));
    assert.ok(calls[0]?.includes("PRIMARY_STATE"));
    assert.ok(calls[0]?.includes("WA"));
  });

  it("returns null when no features match", async () => {
    const { fetchImpl } = stubFetch({ features: [] });
    const result = await get24kQuadGeometry("Unknown Quad", "XX", fetchImpl);
    assert.equal(result, null);
  });
});

describe("footprintFeature & footprintCollection", () => {
  it("creates valid GeoJSON footprint polygon features", () => {
    const raw = rawDemItem();
    const res = parseSearchResponse({ items: [raw] });
    const item = res.items[0];
    assert.ok(item);

    const feat = footprintFeature(item);
    assert.ok(feat);
    assert.equal(feat.type, "Feature");
    assert.equal(feat.geometry.type, "Polygon");
    assert.equal(feat.properties.title, item.title);
    assert.equal(feat.properties.downloadUrl, item.downloadUrl);
    assert.deepEqual(feat.geometry.coordinates[0], [
      [-122.25, 46.125],
      [-122.125, 46.125],
      [-122.125, 46.25],
      [-122.25, 46.25],
      [-122.25, 46.125],
    ]);

    const fc = footprintCollection([item]);
    assert.equal(fc.type, "FeatureCollection");
    assert.equal(fc.features.length, 1);
  });

  it("keeps items without bounds but draws no whole-world footprint for them", () => {
    const raw = rawDemItem({ boundingBox: undefined });
    const item = parseSearchResponse({ items: [raw] }).items[0];
    assert.ok(item);
    assert.equal(item.bbox, null);
    assert.equal(footprintFeature(item), null);
    assert.equal(footprintCollection([item]).features.length, 0);
  });

  it("treats a partial boundingBox with null or blank coordinates as unknown", () => {
    for (const minX of [null, ""]) {
      const raw = rawDemItem({
        boundingBox: { minX, minY: 46.125, maxX: -122.125, maxY: 46.25 },
      });
      const item = parseSearchResponse({ items: [raw] }).items[0];
      assert.ok(item);
      assert.equal(item.bbox, null);
    }
  });

  it("derives a stable id from the download URL when the API gives none", () => {
    const raw = rawDemItem({ sourceId: undefined, id: undefined, metaUrl: undefined });
    const first = parseSearchResponse({ items: [raw] }).items[0];
    const second = parseSearchResponse({ items: [raw] }).items[0];
    assert.ok(first && second);
    assert.equal(first.id, second.id);
    assert.equal(first.id, first.downloadUrl);
  });
});
