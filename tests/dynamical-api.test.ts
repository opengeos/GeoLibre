import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DYNAMICAL_CATALOG_URL,
  MAX_REGIONAL_CHUNK_BYTES,
  bboxCenter,
  bboxContains,
  chunkBytes,
  chunkFootprint,
  datasetMapSupport,
  defaultSliceIndex,
  defaultVariableStyle,
  fetchDynamicalCatalog,
  formatLeadTime,
  formatUtc,
  formatUtcTimeOfDay,
  memberDimension,
  nearestIndex,
  nearestLongitudeIndex,
  needsRegionalView,
  niceTicks,
  parseDynamicalCatalog,
  parseDynamicalCollection,
  projectedBounds,
  projectedDimensions,
  projectionFromSpatialRef,
  regionalMinZoom,
  sampleRange,
  seriesCsv,
  seriesDimension,
  seriesWindow,
  summarizeSeries,
  timeTicks,
  wrapLongitude,
  sliceDimensions,
  sliceSelectorValue,
  slicesPerChunk,
  stepForUtcDate,
  stepsOnUtcDate,
  utcDateKey,
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
    assert.equal(chunkBytes(dataset.variables[0]), 1440 * 50 * 50 * 4);
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
    assert.ok(chunkBytes(dataset.variables[0]) > MAX_REGIONAL_CHUNK_BYTES);
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

describe("dataset boxes", () => {
  it("contains points inside a box and across 180 degrees", () => {
    const conus: [number, number, number, number] = [-130, 20, -60, 55];
    assert.equal(bboxContains(conus, -100, 40), true);
    assert.equal(bboxContains(conus, 10, 40), false);
    assert.equal(bboxContains(conus, -100, 60), false);
    // A Pacific box from 160 E to 160 W.
    const pacific: [number, number, number, number] = [160, -10, -160, 10];
    assert.equal(bboxContains(pacific, 175, 0), true);
    assert.equal(bboxContains(pacific, -170, 0), true);
    assert.equal(bboxContains(pacific, 190, 0), true);
    assert.equal(bboxContains(pacific, 0, 0), false);
  });

  it("centres a box, across 180 degrees too", () => {
    assert.deepEqual(bboxCenter([-130, 20, -60, 50]), [-95, 35]);
    assert.deepEqual(bboxCenter([160, -10, -160, 10]), [180, 0]);
    assert.deepEqual(bboxCenter([170, -10, -170, 10]), [180, 0]);
    assert.deepEqual(bboxCenter([150, -10, -170, 10]), [170, 0]);
  });
});

describe("point series", () => {
  const ensemble = parsed({
    ...gfsForecast,
    id: "noaa-gefs-forecast-35-day",
    "cube:dimensions": {
      ...gfsForecast["cube:dimensions"],
      ensemble_member: { type: "other", size: 31 },
    },
    "cube:variables": {
      temperature_2m: {
        dimensions: ["init_time", "ensemble_member", "lead_time", "latitude", "longitude"],
        type: "data",
        chunks: [1, 31, 64, 17, 16],
        unit: "degree_Celsius",
      },
    },
  });

  it("runs a forecast along its lead times and an analysis along time", () => {
    const forecast = parsed(gfsForecast);
    assert.equal(seriesDimension(forecast, forecast.variables[0]), "lead_time");
    assert.equal(memberDimension(forecast, forecast.variables[0]), null);
    const analysis = parsed(gfsAnalysis);
    assert.equal(seriesDimension(analysis, analysis.variables[0]), "time");
    assert.equal(seriesDimension(ensemble, ensemble.variables[0]), "lead_time");
    assert.equal(memberDimension(ensemble, ensemble.variables[0]), "ensemble_member");
  });

  it("reads whole chunks around the chosen step, as many as the budget allows", () => {
    const forecast = parsed(gfsForecast);
    // Two 6 MB chunks of lead times: the whole run fits.
    assert.deepEqual(
      seriesWindow(forecast, forecast.variables[0], "lead_time", 150, 209),
      [0, 209],
    );
    // One GRIB message per step: 24 steps of 4 MB around step 100.
    const virtual = parsed(gfsVirtual);
    assert.deepEqual(seriesWindow(virtual, virtual.variables[0], "lead_time", 100, 209), [89, 113]);
    // 14.4 MB chunks of 1440 hours: six of them, ending at the newest.
    const analysis = parsed(gfsAnalysis);
    assert.deepEqual(seriesWindow(analysis, analysis.variables[0], "time", 19_999, 20_000), [
      8 * 1440,
      20_000,
    ]);
    // At least one chunk, however small the budget.
    assert.deepEqual(
      seriesWindow(analysis, analysis.variables[0], "time", 3000, 20_000, 1),
      [2880, 4320],
    );
  });

  it("pays for every member chunk of an ensemble", () => {
    const split = parsed({
      ...gfsForecast,
      "cube:dimensions": {
        ...gfsForecast["cube:dimensions"],
        ensemble_member: { type: "other", size: 31 },
      },
      "cube:variables": {
        temperature_2m: {
          dimensions: ["init_time", "ensemble_member", "lead_time", "latitude", "longitude"],
          type: "data",
          chunks: [1, 1, 64, 17, 16],
        },
      },
    });
    const whole = seriesWindow(ensemble, ensemble.variables[0], "lead_time", 0, 181);
    assert.deepEqual(whole, [0, 181]);
    // 31 member chunks of 70 KB each per lead chunk: a 4.3 MB budget reads two lead chunks.
    const bytes = 64 * 17 * 16 * 4 * 31;
    assert.deepEqual(
      seriesWindow(split, split.variables[0], "lead_time", 70, 181, bytes * 2),
      [64, 181],
    );
  });

  it("finds the nearest coordinate on ascending and descending axes", () => {
    const latitudes = [90, 89.75, 89.5, 89.25];
    assert.equal(nearestIndex(latitudes, 89.6), 2);
    assert.equal(nearestIndex(latitudes, 90.1), 0);
    assert.equal(nearestIndex(latitudes, 88), null);
    const longitudes = [-180, -179.75, -179.5];
    assert.equal(nearestIndex(longitudes, -179.7), 1);
    assert.equal(nearestIndex(longitudes, -180.2), null);
    assert.equal(nearestIndex([], 1), null);
  });

  it("treats a whole-circle longitude axis as periodic", () => {
    const global = Array.from({ length: 1440 }, (_, index) => index * 0.25);
    assert.equal(nearestLongitudeIndex(global, 359.9), 0);
    assert.equal(nearestLongitudeIndex(global, 359.8), 1439);
    const centred = Array.from({ length: 1440 }, (_, index) => -180 + index * 0.25);
    assert.equal(nearestLongitudeIndex(centred, 179.9), 0);
    // A regional axis stays bounded.
    assert.equal(nearestLongitudeIndex([-130, -129.75, -129.5], -120), null);
  });

  it("wraps a longitude into the axis convention", () => {
    assert.equal(wrapLongitude(200, [-180, 0, 179.75]), -160);
    assert.equal(wrapLongitude(-10, [0, 180, 359.75]), 350);
    assert.equal(wrapLongitude(-10, [-180, 179.75]), -10);
  });

  it("summarizes members into a mean and range, skipping missing ones", () => {
    assert.deepEqual(summarizeSeries([0, 1], [[2], [Number.NaN]]), [
      { time: 0, value: 2 },
      { time: 1, value: Number.NaN },
    ]);
    assert.deepEqual(summarizeSeries([0], [[1, 3, Number.NaN, 5]]), [
      { time: 0, value: 3, min: 1, max: 5 },
    ]);
  });

  it("picks clean value and time ticks", () => {
    assert.deepEqual(niceTicks(-3.2, 17.8, 4), [0, 5, 10, 15]);
    assert.deepEqual(niceTicks(0.0011, 0.0019, 4), [0.0012, 0.0014, 0.0016, 0.0018]);
    assert.deepEqual(niceTicks(4, 4), [4]);
    const day = 24 * 3_600_000;
    const start = Date.UTC(2026, 9, 8, 5);
    const ticks = timeTicks(start, start + 2 * day, 4);
    assert.deepEqual(
      ticks.map((tick) => new Date(tick).toISOString()),
      [
        "2026-10-08T12:00:00.000Z",
        "2026-10-09T00:00:00.000Z",
        "2026-10-09T12:00:00.000Z",
        "2026-10-10T00:00:00.000Z",
      ],
    );
  });

  it("writes the series as CSV, with mean and range columns for an ensemble", () => {
    const time = Date.UTC(2026, 9, 8, 6);
    assert.equal(
      seriesCsv(
        [
          { time, value: 12.5 },
          { time: time + 3_600_000, value: Number.NaN },
        ],
        "t2m (°C)",
      ),
      "time_utc,t2m (°C)\n2026-10-08T06:00:00.000Z,12.5\n2026-10-08T07:00:00.000Z,\n",
    );
    assert.equal(
      seriesCsv([{ time, value: 1, min: 0, max: 2 }], 'a,"b"'),
      'time_utc,"a,""b"" mean","a,""b"" min","a,""b"" max"\n2026-10-08T06:00:00.000Z,1,0,2\n',
    );
  });
});

describe("forecast run day picker", () => {
  const hour = 3_600_000;
  // Six-hourly runs from 2026-10-01 00Z, with 2026-10-03 missing from the archive.
  const runs = [0, 6, 12, 18, 24, 30, 36, 42, 72, 78, 84, 90].map(
    (offset) => Date.UTC(2026, 9, 1) + offset * hour,
  );

  it("keys and labels a timestamp by its UTC day and time", () => {
    assert.equal(utcDateKey(runs[5]), "2026-10-02");
    assert.equal(formatUtcTimeOfDay(runs[5]), "06:00 UTC");
    assert.equal(utcDateKey(Number.NaN), "");
  });

  it("lists the runs on a day", () => {
    assert.deepEqual(stepsOnUtcDate(runs, "2026-10-02"), [4, 5, 6, 7]);
    assert.deepEqual(stepsOnUtcDate(runs, "2026-10-03"), []);
    assert.deepEqual(stepsOnUtcDate([Number.NaN, Number.NaN], ""), []);
  });

  it("keeps the run's time of day when the day changes", () => {
    assert.equal(stepForUtcDate(runs, "2026-10-04", 2), 10);
  });

  it("falls back to the day's first run, then the nearest run", () => {
    assert.equal(stepForUtcDate([runs[0], runs[1]], "2026-10-01", 0), 0);
    assert.equal(stepForUtcDate(runs.slice(0, 2).concat(runs[6]), "2026-10-02", 1), 2);
    // 2026-10-03 06Z is missing; 2026-10-03 18Z (index 7) is 12 h away, 2026-10-04 00Z is 18 h.
    assert.equal(stepForUtcDate(runs, "2026-10-03", 1), 7);
    assert.equal(stepForUtcDate(runs, "not a day", 1), -1);
    assert.equal(stepForUtcDate([], "2026-10-01", 0), -1);
  });
});
