import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCollectionSearchUrl,
  buildGranuleSearchUrl,
  earthdataTokenExpiry,
  fileNameFromUrl,
  formatSizeMb,
  granuleFootprints,
  granuleGeometry,
  isSpaceborneLidarGranule,
  newestCollection,
  parseCollections,
  parseGranules,
  primaryDataLink,
  requestEarthdataToken,
  searchEarthdataGranules,
  temporalParam,
  unwrapLongitudes,
} from "../packages/plugins/src/plugins/earthaccess-api";

const ATL08_URL =
  "https://data.nsidc.earthdatacloud.nasa.gov/nsidc-cumulus-prod-protected/ATLAS/ATL08/007/2026/07/18/ATL08_20260718174253_05303206_007_01.h5";

/** A `granules.json` entry close to what CMR returns for ATL08. */
function rawGranule(overrides: Record<string, unknown> = {}) {
  return {
    id: "G4316079212-NSIDC_CPRD",
    producer_granule_id: "ATL08_20260718174253_05303206_007_01.h5",
    title: "ATL08_20260718174253_05303206_007_01.h5_KOiFgTqo",
    collection_concept_id: "C3565574177-NSIDC_CPRD",
    time_start: "2026-07-18T17:43:00.617Z",
    time_end: "2026-07-18T17:50:51.500Z",
    granule_size: "64.0",
    polygons: [["35.0 -83.0 36.0 -83.1 36.0 -83.2 35.0 -83.1 35.0 -83.0"]],
    links: [
      { rel: "http://esipfed.org/ns/fedsearch/1.1/data#", href: ATL08_URL },
      {
        rel: "http://esipfed.org/ns/fedsearch/1.1/metadata#",
        href: "https://example.com/ATL08.iso.xml",
      },
      {
        rel: "http://esipfed.org/ns/fedsearch/1.1/browse#",
        href: "https://example.com/ATL08_BRW.jpg",
      },
      {
        rel: "http://esipfed.org/ns/fedsearch/1.1/data#",
        href: "https://data.lpdaac.earthdatacloud.nasa.gov/s3credentials",
      },
      { rel: "http://esipfed.org/ns/fedsearch/1.1/data#", href: "s3://bucket/ATL08.h5" },
      {
        rel: "http://esipfed.org/ns/fedsearch/1.1/data#",
        href: "https://example.com/collection-level",
        inherited: true,
      },
    ],
    ...overrides,
  };
}

describe("CMR search URLs", () => {
  it("builds a collection search with keyword, bbox and dates", () => {
    const url = new URL(
      buildCollectionSearchUrl({
        keyword: " GEDI biomass ",
        bbox: [-200, -95, -83.123456, 36],
        temporal: ["2022-01-01", "2022-12-31"],
        cloudHosted: true,
      }),
    );
    assert.equal(url.pathname, "/search/collections.json");
    assert.equal(url.searchParams.get("keyword"), "GEDI biomass");
    assert.equal(url.searchParams.get("bounding_box"), "-180,-90,-83.12346,36");
    assert.equal(url.searchParams.get("temporal"), "2022-01-01T00:00:00Z,2022-12-31T23:59:59Z");
    assert.equal(url.searchParams.get("cloud_hosted"), "true");
    assert.equal(url.searchParams.get("has_granules"), "true");
  });

  it("builds a granule search sorted newest first", () => {
    const url = new URL(
      buildGranuleSearchUrl({ collectionConceptId: "C1-X", bbox: [-84, 35, -83, 36], pageNum: 2 }),
    );
    assert.equal(url.pathname, "/search/granules.json");
    assert.equal(url.searchParams.get("collection_concept_id"), "C1-X");
    assert.equal(url.searchParams.get("sort_key"), "-start_date");
    assert.equal(url.searchParams.get("page_num"), "2");
    assert.equal(url.searchParams.get("temporal"), null);
  });

  it("leaves an open-ended date range open", () => {
    assert.equal(temporalParam(["", ""]), null);
    assert.equal(temporalParam(["2020-05-01", ""]), "2020-05-01T00:00:00Z,");
    assert.equal(temporalParam(["", "2020-05-01"]), ",2020-05-01T23:59:59Z");
  });
});

describe("CMR responses", () => {
  it("picks the newest cloud-hosted version of a dataset", () => {
    const base = {
      shortName: "ATL08",
      title: "",
      dataCenter: "",
      timeStart: null,
      timeEnd: null,
      summary: "",
    };
    const pick = newestCollection([
      { ...base, conceptId: "C1", version: "006", cloudHosted: true },
      { ...base, conceptId: "C2", version: "007", cloudHosted: true },
      { ...base, conceptId: "C3", version: "010", cloudHosted: false },
    ]);
    assert.equal(pick?.conceptId, "C2");
    assert.equal(
      newestCollection([
        { ...base, conceptId: "C4", version: "9", cloudHosted: false },
        { ...base, conceptId: "C5", version: "10", cloudHosted: false },
      ])?.conceptId,
      "C5",
    );
    assert.equal(newestCollection([]), null);
  });

  it("parses collections", () => {
    const [collection] = parseCollections({
      feed: {
        entry: [
          {
            id: "C2237824918-ORNL_CLOUD",
            short_name: "GEDI_L4A_AGB_Density_V2_1_2056",
            version_id: "2.1",
            title: "GEDI L4A Footprint Level Aboveground Biomass Density, Version 2.1",
            data_center: "ORNL_CLOUD",
            cloud_hosted: true,
            time_start: "2019-04-17T00:00:00.000Z",
          },
          { short_name: "no id" },
        ],
      },
    });
    assert.equal(collection.conceptId, "C2237824918-ORNL_CLOUD");
    assert.equal(collection.cloudHosted, true);
    assert.equal(collection.timeEnd, null);
    assert.equal(parseCollections({}).length, 0);
  });

  it("keeps only a granule's own HTTPS data files", () => {
    const [granule] = parseGranules({ feed: { entry: [rawGranule()] } });
    assert.equal(granule.name, "ATL08_20260718174253_05303206_007_01.h5");
    assert.deepEqual(granule.dataLinks, [ATL08_URL]);
    assert.deepEqual(granule.browseLinks, ["https://example.com/ATL08_BRW.jpg"]);
    assert.equal(granule.sizeMb, 64);
    assert.equal(granule.geometry?.type, "Polygon");
  });

  it("reads the hit count from the CMR-Hits header", async () => {
    let requested = "";
    const fakeFetch = (async (input: RequestInfo | URL) => {
      requested = String(input);
      return new Response(JSON.stringify({ feed: { entry: [rawGranule()] } }), {
        headers: { "CMR-Hits": "847" },
      });
    }) as typeof fetch;
    const page = await searchEarthdataGranules({ collectionConceptId: "C1-X" }, fakeFetch);
    assert.equal(page.hits, 847);
    assert.equal(page.items.length, 1);
    assert.match(requested, /collection_concept_id=C1-X/);
  });

  it("reports CMR's own error message", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ errors: ["Invalid bounding box"] }), {
        status: 400,
      })) as unknown as typeof fetch;
    await assert.rejects(
      searchEarthdataGranules({ collectionConceptId: "C1-X" }, fakeFetch),
      /Invalid bounding box/,
    );
  });
});

describe("granule footprints", () => {
  it("swaps CMR's lat/lon order and closes rings", () => {
    const geometry = granuleGeometry({ polygons: [["10 20 11 20 11 21 10 20"]] });
    assert.deepEqual(geometry, {
      type: "Polygon",
      coordinates: [
        [
          [20, 10],
          [20, 11],
          [21, 11],
          [20, 10],
        ],
      ],
    });
  });

  it("turns boxes, lines and points into geometry", () => {
    assert.deepEqual(granuleGeometry({ boxes: ["-10 170 10 -170"] }), {
      type: "Polygon",
      coordinates: [
        [
          [170, -10],
          [190, -10],
          [190, 10],
          [170, 10],
          [170, -10],
        ],
      ],
    });
    assert.equal(granuleGeometry({ lines: ["0 0 1 1", "2 2 3 3"] })?.type, "MultiLineString");
    assert.deepEqual(granuleGeometry({ points: ["5 6"] }), { type: "Point", coordinates: [6, 5] });
    assert.equal(granuleGeometry({}), null);
  });

  it("keeps a track crossing the antimeridian continuous", () => {
    assert.deepEqual(
      unwrapLongitudes([
        [179, 0],
        [-179, 1],
        [-178, 2],
      ]),
      [
        [179, 0],
        [181, 1],
        [182, 2],
      ],
    );
  });

  it("builds features keyed by concept id and skips granules without a footprint", () => {
    const granules = parseGranules({
      feed: { entry: [rawGranule(), rawGranule({ id: "G2-X", polygons: undefined })] },
    });
    const collection = granuleFootprints(granules);
    assert.equal(collection.features.length, 1);
    assert.equal(collection.features[0].id, "G4316079212-NSIDC_CPRD");
    assert.equal(collection.features[0].properties.size_mb, 64);
  });
});

describe("granule files", () => {
  it("names a file from its URL", () => {
    assert.equal(fileNameFromUrl(`${ATL08_URL}?sig=1`), "ATL08_20260718174253_05303206_007_01.h5");
    assert.equal(fileNameFromUrl("https://example.com/a%20b.h5"), "a b.h5");
  });

  it("recognizes granules the ICESat-2 / GEDI reader opens", () => {
    const [granule] = parseGranules({ feed: { entry: [rawGranule()] } });
    assert.equal(primaryDataLink(granule), ATL08_URL);
    assert.equal(isSpaceborneLidarGranule({ shortName: "ATL08" }, granule), true);
    const tif = { ...granule, dataLinks: ["https://example.com/HLS.B02.tif"] };
    assert.equal(isSpaceborneLidarGranule({ shortName: "HLSL30" }, tif), false);
    const atl03 = { ...granule, dataLinks: ["https://example.com/ATL03_2020.h5"] };
    assert.equal(isSpaceborneLidarGranule({ shortName: "ATL03" }, atl03), false);
  });

  it("formats sizes", () => {
    assert.equal(formatSizeMb(64), "64 MB");
    assert.equal(formatSizeMb(1640), "1.6 GB");
    assert.equal(formatSizeMb(2.25), "2.3 MB");
    assert.equal(formatSizeMb(null), null);
  });
});

describe("Earthdata Login tokens", () => {
  it("reads the expiry of a JWT token", () => {
    const payload = btoa(JSON.stringify({ exp: 1_800_000_000 }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    assert.equal(earthdataTokenExpiry(`x.${payload}.y`)?.getTime(), 1_800_000_000_000);
    assert.equal(earthdataTokenExpiry("not-a-jwt"), null);
  });

  it("exchanges credentials for a token with basic auth", async () => {
    let auth = "";
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ access_token: "tok" }));
    }) as typeof fetch;
    assert.equal(await requestEarthdataToken("user", "pässword", fakeFetch), "tok");
    assert.equal(auth, `Basic ${Buffer.from("user:pässword").toString("base64")}`);
    const rejecting = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(requestEarthdataToken("u", "p", rejecting), /rejected/);
  });
});
