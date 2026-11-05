import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  JAXA_COLORMAP_NAMES,
  JAXA_EARTH_CATALOG_URL,
  JAXA_EARTH_MODULE_URL,
  type JaxaEarthModule,
  defaultJaxaColormap,
  fetchJaxaCatalog,
  getJaxaImageCollection,
  isJaxaDatasetId,
  isJaxaDatasetMappable,
  jaxaCollectionUrl,
  jaxaColorsFor,
  jaxaMaxZoom,
  jaxaTileUrl,
  loadJaxaEarthModule,
  parseJaxaCatalog,
  parseJaxaTileUrl,
  percentileRange,
  renderJaxaTile,
  searchJaxaDatasets,
  setJaxaEarthModuleLoader,
} from "../packages/plugins/src/plugins/jaxa-earth-api";

const CATALOG = `
# Description of This File

This is a list of all datasets available in the JAXA Earth API.

# Main Recommended Data

## Land Surface Data

- JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global
- Not.Listed_dataset

## Land Surface Temperature

JAXA.G-Portal_GCOM-C.SGLI_standard.L3-LST.daytime.v3_global_monthly

## Empty group

- Missing.dataset_x

# How to create useful related URLs

## Ignored heading
* id: should-not-parse

# Dataset List

## ALOS World 3D - 30m (AW3D30)
* id: JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global
* collection: https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global/collection.json
* title: ALOS World 3D - 30m (AW3D30)
* description: Global digital surface model.
* keywords: Elevation, ALOS, JAXA
* dataProvider: JAXA EORC
* bands: DSM, MSK
* bbox: [-180,-90,180,90]
* epsg: 4326
* spatialResolution: 0.031
* startDate: 2024-04-01T00:00:00Z
* endDate: 2024-04-30T23:59:59Z
* temporalResolution: none
* normal: false

## Land Surface Temperature (Daytime/Monthly)
* id: JAXA.G-Portal_GCOM-C.SGLI_standard.L3-LST.daytime.v3_global_monthly
* title: Land Surface Temperature (Daytime/Monthly)
* description: Land surface temperature product.
* keywords: LST, SGLI, GCOM-C
* dataProvider: JAXA G-Portal
* bands: LST
* bbox: [-180,-90,180,90]
* epsg: 4326
* spatialResolution: 2.783
* startDate: 2018-01-01T00:00:00Z
* endDate: present
* temporalResolution: monthly
* normal: false

## Sea Ice Concentration (North)
* id: JAXA.JASMES_GCOM-W.AMSR2_ic0.v201_north_daily
* title: Sea Ice Concentration (North)
* bands: IC0
* bbox: [-8388608,-8388608,8388608,8388608]
* epsg: 3995
* spatialResolution: 10
* startDate: 2012-07-02T00:00:00Z
* endDate: present
* temporalResolution: daily
* normal: false

## No EPSG
* id: JAXA.no_epsg
* title: No EPSG
* bands: X

## No bands
* id: JAXA.no_bands
* title: Broken

## Bad id
* id: ../../etc/passwd
* bands: X
`;

describe("parseJaxaCatalog", () => {
  const catalog = parseJaxaCatalog(CATALOG);

  it("reads every well-formed dataset and drops the rest", () => {
    assert.deepEqual(
      catalog.datasets.map((dataset) => dataset.id),
      [
        "JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global",
        "JAXA.G-Portal_GCOM-C.SGLI_standard.L3-LST.daytime.v3_global_monthly",
        "JAXA.JASMES_GCOM-W.AMSR2_ic0.v201_north_daily",
        "JAXA.no_epsg",
      ],
    );
  });

  it("parses each field", () => {
    const [aw3d, lst, ice] = catalog.datasets;
    assert.deepEqual(aw3d.bands, ["DSM", "MSK"]);
    assert.deepEqual(aw3d.keywords, ["Elevation", "ALOS", "JAXA"]);
    assert.deepEqual(aw3d.bbox, [-180, -90, 180, 90]);
    assert.equal(aw3d.resolutionKm, 0.031);
    assert.equal(aw3d.provider, "JAXA EORC");
    assert.equal(aw3d.endDate, "2024-04-30T23:59:59Z");
    assert.equal(aw3d.normal, false);
    assert.equal(lst.endDate, null, "present means still updated");
    assert.equal(lst.temporalResolution, "monthly");
    assert.equal(ice.epsg, 3995);
    assert.equal(isJaxaDatasetMappable(ice), false);
    assert.equal(isJaxaDatasetMappable(aw3d), true);
    assert.equal(isJaxaDatasetMappable(catalog.datasets[3]), false, "no EPSG code");
  });

  it("keeps recommended groups to listed ids, with or without bullets", () => {
    assert.deepEqual(catalog.recommended, [
      { title: "Land Surface Data", ids: ["JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global"] },
      {
        title: "Land Surface Temperature",
        ids: ["JAXA.G-Portal_GCOM-C.SGLI_standard.L3-LST.daytime.v3_global_monthly"],
      },
    ]);
  });

  it("searches across titles, keywords and bands, requiring every term", () => {
    const ids = (query: string) =>
      searchJaxaDatasets(catalog.datasets, query).map((dataset) => dataset.id);
    assert.equal(ids("").length, 4);
    assert.deepEqual(ids("gcom-c lst"), [
      "JAXA.G-Portal_GCOM-C.SGLI_standard.L3-LST.daytime.v3_global_monthly",
    ]);
    assert.deepEqual(ids("DSM"), ["JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global"]);
    assert.deepEqual(ids("alos monthly"), []);
  });
});

describe("fetchJaxaCatalog", () => {
  it("fetches JAXA's catalog file", async () => {
    let requested = "";
    const catalog = await fetchJaxaCatalog((async (url: string) => {
      requested = url;
      return new Response(CATALOG);
    }) as typeof fetch);
    assert.equal(requested, JAXA_EARTH_CATALOG_URL);
    assert.equal(catalog.datasets.length, 4);
  });

  it("rejects an HTTP error and an empty catalog", async () => {
    await assert.rejects(
      fetchJaxaCatalog((async () => new Response("", { status: 503 })) as typeof fetch),
      /HTTP 503/,
    );
    await assert.rejects(
      fetchJaxaCatalog((async () => new Response("# Dataset List\n")) as typeof fetch),
      /no datasets/,
    );
  });
});

describe("dataset ids", () => {
  it("accepts JAXA ids and refuses path tricks", () => {
    assert.ok(isJaxaDatasetId("JAXA.EORC_GSMaP_standard.Gauge.00Z-23Z.v6_daily"));
    assert.equal(isJaxaDatasetId("../x"), false);
    assert.equal(isJaxaDatasetId("a/b"), false);
    assert.equal(isJaxaDatasetId("a..b"), false);
    assert.equal(isJaxaDatasetId(""), false);
    assert.equal(
      jaxaCollectionUrl("JAXA.x_y"),
      "https://s3.ap-northeast-1.wasabisys.com/je-pds/cog/v1/JAXA.x_y/collection.json",
    );
    assert.throws(() => jaxaCollectionUrl("x/../y"), /Invalid/);
  });
});

describe("tile URLs", () => {
  const spec = {
    datasetId: "JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global",
    band: "DSM",
    date: "2024-04-01T00:00:00.000Z",
    min: 0,
    max: 4000,
    colormap: "spectral",
    resampling: "bilinear" as const,
  };

  it("round-trips a spec through the template and a requested tile", () => {
    const template = jaxaTileUrl(spec);
    assert.match(template, /^jaxa-earth:\/\/tile\/\{z\}\/\{x\}\/\{y\}\?/);
    assert.deepEqual(parseJaxaTileUrl(template), spec);
    const tile = template.replace("{z}/{x}/{y}", "5/27/12");
    assert.deepEqual(parseJaxaTileUrl(tile), { ...spec, z: 5, x: 27, y: 12 });
  });

  it("rejects malformed tiles", () => {
    const bad = (patch: Record<string, string>) => {
      const params = new URLSearchParams({
        id: spec.datasetId,
        band: spec.band,
        date: spec.date,
        min: "0",
        max: "1",
        ...patch,
      });
      return parseJaxaTileUrl(`jaxa-earth://tile/1/0/0?${params.toString()}`);
    };
    assert.notEqual(bad({}), null);
    assert.equal(bad({ id: "../x" }), null);
    assert.equal(bad({ band: "a b" }), null);
    assert.equal(bad({ date: "soon" }), null);
    assert.equal(bad({ min: "2", max: "1" }), null);
    assert.equal(bad({ max: "NaN" }), null);
    assert.equal(bad({ min: "" }), null, "a blank bound is not 0");
    assert.equal(
      parseJaxaTileUrl(
        `jaxa-earth://tile/1/0/0?id=${spec.datasetId}&band=DSM&date=${spec.date}&max=1`,
      ),
      null,
      "an absent bound is not 0",
    );
    assert.equal(parseJaxaTileUrl("https://example.com/1/0/0?id=x"), null);
    assert.equal(bad({ colormap: "nope" })?.colormap, "jet", "unknown colormap falls back");
    assert.equal(bad({ resampling: "cubic" })?.resampling, "nearest");
  });
});

describe("color maps and zoom", () => {
  it("passes JAXA presets through and expands GeoLibre ramps", () => {
    assert.equal(jaxaColorsFor("ndvi"), "ndvi");
    const viridis = jaxaColorsFor("viridis");
    assert.ok(Array.isArray(viridis));
    assert.ok((viridis as string[]).every((color) => /^[0-9a-f]{6}$/.test(color)));
    assert.equal(jaxaColorsFor("unknown"), "jet");
    assert.ok(JAXA_COLORMAP_NAMES.includes("jet"));
    assert.ok(JAXA_COLORMAP_NAMES.includes("turbo"));
    assert.equal(new Set(JAXA_COLORMAP_NAMES).size, JAXA_COLORMAP_NAMES.length);
  });

  it("picks a starting color map from the band", () => {
    assert.equal(defaultJaxaColormap("JAXA.x_ndvi", "NDVI"), "ndvi");
    assert.equal(defaultJaxaColormap("JAXA.EORC_ALOS.PRISM_AW3D30.v4.1_global", "DSM"), "spectral");
    assert.equal(defaultJaxaColormap("JAXA.x_L3-LST", "LST"), "turbo");
    assert.equal(defaultJaxaColormap("JAXA.other", "X"), "viridis");
  });

  it("caps the zoom at the dataset's resolution", () => {
    assert.equal(jaxaMaxZoom(0.031), 13);
    assert.equal(jaxaMaxZoom(2.783), 6);
    assert.equal(jaxaMaxZoom(50), 2);
    assert.equal(jaxaMaxZoom(0.001), 14);
    assert.equal(jaxaMaxZoom(null), 12);
  });
});

describe("percentileRange", () => {
  it("clips outliers and ignores no-data", () => {
    const values = new Float32Array(1000);
    for (let i = 0; i < values.length; i += 1) values[i] = i;
    values[0] = Number.NaN;
    values[999] = 1e9;
    const range = percentileRange(values);
    assert.ok(range);
    assert.ok(range[0] >= 15 && range[0] <= 25, `min ${range[0]}`);
    assert.ok(range[1] >= 970 && range[1] <= 985, `max ${range[1]}`);
  });

  it("keeps a narrow range at a large offset and rounds outward", () => {
    const pressure = Array.from({ length: 101 }, (_, i) => 101175 + i * 3);
    assert.deepEqual(percentileRange(pressure), [101181, 101469]);
    assert.deepEqual(percentileRange([0.123, 0.5, 0.987]), [0.123, 0.987]);
    const [low, high] = percentileRange(Array.from({ length: 101 }, (_, i) => 250.37 + i * 0.7))!;
    assert.ok(low <= 251.77 && high >= 318.97, `${low}..${high}`);
  });

  it("widens a constant sample and gives up on an empty one", () => {
    assert.deepEqual(percentileRange([5, 5, 5]), [4.5, 5.5]);
    assert.equal(percentileRange([Number.NaN]), null);
    assert.equal(percentileRange([]), null);
  });
});

describe("the JAXA module", () => {
  afterEach(() => setJaxaEarthModuleLoader(null));

  /** A fake module recording what the generators were built with. */
  function fakeModule() {
    const built: Array<Record<string, unknown>> = [];
    const tiles: Array<[number, number, number]> = [];
    const module = {
      Resampling: { NEAREST: "nearest", BILINEAR: "bilinear" },
      TileGenerator: class {
        constructor(options: Record<string, unknown>) {
          built.push(options);
        }
        async init() {}
        async getPng(x: number, y: number, z: number) {
          tiles.push([x, y, z]);
          // A view into a larger buffer, as typed-array slicing produces.
          return new Uint8Array(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer, 1, 3);
        }
      },
      ImageCollection: class {
        constructor(public options: { collectionUrl: string }) {}
        async init() {}
      },
      image: { ColorMap: class {} },
    } as unknown as JaxaEarthModule;
    return { module, built, tiles };
  }

  it("renders a tile through one cached generator per spec", async () => {
    const fake = fakeModule();
    setJaxaEarthModuleLoader(async () => fake.module);
    const template = jaxaTileUrl({
      datasetId: "JAXA.ds",
      band: "LST",
      date: "2024-05-01T00:00:00.000Z",
      min: 250,
      max: 320,
      colormap: "viridis",
      resampling: "bilinear",
    });
    const png = await renderJaxaTile(template.replace("{z}/{x}/{y}", "3/7/2"));
    assert.deepEqual([...new Uint8Array(png)], [1, 2, 3], "exactly the view's bytes");
    await renderJaxaTile(template.replace("{z}/{x}/{y}", "3/6/2"));
    assert.equal(fake.built.length, 1);
    assert.deepEqual(fake.tiles, [
      [7, 2, 3],
      [6, 2, 3],
    ]);
    const options = fake.built[0];
    assert.equal(options.collectionUrl, jaxaCollectionUrl("JAXA.ds"));
    assert.equal(options.band, "LST");
    assert.equal((options.date as Date).toISOString(), "2024-05-01T00:00:00.000Z");
    assert.equal(options.resampling, "bilinear");
    assert.equal(options.tileSize, 256);
    const colorMap = options.colorMapObject as { min: number; max: number; colors: string[] };
    assert.equal(colorMap.min, 250);
    assert.equal(colorMap.max, 320);
    assert.ok(Array.isArray(colorMap.colors));
  });

  it("refuses a template without a tile address or a bad spec", async () => {
    setJaxaEarthModuleLoader(async () => fakeModule().module);
    await assert.rejects(renderJaxaTile("jaxa-earth://tile/{z}/{x}/{y}?id=x"), /Invalid/);
    await assert.rejects(renderJaxaTile("jaxa-earth://tile/1/0/0?id=../x"), /Invalid/);
  });

  it("shares one initialized collection per dataset and retries a failed load", async () => {
    let loads = 0;
    setJaxaEarthModuleLoader(async () => {
      loads += 1;
      if (loads === 1) throw new Error("offline");
      return fakeModule().module;
    });
    await assert.rejects(getJaxaImageCollection("JAXA.ds"), /offline/);
    const first = await getJaxaImageCollection("JAXA.ds");
    const second = await getJaxaImageCollection("JAXA.ds");
    assert.equal(first, second);
    assert.equal(loads, 2);
  });

  it("refuses a module whose checksum changed", async () => {
    const realFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = (async (url: string) => {
      requested = url;
      return new Response("export const tampered = true;");
    }) as typeof fetch;
    try {
      await assert.rejects(loadJaxaEarthModule(), /changed/);
      assert.equal(requested, JAXA_EARTH_MODULE_URL);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
