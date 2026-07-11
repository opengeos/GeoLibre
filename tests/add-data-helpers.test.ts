import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { EOX_S2CLOUDLESS_ATTRIBUTION } from "../apps/geolibre-desktop/src/components/layout/add-data/constants";
import {
  appendQuery,
  attributionForTileUrl,
  createWfsGetCapabilitiesUrl,
  createWmsGetCapabilitiesUrl,
  createWmsTileUrl,
  fileNameFromPath,
  normalizeWmsVersion,
  stripOgcOperationParams,
  wmsVersionFromEndpoint,
  geoJsonToPointRows,
  layerNameFromPath,
  parseOptionalNumber,
  parseRequiredNumber,
  parseVideoCorner,
  resolveDelimitedTextDelimiter,
  savedPostgresConnectionLabel,
  serviceRequestErrorMessage,
} from "../apps/geolibre-desktop/src/components/layout/add-data/helpers";
import type { TFunction } from "i18next";

// A minimal `t` stub: returns the key so the branch taken is observable, and
// echoes the fallback for the default branch.
const fakeT = ((key: string) => key) as unknown as TFunction;

describe("add-data path helpers", () => {
  it("extracts the file name from POSIX and Windows paths", () => {
    assert.equal(fileNameFromPath("/data/sub/route.gpx"), "route.gpx");
    assert.equal(fileNameFromPath("C:\\data\\route.gpx"), "route.gpx");
    assert.equal(fileNameFromPath("route.gpx"), "route.gpx");
  });

  it("derives a layer name by stripping the extension, with a fallback", () => {
    assert.equal(layerNameFromPath("/data/us_cities.csv", "Layer"), "us_cities");
    assert.equal(layerNameFromPath("/data/.hidden", "Layer"), "Layer");
  });
});

describe("appendQuery", () => {
  it("appends params with the right separator and encodes values", () => {
    assert.equal(
      appendQuery("https://x.test/wms", [["LAYERS", "a:b c"]]),
      "https://x.test/wms?LAYERS=a%3Ab%20c",
    );
    assert.equal(
      appendQuery("https://x.test/wms?foo=1", [["BAR", "2"]]),
      "https://x.test/wms?foo=1&BAR=2",
    );
    assert.equal(
      appendQuery("https://x.test/wms?", [["BAR", "2"]]),
      "https://x.test/wms?BAR=2",
    );
  });

  it("leaves the bbox placeholder unescaped", () => {
    assert.equal(
      appendQuery("https://x.test/wms", [["BBOX", "{bbox-epsg-3857}"]]),
      "https://x.test/wms?BBOX={bbox-epsg-3857}",
    );
  });
});

describe("createWmsTileUrl", () => {
  it("builds a GetMap request with the standard parameters", () => {
    const url = createWmsTileUrl({
      endpoint: "https://x.test/wms",
      layers: "topp:states",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: 256,
    });
    assert.ok(url.startsWith("https://x.test/wms?SERVICE=WMS&REQUEST=GetMap"));
    assert.ok(url.includes("LAYERS=topp%3Astates"));
    assert.ok(url.includes("TRANSPARENT=TRUE"));
    assert.ok(url.includes("BBOX={bbox-epsg-3857}"));
    assert.ok(url.includes("WIDTH=256"));
  });

  it("marks the request opaque when transparency is off", () => {
    const url = createWmsTileUrl({
      endpoint: "https://x.test/wms",
      layers: "a",
      styles: "",
      format: "image/jpeg",
      transparent: false,
      tileSize: 512,
    });
    assert.ok(url.includes("TRANSPARENT=FALSE"));
    assert.ok(url.includes("HEIGHT=512"));
  });

  it("defaults to WMS 1.1.1 with an SRS parameter", () => {
    const url = createWmsTileUrl({
      endpoint: "https://x.test/wms",
      layers: "a",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: 256,
    });
    assert.ok(url.includes("VERSION=1.1.1"));
    assert.ok(url.includes("SRS=EPSG%3A3857"));
    assert.ok(!url.includes("CRS="));
  });

  it("switches to CRS for a WMS 1.3.0 request", () => {
    // A 1.3.0-only server (e.g. the IGN Géoplateforme raster endpoint) rejects
    // a 1.1.1 GetMap with VersionNegotiationFailed, so the version must be
    // honored and the SRS parameter renamed to CRS.
    const url = createWmsTileUrl({
      endpoint: "https://x.test/wms",
      layers: "a",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: 256,
      version: "1.3.0",
    });
    assert.ok(url.includes("VERSION=1.3.0"));
    assert.ok(url.includes("CRS=EPSG%3A3857"));
    assert.ok(!url.includes("SRS="));
    assert.ok(url.includes("BBOX={bbox-epsg-3857}"));
  });
});

describe("normalizeWmsVersion", () => {
  it("collapses versions to the 1.1.1/1.3.0 pair", () => {
    assert.equal(normalizeWmsVersion(undefined), "1.1.1");
    assert.equal(normalizeWmsVersion(null), "1.1.1");
    assert.equal(normalizeWmsVersion("1.1.1"), "1.1.1");
    assert.equal(normalizeWmsVersion("1.3.0"), "1.3.0");
    assert.equal(normalizeWmsVersion("1.3"), "1.3.0");
    assert.equal(normalizeWmsVersion("garbage"), "1.1.1");
    // An untyped JS plugin can pass a non-string; it must not throw.
    assert.equal(normalizeWmsVersion(1.3), "1.1.1");
    assert.equal(normalizeWmsVersion({}), "1.1.1");
  });
});

describe("wmsVersionFromEndpoint", () => {
  it("reads the VERSION parameter from a pasted service URL", () => {
    assert.equal(
      wmsVersionFromEndpoint("https://data.geopf.fr/wms-r?VERSION=1.3.0"),
      "1.3.0",
    );
    assert.equal(
      wmsVersionFromEndpoint("https://x.test/wms?version=1.1.1&foo=1"),
      "1.1.1",
    );
    assert.equal(wmsVersionFromEndpoint("https://x.test/wms?VERSION=1.0.0"), "1.1.1");
    // Any 1.x value is bucketed the same way normalizeWmsVersion buckets it.
    assert.equal(wmsVersionFromEndpoint("https://x.test/wms?VERSION=1.2.0"), "1.1.1");
  });

  it("returns null when no usable version is present", () => {
    assert.equal(wmsVersionFromEndpoint("https://x.test/wms"), null);
    assert.equal(wmsVersionFromEndpoint("https://x.test/wms?VERSION=abc"), null);
    // An undecodable value must not throw.
    assert.equal(wmsVersionFromEndpoint("https://x.test/wms?VERSION=%E0%A4%A"), null);
  });
});

describe("createWmsGetCapabilitiesUrl", () => {
  it("appends SERVICE and REQUEST to a bare endpoint", () => {
    const url = new URL(createWmsGetCapabilitiesUrl("https://x.test/wms"));
    assert.equal(url.searchParams.get("SERVICE"), "WMS");
    assert.equal(url.searchParams.get("REQUEST"), "GetCapabilities");
  });

  it("strips leftover GetMap operation params so they cannot collide", () => {
    const url = new URL(
      createWmsGetCapabilitiesUrl(
        "https://x.test/wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=a&BBOX=0,0,1,1&token=abc",
      ),
    );
    assert.equal(url.searchParams.get("REQUEST"), "GetCapabilities");
    assert.equal(url.searchParams.get("LAYERS"), null);
    assert.equal(url.searchParams.get("BBOX"), null);
    // Non-operation params (e.g. an auth token) are preserved.
    assert.equal(url.searchParams.get("token"), "abc");
  });

  it("handles a relative endpoint", () => {
    assert.equal(
      createWmsGetCapabilitiesUrl("/geoserver/wms"),
      "/geoserver/wms?SERVICE=WMS&REQUEST=GetCapabilities",
    );
  });

  it("preserves a route-relative endpoint's path form", () => {
    assert.equal(
      createWmsGetCapabilitiesUrl("geoserver/wms"),
      "geoserver/wms?SERVICE=WMS&REQUEST=GetCapabilities",
    );
  });

  it("keeps the host of a protocol-relative endpoint", () => {
    const url = createWmsGetCapabilitiesUrl("//example.com/geoserver/wms");
    assert.ok(url.startsWith("//example.com/geoserver/wms?"));
    const params = new URLSearchParams(url.slice(url.indexOf("?")));
    assert.equal(params.get("SERVICE"), "WMS");
    assert.equal(params.get("REQUEST"), "GetCapabilities");
  });

  it("strips stale operation params on a relative endpoint too", () => {
    const url = createWmsGetCapabilitiesUrl(
      "/geoserver/wms?REQUEST=GetMap&LAYERS=a&token=abc",
    );
    // Relative form is preserved (no scheme/host injected).
    assert.ok(url.startsWith("/geoserver/wms?"));
    const params = new URLSearchParams(url.slice(url.indexOf("?")));
    assert.equal(params.get("REQUEST"), "GetCapabilities");
    assert.equal(params.get("LAYERS"), null);
    assert.equal(params.get("token"), "abc");
  });
});

describe("createWfsGetCapabilitiesUrl", () => {
  it("appends SERVICE, REQUEST, and the version when given", () => {
    const url = new URL(
      createWfsGetCapabilitiesUrl("https://x.test/wfs", "2.0.0"),
    );
    assert.equal(url.searchParams.get("SERVICE"), "WFS");
    assert.equal(url.searchParams.get("REQUEST"), "GetCapabilities");
    assert.equal(url.searchParams.get("VERSION"), "2.0.0");
  });

  it("strips leftover GetFeature operation params", () => {
    const url = new URL(
      createWfsGetCapabilitiesUrl(
        "https://x.test/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=a&token=abc",
      ),
    );
    assert.equal(url.searchParams.get("REQUEST"), "GetCapabilities");
    assert.equal(url.searchParams.get("typeName"), null);
    assert.equal(url.searchParams.get("token"), "abc");
  });

  it("omits VERSION when not provided", () => {
    const url = new URL(createWfsGetCapabilitiesUrl("https://x.test/wfs"));
    assert.equal(url.searchParams.get("VERSION"), null);
  });
});

describe("stripOgcOperationParams", () => {
  it("removes a pasted GetCapabilities query, leaving the base endpoint", () => {
    assert.equal(
      stripOgcOperationParams(
        "https://wms.ign.gob.ar/geoserver/ows?service=wfs&version=1.1.0&request=GetCapabilities",
        "WFS",
      ),
      "https://wms.ign.gob.ar/geoserver/ows",
    );
  });

  it("keeps non-operation params like an auth token", () => {
    assert.equal(
      stripOgcOperationParams(
        "https://x.test/wms?REQUEST=GetMap&LAYERS=a&token=abc",
        "WMS",
      ),
      "https://x.test/wms?token=abc",
    );
  });

  it("leaves an already-clean endpoint untouched", () => {
    assert.equal(
      stripOgcOperationParams("https://x.test/geoserver/wms", "WMS"),
      "https://x.test/geoserver/wms",
    );
  });
});

describe("number parsing helpers", () => {
  it("parses required numbers and rejects non-numeric input", () => {
    assert.equal(parseRequiredNumber("42", "value"), 42);
    assert.throws(() => parseRequiredNumber("abc", "value"), /numeric value/);
  });

  it("treats blank optional numbers as undefined", () => {
    assert.equal(parseOptionalNumber("   ", "max features"), undefined);
    assert.equal(parseOptionalNumber("10", "max features"), 10);
    assert.throws(() => parseOptionalNumber("x", "max features"));
  });
});

describe("parseVideoCorner", () => {
  it("parses a longitude, latitude pair", () => {
    assert.deepEqual(parseVideoCorner("-122.5, 37.5", "top-left"), [
      -122.5, 37.5,
    ]);
  });

  it("rejects malformed or out-of-range corners", () => {
    assert.throws(() => parseVideoCorner("1", "top-left"), /longitude, latitude/);
    assert.throws(() => parseVideoCorner("200, 0", "top-left"), /longitude/);
    assert.throws(() => parseVideoCorner("0, 100", "top-left"), /latitude/);
  });
});

describe("resolveDelimitedTextDelimiter", () => {
  it("maps known delimiters and passes custom ones through", () => {
    assert.equal(resolveDelimitedTextDelimiter("comma", ""), ",");
    assert.equal(resolveDelimitedTextDelimiter("tab", ""), "\t");
    assert.equal(resolveDelimitedTextDelimiter("custom", "~"), "~");
  });
});

describe("savedPostgresConnectionLabel", () => {
  it("masks the password in a URL connection string", () => {
    assert.equal(
      savedPostgresConnectionLabel("postgres://user:secret@host:5432/db"),
      "postgres://user:****@host:5432/db",
    );
  });

  it("masks the password in a keyword connection string", () => {
    assert.equal(
      savedPostgresConnectionLabel("host=localhost password=secret dbname=db"),
      "host=localhost password=**** dbname=db",
    );
  });

  it("masks single-quoted passwords that contain spaces", () => {
    assert.equal(
      savedPostgresConnectionLabel("host=a password='my secret' dbname=b"),
      "host=a password=**** dbname=b",
    );
  });

  it("masks every password occurrence, not just the first", () => {
    assert.equal(
      savedPostgresConnectionLabel(
        "host=a password=one application_name=x password=two",
      ),
      "host=a password=**** application_name=x password=****",
    );
  });
});

describe("geoJsonToPointRows", () => {
  it("flattens point features to lng/lat rows with properties", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "A", height: 10 },
          geometry: { type: "Point", coordinates: [-122, 37] },
        },
        {
          type: "Feature",
          properties: null,
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    };
    assert.deepEqual(geoJsonToPointRows(fc), [
      { name: "A", height: 10, lng: -122, lat: 37 },
      { lng: 1, lat: 2 },
    ]);
  });

  it("uses the first coordinate of nested geometries and skips empty ones", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [5, 6],
              [7, 8],
            ],
          },
        },
        {
          type: "Feature",
          properties: {},
          geometry: { type: "GeometryCollection", geometries: [] } as never,
        },
      ],
    };
    assert.deepEqual(geoJsonToPointRows(fc), [{ lng: 5, lat: 6 }]);
  });

  it("returns an empty array when there is no collection", () => {
    assert.deepEqual(geoJsonToPointRows(undefined), []);
  });

  it("lets geometry coordinates win over lng/lat properties of the same name", () => {
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          // Properties carry their own lng/lat that must NOT shadow the
          // geometry-derived placement coordinates.
          properties: { lng: 999, lat: -999, name: "Z" },
          geometry: { type: "Point", coordinates: [-122, 37] },
        },
      ],
    };
    assert.deepEqual(geoJsonToPointRows(fc), [
      { name: "Z", lng: -122, lat: 37 },
    ]);
  });
});

describe("attributionForTileUrl", () => {
  it("credits EOX Sentinel-2 cloudless tiles, including subdomain variants", () => {
    assert.equal(
      attributionForTileUrl(
        "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
      ),
      EOX_S2CLOUDLESS_ATTRIBUTION,
    );
    assert.equal(
      attributionForTileUrl(
        "https://s2maps-tiles.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
      ),
      EOX_S2CLOUDLESS_ATTRIBUTION,
    );
  });

  it("returns undefined for other hosts, lookalikes, and malformed URLs", () => {
    assert.equal(
      attributionForTileUrl("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
      undefined,
    );
    // A non-s2cloudless EOX layer has no known CC BY credit to attach.
    assert.equal(
      attributionForTileUrl("https://tiles.maps.eox.at/wmts/1.0.0/terrain/{z}/{y}/{x}.jpg"),
      undefined,
    );
    // Lookalike host must not match the `.eox.at` suffix check.
    assert.equal(
      attributionForTileUrl("https://evil-eox.at/s2cloudless/{z}/{y}/{x}.jpg"),
      undefined,
    );
    assert.equal(attributionForTileUrl("not a url"), undefined);
  });
});

describe("serviceRequestErrorMessage", () => {
  it("maps a network/TLS/CORS failure to the localized network message", () => {
    assert.equal(
      serviceRequestErrorMessage(new TypeError("Failed to fetch"), fakeT, "fallback"),
      "addData.common.networkFailure",
    );
  });

  it("maps a native TLS error string to the localized network message", () => {
    assert.equal(
      serviceRequestErrorMessage(
        "Request failed: invalid peer certificate",
        fakeT,
        "fallback",
      ),
      "addData.common.networkFailure",
    );
  });

  it("maps a timeout to the localized timeout message", () => {
    assert.equal(
      serviceRequestErrorMessage(new Error("The request timed out."), fakeT, "fallback"),
      "addData.common.requestTimedOut",
    );
  });

  it("falls through to the error's own message for an unclassified failure", () => {
    assert.equal(
      serviceRequestErrorMessage(
        new Error("The WFS service returned an error."),
        fakeT,
        "fallback",
      ),
      "The WFS service returned an error.",
    );
  });

  it("uses the fallback when an unclassified error carries no message", () => {
    assert.equal(serviceRequestErrorMessage({}, fakeT, "fallback"), "fallback");
  });
});
