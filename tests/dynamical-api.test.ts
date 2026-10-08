import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DYNAMICAL_CATALOG_URL,
  MAX_REGIONAL_CHUNK_BYTES,
  chunkBytes,
  chunkFootprint,
  datasetMapSupport,
  defaultSliceIndex,
  defaultVariableStyle,
  fetchDynamicalCatalog,
  formatLeadTime,
  formatUtc,
  needsRegionalView,
  parseDynamicalCatalog,
  parseDynamicalCollection,
  projectedBounds,
  projectedDimensions,
  projectionFromSpatialRef,
  regionalMinZoom,
  sampleRange,
  sliceDimensions,
  sliceSelectorValue,
  slicesPerChunk,
  type DynamicalVariable,
} from "../packages/plugins/src/plugins/dynamical-api";
import { isIcechunkAsset } from "../packages/plugins/src/plugins/stac-api";

/** Trimmed from https://stac.dynamical.org/noaa-gfs-forecast/collection.json. */
const gfsForecast = {
  type: "Collection",
  id: "noaa-gfs-forecast",
  title: "NOAA GFS forecast",
  description: "Weather forecasts from the Global Forecast System (GFS) operated by NOAA NWS NCEP.",
  description_summary: "This dataset is an archive of past and present GFS forecasts.",
  attribution:
    "NOAA NWS NCEP GFS data processed by dynamical.org from NOAA Open Data Dissemination archives.",
  version: "0.2.7",
  model_name: "NOAA GFS",
  license: "CC-BY-4.0",
  links: [
    { rel: "root", href: "https://stac.dynamical.org/catalog.json" },
    { rel: "about", href: "https://dynamical.org/catalog/noaa-gfs-forecast/", type: "text/html" },
  ],
  extent: {
    spatial: { bbox: [[-180.0, -90.0, 179.75, 90.0]] },
    temporal: { interval: [["2021-05-01T00:00:00Z", null]] },
  },
  summaries: {
    spatial_domain: ["Global"],
    spatial_resolution: ["0.25 degrees (~20km)"],
    time_domain: ["Forecasts initialized 2021-05-01 00:00:00 UTC to Present"],
    forecast_domain: ["Forecast lead time 0-384 hours (0-16 days) ahead"],
  },
  "cube:dimensions": {
    init_time: {
      type: "temporal",
      extent: ["2021-05-01T00:00:00Z", null],
      unit: "seconds since 1970-01-01",
    },
    latitude: { type: "spatial", extent: [-90, 90], axis: "y", unit: "degree_north", size: 721 },
    lead_time: { type: "other", extent: [0, 1382400], unit: "seconds", size: 209 },
    longitude: {
      type: "spatial",
      extent: [-180, 179.75],
      axis: "x",
      unit: "degree_east",
      size: 1440,
    },
  },
  "cube:variables": {
    temperature_2m: {
      dimensions: ["init_time", "lead_time", "latitude", "longitude"],
      type: "data",
      chunks: [1, 105, 121, 121],
      unit: "degree_Celsius",
      long_name: "2 metre temperature",
    },
    wind_u_10m: {
      dimensions: ["init_time", "lead_time", "latitude", "longitude"],
      type: "data",
      chunks: [1, 105, 121, 121],
      unit: "m s-1",
      long_name: "10 metre U wind component",
    },
    spatial_ref: { dimensions: [], type: "auxiliary" },
  },
  assets: {
    icechunk: {
      href: "s3://dynamical-noaa-gfs/noaa-gfs-forecast/v0.2.7.icechunk/",
      type: "application/x-icechunk",
    },
    "icechunk-https": {
      href: "https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-forecast/v0.2.7.icechunk",
      type: "application/x-icechunk",
      title: "Icechunk v2 repository (HTTPS)",
    },
  },
};

const gfsAnalysis = {
  ...gfsForecast,
  id: "noaa-gfs-analysis",
  title: "NOAA GFS analysis",
  "cube:dimensions": {
    latitude: gfsForecast["cube:dimensions"].latitude,
    longitude: gfsForecast["cube:dimensions"].longitude,
    time: { type: "temporal", extent: ["2021-05-01T00:00:00Z", null] },
  },
  "cube:variables": {
    temperature_2m: {
      dimensions: ["time", "latitude", "longitude"],
      type: "data",
      chunks: [1440, 50, 50],
      unit: "degree_Celsius",
    },
  },
};

const gfsVirtual = {
  ...gfsForecast,
  id: "noaa-gfs-forecast-virtual",
  "cube:variables": {
    temperature_2m: { ...gfsForecast["cube:variables"].temperature_2m, chunks: [1, 1, 721, 1440] },
  },
  assets: {
    "icechunk-https": {
      ...gfsForecast.assets["icechunk-https"],
      "icechunk:virtual_chunk_containers": [{ url_prefix: "s3://noaa-gfs-bdp-pds/" }],
    },
  },
};

const hrrr = {
  ...gfsForecast,
  id: "noaa-hrrr-forecast-48-hour",
  "cube:dimensions": {
    init_time: gfsForecast["cube:dimensions"].init_time,
    lead_time: { type: "other", size: 49 },
    x: {
      type: "spatial",
      axis: "x",
      unit: "m",
      size: 1799,
      extent: [-2697520.142521929, 2696479.857478071],
    },
    y: {
      type: "spatial",
      axis: "y",
      unit: "m",
      size: 1059,
      extent: [-1587306.152556665, 1586693.847443335],
    },
  },
  "cube:variables": {
    temperature_2m: {
      dimensions: ["init_time", "lead_time", "y", "x"],
      type: "data",
      chunks: [1, 49, 265, 300],
      unit: "degree_Celsius",
    },
  },
};

function parsed(document: unknown) {
  const dataset = parseDynamicalCollection(document);
  assert.ok(dataset);
  return dataset;
}

describe("parseDynamicalCatalog", () => {
  it("lists the child collections, keyed by their folder", () => {
    const entries = parseDynamicalCatalog({
      type: "Catalog",
      links: [
        { rel: "root", href: "https://stac.dynamical.org/catalog.json" },
        {
          rel: "child",
          href: "https://stac.dynamical.org/noaa-gfs-forecast/collection.json",
          title: "NOAA GFS forecast",
        },
        { rel: "child", href: "./dwd-icon-eu-forecast-5-day/collection.json" },
      ],
    });
    assert.deepEqual(entries, [
      {
        id: "noaa-gfs-forecast",
        title: "NOAA GFS forecast",
        href: "https://stac.dynamical.org/noaa-gfs-forecast/collection.json",
      },
      {
        id: "dwd-icon-eu-forecast-5-day",
        title: "dwd-icon-eu-forecast-5-day",
        href: "https://stac.dynamical.org/dwd-icon-eu-forecast-5-day/collection.json",
      },
    ]);
  });

  it("returns nothing for a document that is not a catalog", () => {
    assert.deepEqual(parseDynamicalCatalog(null), []);
    assert.deepEqual(parseDynamicalCatalog({ links: "nope" }), []);
  });
});

describe("parseDynamicalCollection", () => {
  it("reads the HTTPS repository, summaries, and data variables", () => {
    const dataset = parsed(gfsForecast);
    assert.equal(
      dataset.repositoryUrl,
      "https://dynamical-noaa-gfs.s3.us-west-2.amazonaws.com/noaa-gfs-forecast/v0.2.7.icechunk",
    );
    assert.equal(dataset.virtual, false);
    assert.equal(dataset.docsUrl, "https://dynamical.org/catalog/noaa-gfs-forecast/");
    assert.deepEqual(dataset.bbox, [-180, -90, 179.75, 90]);
    assert.equal(dataset.spatialResolution, "0.25 degrees (~20km)");
    assert.equal(dataset.license, "CC-BY-4.0");
    // The auxiliary spatial_ref is not something to draw.
    assert.deepEqual(
      dataset.variables.map((variable) => variable.name),
      ["temperature_2m", "wind_u_10m"],
    );
    assert.equal(dataset.variables[0].longName, "2 metre temperature");
  });

  it("falls back to the catalog page for a non-http documentation link", () => {
    const dataset = parsed({
      ...gfsForecast,
      links: [{ rel: "about", href: "javascript:alert(1)" }],
    });
    assert.equal(dataset.docsUrl, "https://dynamical.org/catalog/noaa-gfs-forecast/");
  });

  it("flags a virtual repository", () => {
    assert.equal(parsed(gfsVirtual).virtual, true);
  });

  it("rejects a collection with no HTTPS Icechunk asset", () => {
    assert.equal(
      parseDynamicalCollection({
        ...gfsForecast,
        assets: { icechunk: gfsForecast.assets.icechunk },
      }),
      null,
    );
    assert.equal(parseDynamicalCollection({ type: "Catalog", id: "x" }), null);
  });
});

describe("datasetMapSupport", () => {
  it("accepts a forecast whose chunks hold one run's lead times", () => {
    const dataset = parsed(gfsForecast);
    assert.equal(slicesPerChunk(dataset, dataset.variables[0]), 105);
    assert.equal(datasetMapSupport(dataset), "supported");
  });

  it("judges a dataset by its worst variable", () => {
    const mixed = parsed({
      ...gfsForecast,
      "cube:variables": {
        ...gfsForecast["cube:variables"],
        precipitation_sum: {
          ...gfsForecast["cube:variables"].temperature_2m,
          chunks: [1440, 1, 50, 50],
        },
      },
    });
    assert.equal(datasetMapSupport(mixed), "regional");
  });

  it("draws a time-series layout a region at a time", () => {
    const dataset = parsed(gfsAnalysis);
    assert.equal(chunkBytes(dataset, dataset.variables[0]), 1440 * 50 * 50 * 4);
    assert.equal(datasetMapSupport(dataset), "regional");
  });

  it("draws a virtual repository, whose chunks are one GRIB message each", () => {
    assert.equal(datasetMapSupport(parsed(gfsVirtual)), "supported");
  });

  it("refuses a chunk too large to decode even for one region", () => {
    const dataset = parsed({
      ...gfsAnalysis,
      "cube:variables": {
        temperature_2m: {
          ...gfsAnalysis["cube:variables"].temperature_2m,
          chunks: [24000, 50, 50],
        },
      },
    });
    assert.ok(chunkBytes(dataset, dataset.variables[0]) > MAX_REGIONAL_CHUNK_BYTES);
    assert.equal(datasetMapSupport(dataset), "time-series");
  });
});

describe("regional views", () => {
  const viewport = { width: 1600, height: 900 };

  it("needs no minimum zoom for a forecast or a virtual repository", () => {
    for (const document of [gfsForecast, gfsVirtual]) {
      const dataset = parsed(document);
      assert.equal(needsRegionalView(dataset, dataset.variables[0]), false);
      assert.equal(regionalMinZoom(dataset, dataset.variables[0], viewport), 0);
    }
  });

  it("sizes a chunk in degrees, and a projected grid's from metres", () => {
    const analysis = parsed(gfsAnalysis);
    assert.deepEqual(chunkFootprint(analysis, analysis.variables[0]), {
      x: 12.5,
      y: 12.5,
      columns: 29,
      rows: 15,
    });
    const projected = parsed(hrrr);
    const footprint = chunkFootprint(projected, projected.variables[0]);
    assert.ok(footprint);
    // 300 cells of 3 km.
    assert.ok(Math.abs(footprint.x - 900_000 / 111_320) < 1e-6);
    assert.deepEqual([footprint.columns, footprint.rows], [6, 4]);
  });

  it("zooms in until the chunks in view fit the budget", () => {
    const dataset = parsed(gfsAnalysis);
    const variable = dataset.variables[0];
    assert.equal(needsRegionalView(dataset, variable), true);
    // 13.7 MB chunks of 12.5 degrees: 18 fit in 256 MB, a 4 x 3 block at zoom 5.
    assert.equal(regionalMinZoom(dataset, variable, viewport), 5);
    // A larger map, or a smaller budget, needs a deeper zoom.
    assert.ok(regionalMinZoom(dataset, variable, { width: 3840, height: 2160 }) > 5);
    assert.ok(regionalMinZoom(dataset, variable, viewport, 64 * 2 ** 20) > 5);
    // A budget that holds the whole grid draws at any zoom.
    assert.equal(regionalMinZoom(dataset, variable, viewport, 29 * 15 * 14_400_000), 0);
  });
});

describe("slice dimensions", () => {
  it("lists the non-spatial dimensions in array order", () => {
    const dataset = parsed(gfsForecast);
    assert.deepEqual(sliceDimensions(dataset, dataset.variables[0]), ["init_time", "lead_time"]);
  });

  it("starts a timestamp axis on its newest step and others on the first", () => {
    const dataset = parsed(gfsForecast);
    assert.equal(defaultSliceIndex(dataset, "init_time", 7942), 7941);
    assert.equal(defaultSliceIndex(dataset, "lead_time", 209), 0);
    assert.equal(defaultSliceIndex(dataset, "init_time", 0), 0);
  });

  it("passes an index unless it names another step's coordinate", () => {
    // Lead times in seconds never collide with an index.
    assert.equal(sliceSelectorValue(3, [0, 3600, 7200, 10800]), 3);
    // Members numbered from zero: the index is the value.
    assert.equal(sliceSelectorValue(2, [0, 1, 2, 3]), 2);
    // Numbered from one: index 2 would select member 2 at index 1, so pass the value.
    assert.equal(sliceSelectorValue(2, [1, 2, 3, 4]), 3);
  });
});

describe("projected grids", () => {
  it("names a lat/lon grid's dimensions as needing no help", () => {
    assert.equal(projectedDimensions(parsed(gfsForecast)), null);
    assert.equal(projectedBounds(parsed(gfsForecast)), null);
  });

  it("maps x/y and widens the cell-centre extents to the grid's edges", () => {
    const dataset = parsed(hrrr);
    assert.deepEqual(projectedDimensions(dataset), { lat: "y", lon: "x" });
    const bounds = projectedBounds(dataset);
    assert.ok(bounds);
    // 3 km cells: half a cell beyond each centre.
    assert.ok(Math.abs(bounds[0] - (-2697520.142521929 - 1500)) < 1e-6);
    assert.ok(Math.abs(bounds[3] - (1586693.847443335 + 1500)) < 1e-6);
  });
});

describe("projectionFromSpatialRef", () => {
  it("spells a rotated-pole grid out as ob_tran", () => {
    // ECCC HRDPS's spatial_ref.
    assert.equal(
      projectionFromSpatialRef({
        grid_mapping_name: "rotated_latitude_longitude",
        grid_north_pole_latitude: 36.08852,
        grid_north_pole_longitude: 65.305142,
        semi_major_axis: 6371229,
        crs_wkt: 'GEOGCRS["Coordinate System imported from GRIB file"]',
      }),
      "+proj=ob_tran +o_proj=longlat +o_lat_p=36.08852 +o_lon_p=0 +lon_0=245.305142 +R=6371229 +no_defs",
    );
  });

  it("passes any other grid through as its WKT", () => {
    assert.equal(
      projectionFromSpatialRef({
        grid_mapping_name: "lambert_conformal_conic",
        crs_wkt: "PROJCS[]",
      }),
      "PROJCS[]",
    );
    assert.equal(projectionFromSpatialRef({}), null);
  });
});

describe("formatting", () => {
  it("formats UTC times and lead times", () => {
    assert.equal(formatUtc(Date.UTC(2026, 9, 7, 6)), "2026-10-07 06:00 UTC");
    assert.equal(formatUtc(Number.NaN), "—");
    assert.equal(formatLeadTime(0), "+0 h");
    assert.equal(formatLeadTime(6 * 3600), "+6 h");
    assert.equal(formatLeadTime(54 * 3600), "+2 d 6 h");
    assert.equal(formatLeadTime(384 * 3600), "+16 d");
  });
});

describe("defaultVariableStyle", () => {
  const variable = (name: string, unit: string): DynamicalVariable => ({
    name,
    unit,
    longName: name,
    dimensions: [],
    chunks: [],
  });

  it("fixes the range where the physics give one", () => {
    assert.deepEqual(defaultVariableStyle(variable("temperature_2m", "degree_Celsius")), {
      colormap: "coolwarm",
      clim: [-30, 40],
    });
    assert.deepEqual(defaultVariableStyle(variable("total_cloud_cover_atmosphere", "percent")), {
      colormap: "gray",
      clim: [0, 100],
    });
    assert.deepEqual(defaultVariableStyle(variable("wind_u_10m", "m s-1")), {
      colormap: "coolwarm",
      clim: [-25, 25],
      diverging: true,
    });
  });

  it("leaves the range to the data otherwise", () => {
    assert.equal(defaultVariableStyle(variable("pressure_surface", "Pa")).clim, undefined);
    assert.equal(
      defaultVariableStyle(variable("downward_short_wave_radiation_flux_surface", "W m-2")).clim,
      undefined,
    );
  });
});

describe("sampleRange", () => {
  it("takes the 2nd-98th percentile, rounded outward", () => {
    const values = Array.from({ length: 101 }, (_, index) => index * 10);
    values.push(Number.NaN, 1e9);
    assert.deepEqual(sampleRange(values), [20, 990]);
  });

  it("does not let floating-point error push a bound past its value", () => {
    assert.deepEqual(sampleRange([0.3, 0.5, 0.9]), [0.3, 0.9]);
  });

  it("centres a diverging range on zero", () => {
    assert.deepEqual(sampleRange([-3, -2, -1, 0, 1, 2, 12], true), [-12, 12]);
  });

  it("returns null for a sample with nothing to span", () => {
    assert.equal(sampleRange([Number.NaN, 5]), null);
    assert.equal(sampleRange([5, 5, 5]), null);
  });
});

describe("fetchDynamicalCatalog", () => {
  it("reads every collection and skips one that fails", async () => {
    const documents: Record<string, unknown> = {
      [DYNAMICAL_CATALOG_URL]: {
        type: "Catalog",
        links: [
          { rel: "child", href: "https://stac.dynamical.org/noaa-gfs-forecast/collection.json" },
          { rel: "child", href: "https://stac.dynamical.org/broken/collection.json" },
        ],
      },
      "https://stac.dynamical.org/noaa-gfs-forecast/collection.json": gfsForecast,
    };
    const fetcher = async (url: string) =>
      url in documents
        ? new Response(JSON.stringify(documents[url]), { status: 200 })
        : new Response("missing", { status: 404 });
    const datasets = await fetchDynamicalCatalog(fetcher);
    assert.deepEqual(
      datasets.map((dataset) => dataset.id),
      ["noaa-gfs-forecast"],
    );
  });

  it("rejects when the root catalog cannot be read", async () => {
    await assert.rejects(fetchDynamicalCatalog(async () => new Response("down", { status: 503 })));
  });
});

describe("isIcechunkAsset", () => {
  it("recognizes dynamical.org's media type and repository path, which name no branch", () => {
    assert.equal(isIcechunkAsset(gfsForecast.assets["icechunk-https"]), true);
    assert.equal(
      isIcechunkAsset({ href: "https://host/data/v1.icechunk/", type: "application/octet-stream" }),
      true,
    );
    assert.equal(
      isIcechunkAsset({ href: "https://host/data.zarr", type: "application/vnd+zarr" }),
      false,
    );
  });
});
