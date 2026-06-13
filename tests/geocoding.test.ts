import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildForwardGeocodeUrl,
  buildReverseGeocodeUrl,
  csvRowsToGeocodeRequests,
  nextDelayMs,
  nominatimResultToFeature,
  nominatimReverseResultToDisplay,
  NOMINATIM_MIN_INTERVAL_MS,
  PUBLIC_GEOCODE_ROW_CAP,
  rowCap,
  shouldThrottle,
  type NominatimForwardResult,
} from "@geolibre/core";

const PUBLIC_FORWARD = "https://nominatim.openstreetmap.org/search";
const PUBLIC_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const SELF_HOSTED = "https://geocoder.example.org/search";

describe("buildForwardGeocodeUrl", () => {
  it("encodes the query and sets jsonv2 defaults", () => {
    const url = new URL(
      buildForwardGeocodeUrl(PUBLIC_FORWARD, "1600 Pennsylvania Ave, DC"),
    );
    assert.equal(url.searchParams.get("q"), "1600 Pennsylvania Ave, DC");
    assert.equal(url.searchParams.get("format"), "jsonv2");
    assert.equal(url.searchParams.get("addressdetails"), "1");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("email"), null);
  });

  it("includes email and limit when provided and respects the endpoint", () => {
    const url = new URL(
      buildForwardGeocodeUrl(SELF_HOSTED, "Paris", {
        email: "me@example.org",
        limit: 5,
      }),
    );
    assert.equal(url.hostname, "geocoder.example.org");
    assert.equal(url.searchParams.get("email"), "me@example.org");
    assert.equal(url.searchParams.get("limit"), "5");
  });
});

describe("buildReverseGeocodeUrl", () => {
  it("places lat/lon in the right params", () => {
    const url = new URL(buildReverseGeocodeUrl(PUBLIC_REVERSE, -77.04, 38.89));
    assert.equal(url.searchParams.get("lat"), "38.89");
    assert.equal(url.searchParams.get("lon"), "-77.04");
    assert.equal(url.searchParams.get("format"), "jsonv2");
  });

  it("adds zoom and email when supplied", () => {
    const url = new URL(
      buildReverseGeocodeUrl(PUBLIC_REVERSE, 0, 0, {
        zoom: 14,
        email: "me@example.org",
      }),
    );
    assert.equal(url.searchParams.get("zoom"), "14");
    assert.equal(url.searchParams.get("email"), "me@example.org");
  });
});

describe("nominatimResultToFeature", () => {
  const result: NominatimForwardResult = {
    lat: "38.8977",
    lon: "-77.0365",
    display_name: "White House, Washington, DC",
    importance: "0.85",
  };

  it("builds a [lon, lat] point carrying original columns and geocode_* props", () => {
    const feature = nominatimResultToFeature(result, { city: "DC", id: "1" });
    assert.ok(feature);
    assert.deepEqual(feature.geometry.coordinates, [-77.0365, 38.8977]);
    assert.equal(feature.properties?.city, "DC");
    assert.equal(feature.properties?.id, "1");
    assert.equal(feature.properties?.geocode_lat, 38.8977);
    assert.equal(feature.properties?.geocode_lon, -77.0365);
    assert.equal(
      feature.properties?.geocode_display_name,
      "White House, Washington, DC",
    );
    // importance is coerced from string to number.
    assert.equal(feature.properties?.geocode_importance, 0.85);
  });

  it("does not clobber an existing geocode_lat column", () => {
    const feature = nominatimResultToFeature(result, { geocode_lat: "orig" });
    assert.ok(feature);
    assert.equal(feature.properties?.geocode_lat, "orig");
    assert.equal(feature.properties?.geocode_lat_2, 38.8977);
  });

  it("returns null when coordinates are not finite", () => {
    assert.equal(
      nominatimResultToFeature({ lat: "nope", lon: "x" }),
      null,
    );
  });

  it("coerces a missing importance to null", () => {
    const feature = nominatimResultToFeature({
      lat: "1",
      lon: "2",
    });
    assert.equal(feature?.properties?.geocode_importance, null);
  });
});

describe("nominatimReverseResultToDisplay", () => {
  it("returns the display name and address parts", () => {
    const display = nominatimReverseResultToDisplay({
      display_name: "10 Downing St, London",
      address: { road: "Downing Street", city: "London" },
    });
    assert.deepEqual(display, {
      displayName: "10 Downing St, London",
      parts: { road: "Downing Street", city: "London" },
    });
  });

  it("returns null on an error result, null input, or empty name", () => {
    assert.equal(
      nominatimReverseResultToDisplay({ error: "Unable to geocode" }),
      null,
    );
    assert.equal(nominatimReverseResultToDisplay(null), null);
    assert.equal(nominatimReverseResultToDisplay({ display_name: "  " }), null);
  });
});

describe("csvRowsToGeocodeRequests", () => {
  const rows = [
    { addr: "1 Main St", city: "Springfield" },
    { addr: "", city: "Nowhere" },
    { addr: "  ", city: "" },
    { addr: "2 Oak Ave", city: "Shelbyville" },
  ];

  it("builds one request per non-empty address, preserving the source row", () => {
    const requests = csvRowsToGeocodeRequests(rows, ["addr"]);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((r) => r.index),
      [0, 3],
    );
    assert.equal(requests[0].address, "1 Main St");
    assert.deepEqual(requests[0].row, rows[0]);
  });

  it("joins multiple address columns with ', ' and trims", () => {
    const requests = csvRowsToGeocodeRequests(rows, ["addr", "city"]);
    assert.equal(requests[0].address, "1 Main St, Springfield");
    // Row 1 has an empty addr but a city, so it is still geocodable.
    assert.equal(requests[1].address, "Nowhere");
  });
});

describe("nextDelayMs", () => {
  it("returns 0 for the first request", () => {
    assert.equal(nextDelayMs(null, 1000, NOMINATIM_MIN_INTERVAL_MS), 0);
  });

  it("returns the remaining wait measured from the last start", () => {
    assert.equal(nextDelayMs(1000, 1300, 1100), 800);
  });

  it("clamps to 0 once enough time has elapsed", () => {
    assert.equal(nextDelayMs(1000, 5000, 1100), 0);
  });
});

describe("shouldThrottle / rowCap", () => {
  it("throttles and caps the public Nominatim host", () => {
    assert.equal(shouldThrottle(PUBLIC_FORWARD), true);
    assert.equal(rowCap(PUBLIC_FORWARD), PUBLIC_GEOCODE_ROW_CAP);
  });

  it("does not throttle or cap a self-hosted endpoint", () => {
    assert.equal(shouldThrottle(SELF_HOSTED), false);
    assert.equal(rowCap(SELF_HOSTED), Number.POSITIVE_INFINITY);
  });

  it("throttles defensively when the endpoint does not parse", () => {
    assert.equal(shouldThrottle("not a url"), true);
  });
});
