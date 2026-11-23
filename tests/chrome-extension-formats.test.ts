import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { scanDocumentForDatasets } from "../extensions/geolibre-chrome/scanner.mjs";
import {
  classifyServiceRequest,
  collectServiceCandidates,
} from "../extensions/geolibre-chrome/service-scanner.mjs";
import { buildGeoLibreUrl, buildGeoLibreUrls } from "../extensions/geolibre-chrome/url-builder.mjs";
import { FIREFOX_ADDON_ID, manifestForTarget } from "../scripts/extension-manifest.mjs";
import {
  dataUrlParameters,
  serviceUrlParameter,
  stacUrlParameter,
} from "../apps/geolibre-desktop/src/lib/data-url";

function scan(html: string, url = "https://catalog.example.com/page/") {
  const { document } = parseHTML(html);
  Object.defineProperty(document, "baseURI", {
    configurable: true,
    value: url,
  });
  const previous = globalThis.document;
  Object.assign(globalThis, { document });
  try {
    return scanDocumentForDatasets();
  } finally {
    Object.assign(globalThis, { document: previous });
  }
}

function formatsOf(found: Array<{ url: string; format: string }>) {
  return Object.fromEntries(found.map((entry) => [entry.url, entry.format]));
}

describe("GeoLibre extension: file formats in page links", () => {
  it("finds FlatGeobuf, GPX, KML/KMZ, Zarr, 3D Tiles and STAC links", () => {
    const found = scan(`
      <a href="parcels.fgb">Parcels</a>
      <a href="ride.gpx">Ride</a>
      <a href="places.kml">Places</a>
      <a href="tour.kmz">Tour</a>
      <a href="https://data.example.com/sst.zarr/.zmetadata">SST</a>
      <a href="https://data.example.com/sst.zarr/analysed_sst/0.0.0">chunk</a>
      <a href="https://tiles.example.com/city/tileset.json">City</a>
      <a href="https://stac.example.com/catalog.json">Catalog</a>
      <a href="https://stac.example.com/landsat/collection.json">Landsat</a>
    `);
    assert.deepEqual(formatsOf(found), {
      "https://catalog.example.com/page/parcels.fgb": "FlatGeobuf",
      "https://catalog.example.com/page/ride.gpx": "GPX",
      "https://catalog.example.com/page/places.kml": "KML",
      "https://catalog.example.com/page/tour.kmz": "KML",
      // The metadata document and the chunk collapse onto one store root.
      "https://data.example.com/sst.zarr": "Zarr",
      "https://tiles.example.com/city/tileset.json": "3D Tiles",
      "https://stac.example.com/catalog.json": "STAC",
      "https://stac.example.com/landsat/collection.json": "STAC",
    });
    assert.equal(found.find((entry) => entry.format === "3D Tiles")?.kind, "3d");
    assert.equal(found.find((entry) => entry.format === "STAC")?.kind, "catalog");
  });

  it("keeps a 3D Tiles hint from an unpacked GeoLibre link", () => {
    const link = `https://web.geolibre.app/?data=${encodeURIComponent(
      "https://api.example.com/tiles/42",
    )}&dataType=3d-tiles`;
    const [found] = scan(`<a href="${link}">tiles</a>`);
    assert.equal(found.format, "3D Tiles");
    assert.equal(found.dataType, "3d-tiles");
  });
});

describe("GeoLibre extension: service requests", () => {
  it("recognizes a WCS request and drops its coverage operation parameters", () => {
    const found = classifyServiceRequest(
      "https://maps.example.com/ows?map=dem&SERVICE=WCS&REQUEST=GetCoverage&COVERAGEID=elevation&SUBSET=Lat(1,2)",
    );
    assert.equal(found?.format, "WCS");
    assert.equal(found?.kind, "raster");
    assert.equal(found?.url, "https://maps.example.com/ows?map=dem");
    assert.equal(found?.layer, "elevation");
  });

  it("collapses ArcGIS MapServer and ImageServer requests to the service root", () => {
    const cases: Array<[string, string, string]> = [
      [
        "https://gis.example.com/arcgis/rest/services/Roads/MapServer/export?bbox=1,2,3,4&f=image",
        "ArcGIS Map Service",
        "https://gis.example.com/arcgis/rest/services/Roads/MapServer",
      ],
      // Row before column: read as an XYZ template, the axes would swap.
      [
        "https://gis.example.com/arcgis/rest/services/Roads/MapServer/tile/5/12/9",
        "ArcGIS Map Service",
        "https://gis.example.com/arcgis/rest/services/Roads/MapServer",
      ],
      [
        "https://gis.example.com/arcgis/rest/services/NAIP/ImageServer/exportImage?bbox=1,2,3,4",
        "ArcGIS Image Service",
        "https://gis.example.com/arcgis/rest/services/NAIP/ImageServer",
      ],
    ];
    for (const [request, format, url] of cases) {
      const found = classifyServiceRequest(request);
      assert.equal(found?.format, format, request);
      assert.equal(found?.url, url, request);
    }
    // A FeatureServer keeps its own rule and layer index.
    assert.equal(
      classifyServiceRequest(
        "https://gis.example.com/arcgis/rest/services/Parks/FeatureServer/2/query?where=1%3D1",
      )?.format,
      "ArcGIS Feature Service",
    );
  });

  it("tells a STAC API apart from a plain OGC API Features server", () => {
    assert.deepEqual(
      [
        "https://planetarycomputer.example.com/api/stac/v1/search?collections=naip",
        "https://planetarycomputer.example.com/api/stac/v1/collections/naip/items?limit=10",
        "https://stac.example.com/v1/collections/sentinel-2/items",
        "https://static.example.com/landsat/catalog.json",
      ].map((url) => {
        const found = classifyServiceRequest(url);
        return [found?.format, found?.url];
      }),
      [
        ["STAC", "https://planetarycomputer.example.com/api/stac/v1"],
        ["STAC", "https://planetarycomputer.example.com/api/stac/v1/collections/naip"],
        ["STAC", "https://stac.example.com/v1/collections/sentinel-2"],
        ["STAC", "https://static.example.com/landsat/catalog.json"],
      ],
    );
    assert.equal(
      classifyServiceRequest("https://demo.pygeoapi.io/master/collections/lakes/items")?.format,
      "OGC API",
    );
  });

  it("recognizes data files a page's map library fetched", () => {
    const urls = [
      "https://data.example.com/store.zarr/.zmetadata",
      "https://data.example.com/store.zarr/temp/0.0.1",
      "https://data.example.com/v3store/zarr.json",
      "https://tiles.example.com/city/tileset.json?key=abc",
      "https://data.example.com/parcels.fgb",
      "https://data.example.com/track.gpx",
      "https://data.example.com/places.kmz",
    ];
    assert.deepEqual(
      collectServiceCandidates(urls).map((entry) => [entry.format, entry.url]),
      [
        ["Zarr", "https://data.example.com/store.zarr"],
        ["Zarr", "https://data.example.com/v3store"],
        // A signed tileset keeps its token.
        ["3D Tiles", "https://tiles.example.com/city/tileset.json?key=abc"],
        ["FlatGeobuf", "https://data.example.com/parcels.fgb"],
        ["GPX", "https://data.example.com/track.gpx"],
        ["KML", "https://data.example.com/places.kmz"],
      ],
    );
  });
});

describe("GeoLibre extension: links for the new formats", () => {
  it("opens files through ?data=, Zarr and ArcGIS services through ?add=, STAC through ?stac=", () => {
    const data = new URL(
      buildGeoLibreUrl([
        { url: "https://data.example.com/parcels.fgb", format: "FlatGeobuf" },
        { url: "https://data.example.com/track.gpx", format: "GPX" },
        { url: "https://data.example.com/places.kmz", format: "KML" },
        {
          url: "https://tiles.example.com/city/tileset.json",
          format: "3D Tiles",
        },
      ]),
    );
    assert.deepEqual(data.searchParams.getAll("data"), [
      "https://data.example.com/parcels.fgb",
      "https://data.example.com/track.gpx",
      "https://data.example.com/places.kmz",
      "https://tiles.example.com/city/tileset.json",
    ]);

    const zarr = new URL(
      buildGeoLibreUrl([{ url: "https://data.example.com/sst.zarr", format: "Zarr" }]),
    );
    assert.equal(zarr.searchParams.get("add"), "zarr");
    assert.equal(zarr.searchParams.get("serviceUrl"), "https://data.example.com/sst.zarr");

    for (const format of ["ArcGIS Map Service", "ArcGIS Image Service"]) {
      const arcgis = new URL(
        buildGeoLibreUrl([{ url: "https://gis.example.com/rest/services/X/MapServer", format }]),
      );
      assert.equal(arcgis.searchParams.get("add"), "arcgis");
    }
    const wcs = new URL(buildGeoLibreUrl([{ url: "https://maps.example.com/ows", format: "WCS" }]));
    assert.equal(wcs.searchParams.get("add"), "wcs");

    const stac = new URL(
      buildGeoLibreUrl([{ url: "https://stac.example.com/v1/collections/s2", format: "STAC" }]),
    );
    assert.equal(stac.searchParams.get("stac"), "https://stac.example.com/v1/collections/s2");
    assert.equal(stac.searchParams.has("add"), false);
  });

  it("builds only links the GeoLibre app parses", () => {
    const zarr = buildGeoLibreUrl([{ url: "https://data.example.com/sst.zarr", format: "Zarr" }]);
    assert.deepEqual(serviceUrlParameter(new URL(zarr).search), {
      kind: "zarr",
      url: "https://data.example.com/sst.zarr",
      layer: null,
      styleUrl: null,
    });
    const stac = buildGeoLibreUrl([
      { url: "https://stac.example.com/catalog.json", format: "STAC" },
    ]);
    assert.equal(stacUrlParameter(new URL(stac).search), "https://stac.example.com/catalog.json");
    const wcs = buildGeoLibreUrl([{ url: "https://maps.example.com/ows", format: "WCS" }]);
    assert.equal(serviceUrlParameter(new URL(wcs).search)?.kind, "wcs");
    const tiles = buildGeoLibreUrl([
      {
        url: "https://api.example.com/tiles/42",
        format: "3D Tiles",
        dataType: "3d-tiles",
      },
    ]);
    assert.deepEqual(dataUrlParameters(new URL(tiles).search), [
      {
        dataUrl: "https://api.example.com/tiles/42",
        styleUrl: null,
        dataType: "3d-tiles",
      },
    ]);
  });

  it("opens a mixed selection with one combined link plus one per extra service or catalog", () => {
    const urls = buildGeoLibreUrls(
      [
        { url: "https://data.example.com/roads.geojson", format: "GeoJSON" },
        {
          url: "https://maps.example.com/wms",
          format: "WMS",
          layer: "topp:states",
        },
        { url: "https://data.example.com/parcels.fgb", format: "FlatGeobuf" },
        { url: "https://stac.example.com/catalog.json", format: "STAC" },
        {
          url: "https://gis.example.com/rest/services/X/ImageServer",
          format: "ArcGIS Image Service",
        },
        { url: "https://stac.example.com/other/catalog.json", format: "STAC" },
      ],
      "https://geolibre.example.com/app/",
    ).map((url) => new URL(url));
    assert.equal(urls.length, 3);
    const [combined, service, catalog] = urls;
    assert.equal(combined.origin + combined.pathname, "https://geolibre.example.com/app/");
    assert.deepEqual(combined.searchParams.getAll("data"), [
      "https://data.example.com/roads.geojson",
      "https://data.example.com/parcels.fgb",
    ]);
    assert.equal(combined.searchParams.get("add"), "wms");
    assert.equal(combined.searchParams.get("serviceLayer"), "topp:states");
    assert.equal(combined.searchParams.get("stac"), "https://stac.example.com/catalog.json");
    assert.equal(service.searchParams.get("add"), "arcgis");
    assert.equal(service.searchParams.has("data"), false);
    assert.equal(catalog.searchParams.get("stac"), "https://stac.example.com/other/catalog.json");
  });

  it("keeps a files-only selection in a single link", () => {
    const urls = buildGeoLibreUrls([
      { url: "https://data.example.com/a.geojson" },
      { url: "https://data.example.com/b.gpx", format: "GPX" },
    ]);
    assert.equal(urls.length, 1);
    assert.throws(() => buildGeoLibreUrls([]), /Select at least one/);
  });
});

describe("GeoLibre extension: Firefox target", () => {
  const chrome = JSON.parse(
    readFileSync(new URL("../extensions/geolibre-chrome/manifest.json", import.meta.url), "utf8"),
  );

  it("leaves the Chrome manifest as checked in", () => {
    assert.deepEqual(manifestForTarget(chrome, "chrome"), chrome);
  });

  it("adds the Gecko id and data declaration and drops the Chrome-only key", () => {
    const firefox = manifestForTarget(chrome, "firefox");
    assert.equal(firefox.browser_specific_settings.gecko.id, FIREFOX_ADDON_ID);
    assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {
      required: ["none"],
    });
    assert.equal("minimum_chrome_version" in firefox, false);
    // Same permissions, popup and no background script on both.
    assert.deepEqual(firefox.permissions, chrome.permissions);
    assert.equal(firefox.action.default_popup, chrome.action.default_popup);
    assert.equal("background" in firefox, false);
    // The source manifest is not mutated.
    assert.equal("browser_specific_settings" in chrome, false);
  });

  it("rejects an unknown target", () => {
    assert.throws(() => manifestForTarget(chrome, "safari" as never), /Unknown extension target/);
  });
});
