import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googleEarthUrl, googleMapsUrl } from "../apps/geolibre-desktop/src/lib/external-map-links";

describe("googleMapsUrl", () => {
  it("builds a centered camera URL", () => {
    assert.equal(
      googleMapsUrl(40.7128, -74.006, 12),
      "https://www.google.com/maps/@40.712800,-74.006000,12z",
    );
  });

  it("adds a place query so a marker is dropped when requested", () => {
    assert.equal(
      googleMapsUrl(40.7128, -74.006, 12, { marker: true }),
      "https://www.google.com/maps/place/40.712800,-74.006000/@40.712800,-74.006000,12z",
    );
  });

  it("keeps fractional zoom to two decimals", () => {
    assert.equal(
      googleMapsUrl(0, 0, 12.34567),
      "https://www.google.com/maps/@0.000000,0.000000,12.35z",
    );
  });

  it("clamps zoom to the range Google Maps accepts", () => {
    assert.ok(googleMapsUrl(0, 0, -3).endsWith(",2z"));
    assert.ok(googleMapsUrl(0, 0, 25).endsWith(",21z"));
  });

  it("wraps longitudes past the antimeridian and clamps latitude", () => {
    assert.equal(googleMapsUrl(0, 190, 5), "https://www.google.com/maps/@0.000000,-170.000000,5z");
    assert.equal(
      googleMapsUrl(95, -540, 5),
      "https://www.google.com/maps/@90.000000,-180.000000,5z",
    );
  });

  it("never emits a negative zero longitude", () => {
    assert.equal(googleMapsUrl(0, 360, 5), "https://www.google.com/maps/@0.000000,0.000000,5z");
  });
});

describe("googleEarthUrl", () => {
  function distanceOf(url: string): number {
    const match = url.match(/,(\d+)d,/);
    assert.ok(match, `no camera distance in ${url}`);
    return Number(match[1]);
  }

  it("builds a top-down camera URL at the coordinate", () => {
    const url = googleEarthUrl(40.7128, -74.006, 12);
    assert.ok(url.startsWith("https://earth.google.com/web/@40.712800,-74.006000,0a,"), url);
    assert.ok(url.endsWith("d,35y,0h,0t,0r"), url);
  });

  it("halves the camera distance per zoom level", () => {
    const near = distanceOf(googleEarthUrl(0, 0, 11));
    const far = distanceOf(googleEarthUrl(0, 0, 10));
    assert.ok(Math.abs(far / near - 2) < 0.01, `${far} vs ${near}`);
  });

  it("shrinks the distance with cos(latitude) like mercator resolution", () => {
    const equator = distanceOf(googleEarthUrl(0, 0, 10));
    const sixty = distanceOf(googleEarthUrl(60, 0, 10));
    assert.ok(Math.abs(sixty / equator - 0.5) < 0.01, `${sixty} vs ${equator}`);
  });

  it("clamps the distance at extreme zooms and latitudes", () => {
    assert.equal(distanceOf(googleEarthUrl(89.9999, 0, 22)), 150);
    assert.equal(distanceOf(googleEarthUrl(0, 0, -5)), 65_000_000);
  });

  it("wraps longitude into [-180, 180]", () => {
    const url = googleEarthUrl(10, 200, 8);
    assert.ok(url.includes("@10.000000,-160.000000,"), url);
  });
});
