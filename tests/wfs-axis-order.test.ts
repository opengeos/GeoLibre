import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { FeatureCollection, Point, Polygon } from "geojson";
import { DOMParser } from "linkedom";
import { fetchWfsGeoJson } from "../apps/geolibre-desktop/src/lib/layer-refresh";
import {
  arcGisAxisCheckRequest,
  coordinateExtent,
  shouldSwapAxes,
  swapAxes,
  wgs84BoundingBox,
} from "../apps/geolibre-desktop/src/lib/wfs-axis-order";

globalThis.DOMParser = DOMParser as unknown as typeof globalThis.DOMParser;

const ARCGIS =
  "https://sampleserver6.arcgisonline.com/arcgis/services/SampleWorldCities/MapServer/WFSServer";

// Trimmed from the real ArcGIS sample server's WFS 2.0.0 capabilities.
const CAPABILITIES = `<?xml version="1.0"?>
<wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ows="http://www.opengis.net/ows/1.1">
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>esri:Cities</wfs:Name>
      <ows:WGS84BoundingBox><ows:LowerCorner>-176.15 -54.79</ows:LowerCorner><ows:UpperCorner>179.22 78.2</ows:UpperCorner></ows:WGS84BoundingBox>
    </wfs:FeatureType>
    <wfs:FeatureType>
      <wfs:Name>esri:Parcels</wfs:Name>
      <ows:WGS84BoundingBox><ows:LowerCorner>9.9 53.4</ows:LowerCorner><ows:UpperCorner>10.3 53.7</ows:UpperCorner></ows:WGS84BoundingBox>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;

function points(...coordinates: number[][]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: coordinates.map((position) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: position },
    })),
  };
}

describe("arcGisAxisCheckRequest", () => {
  it("checks an ArcGIS WFS 2.0 request in EPSG:4326, keeping a token", () => {
    const request = arcGisAxisCheckRequest(
      `${ARCGIS}?service=WFS&request=GetFeature&version=2.0.0&typeNames=esri:cities&outputFormat=GEOJSON&srsName=EPSG:4326&count=5&token=abc`,
    );
    assert.equal(request?.typeName, "esri:cities");
    const caps = new URL(request!.capabilitiesUrl);
    assert.equal(caps.searchParams.get("REQUEST"), "GetCapabilities");
    assert.equal(caps.searchParams.get("VERSION"), "2.0.0");
    assert.equal(caps.searchParams.get("token"), "abc");
    assert.equal(caps.searchParams.get("typeNames"), null);
  });

  it("skips other servers, WFS 1.0.0 and projected CRSs", () => {
    const query = "?service=WFS&request=GetFeature&typeNames=a&srsName=EPSG:4326";
    assert.equal(
      arcGisAxisCheckRequest(`https://gs.example/geoserver/wfs${query}&version=2.0.0`),
      null,
    );
    assert.equal(arcGisAxisCheckRequest(`${ARCGIS}${query}&version=1.0.0`), null);
    assert.equal(
      arcGisAxisCheckRequest(
        `${ARCGIS}?service=WFS&request=GetFeature&version=2.0.0&typeNames=a&srsName=EPSG:3857`,
      ),
      null,
    );
  });
});

describe("shouldSwapAxes", () => {
  it("decides from coordinates valid only one way round", () => {
    assert.equal(shouldSwapAxes([-15.6, -56.1, 35.7, 139.7], null), true);
    assert.equal(shouldSwapAxes([-56.1, -15.6, 139.7, 35.7], null), false);
  });

  it("uses the WGS84 box when both orders are valid", () => {
    const hamburg: [number, number, number, number] = [9.9, 53.4, 10.3, 53.7];
    assert.equal(shouldSwapAxes([53.5, 9.95, 53.6, 10.1], hamburg), true);
    assert.equal(shouldSwapAxes([9.95, 53.5, 10.1, 53.6], hamburg), false);
    // Without a box an ambiguous extent is left as GeoJSON says: lon/lat.
    assert.equal(shouldSwapAxes([53.5, 9.95, 53.6, 10.1], null), false);
  });
});

describe("wgs84BoundingBox and swapAxes", () => {
  it("finds a type case-insensitively and swaps nested positions in place", () => {
    assert.deepEqual(
      wgs84BoundingBox(CAPABILITIES, "esri:cities"),
      [-176.15, -54.79, 179.22, 78.2],
    );
    assert.deepEqual(wgs84BoundingBox(CAPABILITIES, "Parcels"), [9.9, 53.4, 10.3, 53.7]);
    assert.equal(wgs84BoundingBox(CAPABILITIES, "esri:Missing"), null);

    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [1, 2, 5],
                [3, 4, 5],
                [1, 2, 5],
              ],
            ],
          },
        },
      ],
    };
    swapAxes(collection);
    assert.deepEqual((collection.features[0].geometry as Polygon).coordinates[0][1], [4, 3, 5]);
    assert.deepEqual(coordinateExtent(collection), [2, 1, 4, 3]);
  });
});

describe("fetchWfsGeoJson on an ArcGIS WFSServer", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const params = {
    endpoint: ARCGIS,
    typeName: "esri:cities",
    version: "2.0.0",
    outputFormat: "GEOJSON",
    srsName: "EPSG:4326",
  };

  it("swaps world-wide lat/lon GeoJSON without fetching capabilities", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      // Cuiabá and Tokyo, lat/lon as ArcGIS writes them.
      return new Response(JSON.stringify(points([-15.6, -56.1], [35.7, 139.7])));
    }) as typeof fetch;

    const { data } = await fetchWfsGeoJson(params, { useWfsProxy: true });
    assert.deepEqual((data.features[1].geometry as Point).coordinates, [139.7, 35.7]);
    assert.equal(requests.length, 1);
  });

  it("uses the capabilities box when the data is valid both ways", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (/GetCapabilities/i.test(url)) return new Response(CAPABILITIES);
      return new Response(JSON.stringify(points([53.55, 9.99], [53.6, 10.1])));
    }) as typeof fetch;

    const { data } = await fetchWfsGeoJson(
      {
        ...params,
        endpoint: `${ARCGIS.replace("SampleWorldCities", "Hamburg")}`,
        typeName: "esri:Parcels",
      },
      { useWfsProxy: true },
    );
    assert.deepEqual((data.features[0].geometry as Point).coordinates, [9.99, 53.55]);
    assert.equal(requests.filter((url) => /GetCapabilities/i.test(url)).length, 1);
  });

  it("leaves lon/lat GeoJSON from an ArcGIS server configured that way", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      /GetCapabilities/i.test(String(input))
        ? new Response(CAPABILITIES)
        : new Response(JSON.stringify(points([9.99, 53.55])))) as typeof fetch;

    const { data } = await fetchWfsGeoJson(
      {
        ...params,
        endpoint: `${ARCGIS.replace("SampleWorldCities", "HamburgLonLat")}`,
        typeName: "esri:Parcels",
      },
      { useWfsProxy: true },
    );
    assert.deepEqual((data.features[0].geometry as Point).coordinates, [9.99, 53.55]);
  });
});
