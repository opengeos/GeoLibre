import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type GeocodeMatch, getGeocodingProvider, normalizeGeocodeBbox } from "@geolibre/core";
import {
  geocodeResultCamera,
  MIN_RESULT_SPAN_DEG,
  POINT_RESULT_ZOOM,
} from "../apps/geolibre-desktop/src/lib/geocode-camera";

// Nevada's extent as Nominatim reports it (south, north, west, east).
const NEVADA_BOX = ["35.0018780", "42.0022148", "-120.0064729", "-114.0396479"];

describe("geocoder bounding boxes", () => {
  it("reads Nominatim's south/north/west/east boundingbox", () => {
    const [match] = getGeocodingProvider("nominatim").parseForward([
      {
        lat: "39.5158825",
        lon: "-116.8537227",
        display_name: "Nevada, United States",
        boundingbox: NEVADA_BOX,
      },
    ]);
    assert.deepEqual(match.bbox, [-120.0064729, 35.001878, -114.0396479, 42.0022148]);
  });

  it("leaves bbox off a Nominatim result without one or with a bad one", () => {
    const matches = getGeocodingProvider("nominatim").parseForward([
      { lat: "1", lon: "2", display_name: "a" },
      { lat: "1", lon: "2", display_name: "b", boundingbox: ["x", "1", "2", "3"] },
      { lat: "1", lon: "2", display_name: "c", boundingbox: ["5", "1", "2", "3"] },
    ]);
    assert.equal(matches.length, 3);
    for (const match of matches) assert.equal("bbox" in match, false);
  });

  it("reads a GeoJSON feature bbox from Pelias and Mapbox", () => {
    const feature = {
      type: "Feature",
      bbox: [-120.2, 38.9, -119.9, 39.25],
      geometry: { type: "Point", coordinates: [-120.04, 39.09] },
      properties: { label: "Lake Tahoe" },
      place_name: "Lake Tahoe",
      center: [-120.04, 39.09],
    };
    for (const id of ["pelias", "mapbox"]) {
      const [match] = getGeocodingProvider(id).parseForward({
        type: "FeatureCollection",
        features: [feature],
      });
      assert.deepEqual(match.bbox, [-120.2, 38.9, -119.9, 39.25], id);
    }
  });

  it("reads an ArcGIS candidate extent, unprojecting Web Mercator", () => {
    const provider = getGeocodingProvider("arcgis");
    const [geographic] = provider.parseForward({
      spatialReference: { wkid: 4326 },
      candidates: [
        {
          address: "Nevada",
          location: { x: -116.8, y: 39.5 },
          score: 100,
          extent: { xmin: -120, ymin: 35, xmax: -114, ymax: 42 },
        },
      ],
    });
    assert.deepEqual(geographic.bbox, [-120, 35, -114, 42]);

    const [mercator] = provider.parseForward({
      spatialReference: { wkid: 102100 },
      candidates: [
        {
          address: "Origin",
          location: { x: 0, y: 0 },
          score: 100,
          extent: { xmin: -111319.49, ymin: -111325.14, xmax: 111319.49, ymax: 111325.14 },
        },
      ],
    });
    assert.ok(mercator.bbox);
    const [w, s, e, n] = mercator.bbox;
    assert.ok(Math.abs(w + 1) < 1e-4 && Math.abs(e - 1) < 1e-4);
    assert.ok(Math.abs(s + 1) < 1e-4 && Math.abs(n - 1) < 1e-4);
  });

  it("reads Google's viewport", () => {
    const [match] = getGeocodingProvider("google").parseForward({
      status: "OK",
      results: [
        {
          formatted_address: "Nevada, USA",
          geometry: {
            location: { lat: 38.8, lng: -116.4 },
            viewport: {
              northeast: { lat: 42.0, lng: -114.04 },
              southwest: { lat: 35.0, lng: -120.0 },
            },
          },
        },
      ],
    });
    assert.deepEqual(match.bbox, [-120.0, 35.0, -114.04, 42.0]);
  });

  it("rejects malformed extents", () => {
    assert.equal(normalizeGeocodeBbox(null, 1, 2, 3), null);
    assert.equal(normalizeGeocodeBbox(0, 10, 1, 5), null); // south above north
    assert.equal(normalizeGeocodeBbox(-200, 0, 1, 1), null);
    assert.equal(normalizeGeocodeBbox(0, -91, 1, 1), null);
    // An antimeridian-crossing box is kept as west > east.
    assert.deepEqual(normalizeGeocodeBbox(170, -20, -170, -10), [170, -20, -170, -10]);
  });
});

describe("geocodeResultCamera", () => {
  const base: GeocodeMatch = { lat: 39.5, lon: -116.85, displayName: "Nevada", score: null };

  it("fits a large place to its box, even from a closer zoom", () => {
    const camera = geocodeResultCamera({ ...base, bbox: [-120, 35, -114, 42] }, 15);
    assert.deepEqual(camera, { kind: "bounds", bounds: [-120, 35, -114, 42] });
  });

  it("widens a tiny address box around its center to street level", () => {
    const camera = geocodeResultCamera(
      { ...base, lat: 40, lon: -75, bbox: [-75.0001, 39.9999, -74.9999, 40.0001] },
      3,
    );
    assert.equal(camera.kind, "bounds");
    if (camera.kind !== "bounds") return;
    const [w, s, e, n] = camera.bounds;
    assert.ok(Math.abs(n - s - MIN_RESULT_SPAN_DEG) < 1e-9);
    assert.ok(Math.abs((s + n) / 2 - 40) < 1e-9);
    assert.ok(Math.abs((w + e) / 2 + 75) < 1e-9);
    // Longitude is widened by the same ground distance, so more degrees at 40°N.
    const expectedLon = MIN_RESULT_SPAN_DEG / Math.cos((40 * Math.PI) / 180);
    assert.ok(Math.abs(e - w - expectedLon) < 1e-9);
  });

  it("widens a point-sized box", () => {
    const camera = geocodeResultCamera({ ...base, bbox: [10, 20, 10, 20] }, 3);
    assert.equal(camera.kind, "bounds");
    if (camera.kind !== "bounds") return;
    const [w, s, e, n] = camera.bounds;
    assert.ok(e > w && n > s);
  });

  it("clips a polar box to the Mercator limit", () => {
    const camera = geocodeResultCamera({ ...base, bbox: [-180, -90, 180, -60] }, 1);
    assert.equal(camera.kind, "bounds");
    if (camera.kind !== "bounds") return;
    assert.ok(camera.bounds[1] > -86 && camera.bounds[1] < -85);
    assert.equal(camera.bounds[3], -60);
  });

  it("falls back to a fixed zoom without a box, never zooming out", () => {
    assert.deepEqual(geocodeResultCamera(base, 4), {
      kind: "center",
      center: [-116.85, 39.5],
      zoom: POINT_RESULT_ZOOM,
    });
    assert.deepEqual(geocodeResultCamera(base, 16), {
      kind: "center",
      center: [-116.85, 39.5],
      zoom: 16,
    });
  });

  it("falls back to the point for an antimeridian-crossing box", () => {
    const camera = geocodeResultCamera({ ...base, bbox: [170, -20, -170, -10] }, 2);
    assert.equal(camera.kind, "center");
  });
});
