import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildForwardGeocodeUrl,
  buildReverseGeocodeUrl,
  CARTOCIUDAD_MIN_INTERVAL_MS,
  CARTOCIUDAD_PUBLIC_HOST,
  csvRowsToGeocodeRequests,
  geocodeMatchToFeature,
  geocodeForward,
  geocoderMinIntervalMs,
  geocoderNeedsApiKey,
  geocodeReverse,
  GEOCODING_PROVIDERS,
  getGeocodingProvider,
  nextDelayMs,
  setGeocodingFetch,
  nominatimResultToFeature,
  nominatimReverseResultToDisplay,
  normalizeGeocodingProviderId,
  NOMINATIM_MIN_INTERVAL_MS,
  PUBLIC_GEOCODE_ROW_CAP,
  resolveGeocoderConfig,
  rowCap,
  shouldThrottle,
  unmatchedGeocodeFeature,
  type GeocoderConfig,
  type NominatimForwardResult,
} from "@geolibre/core";

const PUBLIC_FORWARD = "https://nominatim.openstreetmap.org/search";
const PUBLIC_REVERSE = "https://nominatim.openstreetmap.org/reverse";
const SELF_HOSTED = "https://geocoder.example.org/search";

describe("buildForwardGeocodeUrl", () => {
  it("encodes the query and sets jsonv2 defaults", () => {
    const url = new URL(buildForwardGeocodeUrl(PUBLIC_FORWARD, "1600 Pennsylvania Ave, DC"));
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
    assert.equal(feature.properties?.geocode_display_name, "White House, Washington, DC");
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
    assert.equal(nominatimResultToFeature({ lat: "nope", lon: "x" }), null);
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
    assert.equal(nominatimReverseResultToDisplay({ error: "Unable to geocode" }), null);
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

describe("geocoderMinIntervalMs", () => {
  const CARTOCIUDAD = "https://www.cartociudad.es/geocoder/api/geocoder/find";

  it("paces by hostname: only the public Nominatim host", () => {
    assert.equal(geocoderMinIntervalMs(PUBLIC_FORWARD), NOMINATIM_MIN_INTERVAL_MS);
    assert.equal(geocoderMinIntervalMs(SELF_HOSTED), 0);
    assert.equal(geocoderMinIntervalMs("https://api.mapbox.com/x"), 0);
  });

  it("paces the public CartoCiudad host gently, without Nominatim's row cap", () => {
    assert.equal(geocoderMinIntervalMs(CARTOCIUDAD), CARTOCIUDAD_MIN_INTERVAL_MS);
    assert.equal(
      geocoderMinIntervalMs(`https://${CARTOCIUDAD_PUBLIC_HOST}/x`),
      CARTOCIUDAD_MIN_INTERVAL_MS,
    );
    assert.ok(CARTOCIUDAD_MIN_INTERVAL_MS < NOMINATIM_MIN_INTERVAL_MS);
    // Paced, but not subject to Nominatim's published policy gate.
    assert.equal(shouldThrottle(CARTOCIUDAD), false);
    assert.equal(rowCap(CARTOCIUDAD), Number.POSITIVE_INFINITY);
  });

  it("paces any provider pointed at the public Nominatim host (matches rowCap)", () => {
    // A non-Nominatim provider aimed at the public host must still be paced.
    assert.equal(geocoderMinIntervalMs(PUBLIC_FORWARD), NOMINATIM_MIN_INTERVAL_MS);
    assert.equal(rowCap(PUBLIC_FORWARD), PUBLIC_GEOCODE_ROW_CAP);
  });
});

describe("geocoderNeedsApiKey", () => {
  it("requires a key for the keyed providers", () => {
    for (const providerId of ["arcgis", "mapbox", "google"] as const) {
      assert.equal(geocoderNeedsApiKey(resolveGeocoderConfig({ providerId, apiKeys: {} })), true);
    }
  });

  it("requires a key for hosted Pelias but not a self-hosted endpoint", () => {
    assert.equal(
      geocoderNeedsApiKey(resolveGeocoderConfig({ providerId: "pelias", apiKeys: {} })),
      true,
    );
    assert.equal(
      geocoderNeedsApiKey(
        resolveGeocoderConfig({
          providerId: "pelias",
          apiKeys: {},
          forwardEndpoint: "https://pelias.internal.example.org/v1/search",
        }),
      ),
      false,
    );
  });

  it("never requires a key for Nominatim", () => {
    assert.equal(
      geocoderNeedsApiKey(resolveGeocoderConfig({ providerId: "nominatim", apiKeys: {} })),
      false,
    );
  });
});

describe("provider registry", () => {
  it("exposes Nominatim first as the default", () => {
    assert.equal(GEOCODING_PROVIDERS[0].id, "nominatim");
  });

  it("includes the proposed alternatives", () => {
    const ids = GEOCODING_PROVIDERS.map((p) => p.id).sort();
    assert.deepEqual(ids, ["arcgis", "cartociudad", "google", "mapbox", "nominatim", "pelias"]);
  });

  it("normalizes unknown provider ids to Nominatim", () => {
    assert.equal(normalizeGeocodingProviderId("bogus"), "nominatim");
    assert.equal(normalizeGeocodingProviderId(undefined), "nominatim");
    assert.equal(normalizeGeocodingProviderId("mapbox"), "mapbox");
  });

  it("getGeocodingProvider falls back to Nominatim for unknown ids", () => {
    assert.equal(getGeocodingProvider("bogus").id, "nominatim");
  });
});

describe("resolveGeocoderConfig", () => {
  it("uses the provider's default endpoints and its API key", () => {
    const config = resolveGeocoderConfig({
      providerId: "mapbox",
      apiKeys: { mapbox: "pk.test", google: "g" },
    });
    assert.equal(config.providerId, "mapbox");
    assert.equal(config.apiKey, "pk.test");
    assert.equal(config.forwardEndpoint, "https://api.mapbox.com/geocoding/v5/mapbox.places");
  });

  it("lets a custom endpoint override the default", () => {
    const config = resolveGeocoderConfig({
      providerId: "nominatim",
      apiKeys: {},
      forwardEndpoint: "https://geocoder.example.org/search",
    });
    assert.equal(config.forwardEndpoint, "https://geocoder.example.org/search");
  });

  it("defaults to Nominatim with no API key", () => {
    const config = resolveGeocoderConfig({ apiKeys: {} });
    assert.equal(config.providerId, "nominatim");
    assert.equal(config.apiKey, undefined);
  });
});

function configFor(providerId: GeocoderConfig["providerId"], apiKey?: string): GeocoderConfig {
  const provider = getGeocodingProvider(providerId);
  return {
    providerId,
    forwardEndpoint: provider.defaultForwardEndpoint,
    reverseEndpoint: provider.defaultReverseEndpoint,
    apiKey,
  };
}

describe("ArcGIS provider", () => {
  const provider = getGeocodingProvider("arcgis");
  const config = configFor("arcgis", "tok");

  it("builds a SingleLine forward URL with a token", () => {
    const url = new URL(provider.buildForwardUrl(config, "Paris", { limit: 2 }));
    assert.equal(url.searchParams.get("SingleLine"), "Paris");
    assert.equal(url.searchParams.get("f"), "json");
    assert.equal(url.searchParams.get("maxLocations"), "2");
    assert.equal(url.searchParams.get("token"), "tok");
  });

  it("parses candidates into matches", () => {
    const matches = provider.parseForward({
      candidates: [
        { address: "Paris, France", location: { x: 2.35, y: 48.85 }, score: 99 },
        { address: "bad", location: { x: "nan", y: 1 } },
      ],
    });
    assert.equal(matches.length, 1);
    assert.deepEqual(
      [matches[0].lon, matches[0].lat, matches[0].displayName, matches[0].score],
      [2.35, 48.85, "Paris, France", 99],
    );
  });

  it("parses a reverse address from LongLabel and stringifies numeric parts", () => {
    assert.deepEqual(
      provider.parseReverse({
        address: { LongLabel: "1 Infinite Loop", Score: 100 },
      }),
      {
        displayName: "1 Infinite Loop",
        parts: { LongLabel: "1 Infinite Loop", Score: "100" },
      },
    );
    assert.equal(provider.parseReverse({}), null);
  });
});

describe("Mapbox provider", () => {
  const provider = getGeocodingProvider("mapbox");
  const config = configFor("mapbox", "pk.tok");

  it("builds a path-style forward URL with the access token", () => {
    const url = new URL(provider.buildForwardUrl(config, "San Francisco, CA", { limit: 1 }));
    assert.ok(url.pathname.endsWith("/San%20Francisco%2C%20CA.json"));
    assert.equal(url.searchParams.get("access_token"), "pk.tok");
    assert.equal(url.searchParams.get("limit"), "1");
  });

  it("parses features using center coordinates and relevance", () => {
    const matches = provider.parseForward({
      features: [{ place_name: "San Francisco", center: [-122.42, 37.77], relevance: 0.9 }],
    });
    assert.deepEqual(
      [matches[0].lon, matches[0].lat, matches[0].displayName, matches[0].score],
      [-122.42, 37.77, "San Francisco", 0.9],
    );
  });

  it("builds a lon,lat reverse URL", () => {
    const url = new URL(provider.buildReverseUrl(config, -122.42, 37.77, {}));
    assert.ok(url.pathname.endsWith("/-122.42,37.77.json"));
    assert.equal(url.searchParams.get("access_token"), "pk.tok");
  });
});

describe("Google provider", () => {
  const provider = getGeocodingProvider("google");
  const config = configFor("google", "key");

  it("builds a forward URL with address and key", () => {
    const url = new URL(provider.buildForwardUrl(config, "Berlin", {}));
    assert.equal(url.searchParams.get("address"), "Berlin");
    assert.equal(url.searchParams.get("key"), "key");
  });

  it("builds a reverse URL with latlng ordered lat,lng", () => {
    const url = new URL(provider.buildReverseUrl(config, 13.4, 52.52, {}));
    assert.equal(url.searchParams.get("latlng"), "52.52,13.4");
  });

  it("parses results from geometry.location and formatted_address", () => {
    const matches = provider.parseForward({
      status: "OK",
      results: [
        {
          formatted_address: "Berlin, Germany",
          geometry: { location: { lat: 52.52, lng: 13.4 } },
        },
      ],
    });
    assert.deepEqual(
      [matches[0].lon, matches[0].lat, matches[0].displayName, matches[0].score],
      [13.4, 52.52, "Berlin, Germany", null],
    );
    assert.deepEqual(
      provider.parseReverse({
        results: [{ formatted_address: "Berlin, Germany" }],
      }),
      { displayName: "Berlin, Germany", parts: {} },
    );
  });

  it("throws on an error status returned with HTTP 200, but not ZERO_RESULTS", () => {
    assert.throws(
      () =>
        provider.parseForward({
          status: "REQUEST_DENIED",
          error_message: "The provided API key is invalid.",
        }),
      /REQUEST_DENIED/,
    );
    assert.deepEqual(provider.parseForward({ status: "ZERO_RESULTS", results: [] }), []);
  });
});

describe("provider key requirements", () => {
  it("flags keyed providers as requiring a key", () => {
    for (const id of ["arcgis", "mapbox", "google"] as const) {
      const provider = getGeocodingProvider(id);
      assert.equal(provider.requiresApiKey, true);
      assert.equal(provider.acceptsApiKey, true);
    }
  });

  it("treats Pelias as optionally keyed and Nominatim as keyless", () => {
    const pelias = getGeocodingProvider("pelias");
    assert.equal(pelias.requiresApiKey, false);
    assert.equal(pelias.acceptsApiKey, true);
    const nominatim = getGeocodingProvider("nominatim");
    assert.equal(nominatim.requiresApiKey, false);
    assert.equal(nominatim.acceptsApiKey, false);
  });
});

describe("Pelias provider", () => {
  const provider = getGeocodingProvider("pelias");
  const config = configFor("pelias", "pel-key");

  it("builds a text forward URL with size and api_key", () => {
    const url = new URL(provider.buildForwardUrl(config, "Oslo", { limit: 3 }));
    assert.equal(url.searchParams.get("text"), "Oslo");
    assert.equal(url.searchParams.get("size"), "3");
    assert.equal(url.searchParams.get("api_key"), "pel-key");
  });

  it("parses a GeoJSON FeatureCollection into matches", () => {
    const matches = provider.parseForward({
      features: [
        {
          geometry: { type: "Point", coordinates: [10.74, 59.91] },
          properties: { label: "Oslo, Norway", confidence: 0.95 },
        },
      ],
    });
    assert.deepEqual(
      [matches[0].lon, matches[0].lat, matches[0].displayName, matches[0].score],
      [10.74, 59.91, "Oslo, Norway", 0.95],
    );
  });
});

describe("geocodeMatchToFeature", () => {
  it("builds a [lon, lat] point carrying the original row", () => {
    const feature = geocodeMatchToFeature(
      { lat: 48.85, lon: 2.35, displayName: "Paris", score: 0.9 },
      { id: "1" },
    );
    assert.ok(feature);
    assert.deepEqual(feature.geometry.coordinates, [2.35, 48.85]);
    assert.equal(feature.properties?.id, "1");
    assert.equal(feature.properties?.geocode_display_name, "Paris");
    assert.equal(feature.properties?.geocode_importance, 0.9);
  });

  it("returns null for non-finite coordinates", () => {
    assert.equal(geocodeMatchToFeature({ lat: NaN, lon: 0, displayName: "", score: null }), null);
  });

  it("stamps provider and matched status only when extra.providerId is passed", () => {
    const withoutExtra = geocodeMatchToFeature(
      { lat: 48.85, lon: 2.35, displayName: "Paris", score: 0.9 },
      { id: "1" },
    );
    assert.ok(withoutExtra);
    assert.equal(withoutExtra.properties?.geocode_provider, undefined);
    assert.equal(withoutExtra.properties?.geocode_status, undefined);

    const withExtra = geocodeMatchToFeature(
      { lat: 48.85, lon: 2.35, displayName: "Paris", score: 0.9 },
      { id: "1" },
      { providerId: "nominatim" },
    );
    assert.ok(withExtra);
    assert.equal(withExtra.properties?.geocode_provider, "nominatim");
    assert.equal(withExtra.properties?.geocode_status, "matched");
  });
});

describe("unmatchedGeocodeFeature", () => {
  it("builds a null-geometry feature flagged unmatched, keeping the original row", () => {
    const feature = unmatchedGeocodeFeature({ id: "2", address: "nowhere" }, "nominatim");
    assert.equal(feature.geometry, null);
    assert.equal(feature.properties?.id, "2");
    assert.equal(feature.properties?.address, "nowhere");
    assert.equal(feature.properties?.geocode_status, "unmatched");
    assert.equal(feature.properties?.geocode_provider, "nominatim");
  });

  it("de-duplicates against an existing geocode_status column instead of clobbering it", () => {
    const feature = unmatchedGeocodeFeature({ geocode_status: "original value" }, "mapbox");
    assert.equal(feature.properties?.geocode_status, "original value");
    assert.equal(feature.properties?.geocode_status_2, "unmatched");
  });
});

describe("setGeocodingFetch", () => {
  const NOMINATIM: GeocoderConfig = {
    providerId: "nominatim",
    forwardEndpoint: PUBLIC_FORWARD,
    reverseEndpoint: PUBLIC_REVERSE,
  };

  it("routes forward geocoding through the injected fetch", async () => {
    const seen: string[] = [];
    const fake: typeof globalThis.fetch = (input) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify([{ lat: "48.85", lon: "2.35", display_name: "Paris" }]), {
          status: 200,
        }),
      );
    };
    setGeocodingFetch(fake);
    try {
      const matches = await geocodeForward("Paris", { config: NOMINATIM });
      assert.equal(matches.length, 1);
      assert.equal(matches[0]?.displayName, "Paris");
      assert.equal(seen.length, 1);
      assert.ok(seen[0]?.startsWith(PUBLIC_FORWARD));
    } finally {
      setGeocodingFetch(null);
    }
  });

  it("routes reverse geocoding through the injected fetch", async () => {
    const seen: string[] = [];
    const fake: typeof globalThis.fetch = (input) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ display_name: "Paris, France", address: {} }), {
          status: 200,
        }),
      );
    };
    setGeocodingFetch(fake);
    try {
      const result = await geocodeReverse(2.35, 48.85, { config: NOMINATIM });
      assert.equal(result?.displayName, "Paris, France");
      assert.equal(seen.length, 1);
      assert.ok(seen[0]?.startsWith(PUBLIC_REVERSE));
    } finally {
      setGeocodingFetch(null);
    }
  });

  it("propagates a non-ok response from the injected fetch as an error", async () => {
    setGeocodingFetch(() => Promise.resolve(new Response("nope", { status: 429 })));
    try {
      await assert.rejects(() => geocodeForward("Paris", { config: NOMINATIM }), /HTTP 429/);
    } finally {
      setGeocodingFetch(null);
    }
  });

  it("treats an HTTP 204 or empty body as no results rather than a parse error", async () => {
    // CartoCiudad answers an unmatched query this way; `response.json()` on an
    // empty body would throw and surface as "Search failed" instead of no match.
    setGeocodingFetch(() => Promise.resolve(new Response(null, { status: 204 })));
    try {
      assert.deepEqual(await geocodeForward("zzzqqq", { config: NOMINATIM }), []);
      assert.equal(await geocodeReverse(2.35, 48.85, { config: NOMINATIM }), null);
    } finally {
      setGeocodingFetch(null);
    }
    setGeocodingFetch(() => Promise.resolve(new Response("   ", { status: 200 })));
    try {
      assert.deepEqual(await geocodeForward("zzzqqq", { config: NOMINATIM }), []);
      assert.equal(await geocodeReverse(2.35, 48.85, { config: NOMINATIM }), null);
    } finally {
      setGeocodingFetch(null);
    }
  });

  it("wraps an unwrapped longitude from a repeated world copy into range", async () => {
    // MapLibre reports lngLat.lng unwrapped for clicks on non-primary world
    // copies, so 210 must reach the provider as -150, not be dropped.
    const seen: string[] = [];
    setGeocodingFetch((input) => {
      seen.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ display_name: "Somewhere", address: {} }), { status: 200 }),
      );
    });
    try {
      const result = await geocodeReverse(210, 48.85, { config: NOMINATIM });
      assert.equal(result?.displayName, "Somewhere");
      assert.equal(new URL(seen[0]!).searchParams.get("lon"), "-150");
      // An in-range longitude is passed through untouched — the modulo
      // round-trip would otherwise return -3.7 as -3.7000000000000455.
      await geocodeReverse(-3.7, 40.4, { config: NOMINATIM });
      assert.equal(new URL(seen[1]!).searchParams.get("lon"), "-3.7");
    } finally {
      setGeocodingFetch(null);
    }
  });
});

// --- CartoCiudad provider tests -------------------------------------------

describe("CartoCiudad provider", () => {
  const provider = getGeocodingProvider("cartociudad");

  it("is registered with correct metadata", () => {
    assert.equal(provider.id, "cartociudad");
    assert.equal(provider.label, "CartoCiudad (IGN España)");
    assert.equal(provider.forward, true);
    assert.equal(provider.reverse, true);
    assert.equal(provider.requiresApiKey, false);
    assert.equal(provider.acceptsApiKey, false);
  });

  it("builds a forward URL with q param", () => {
    const config = configFor("cartociudad");
    const url = new URL(provider.buildForwardUrl(config, "Calle Mayor 1, Madrid", {}));
    assert.equal(url.searchParams.get("q"), "Calle Mayor 1, Madrid");
    assert.ok(url.hostname.includes("cartociudad"));
    assert.ok(url.pathname.includes("find"));
  });

  it("parses a forward result object into a single match", () => {
    const matches = provider.parseForward({
      lat: 40.416461059323886,
      lng: -3.7046584169537073,
      address: "MAYOR",
      tip_via: "CALLE",
      portalNumber: 1,
      postalCode: "28013",
      poblacion: "Madrid",
      muni: "Madrid",
      province: "Madrid",
      type: "portal",
      refCatastral: "0343302VK4704C",
      state: 0,
    });
    assert.equal(matches.length, 1);
    const m = matches[0];
    assert.deepEqual([m.lat, m.lon], [40.416461059323886, -3.7046584169537073]);
    assert.ok(m.displayName.includes("MAYOR"));
    assert.ok(m.displayName.includes("Madrid"));
    assert.equal(m.score, null);
  });

  it("returns empty array for null/undefined forward data", () => {
    assert.deepEqual(provider.parseForward(null), []);
    assert.deepEqual(provider.parseForward(undefined), []);
  });

  it("returns empty array when lat/lng are missing, null, or blank", () => {
    assert.deepEqual(provider.parseForward({ address: "No coords" }), []);
    assert.deepEqual(provider.parseForward({ lat: null, lng: null, address: "Null coords" }), []);
    assert.deepEqual(provider.parseForward({ lat: "", lng: "", address: "Empty coords" }), []);
  });

  it("returns empty array for non-finite or out-of-range forward coordinates", () => {
    assert.deepEqual(provider.parseForward({ lat: NaN, lng: -3.7, address: "NaN lat" }), []);
    assert.deepEqual(provider.parseForward({ lat: 40.4, lng: Infinity, address: "Inf lng" }), []);
    assert.deepEqual(provider.parseForward({ lat: "NaN", lng: "invalid", address: "Junk" }), []);
    assert.deepEqual(provider.parseForward({ lat: 95, lng: -3.7, address: "Lat too high" }), []);
    assert.deepEqual(provider.parseForward({ lat: 40.4, lng: 200, address: "Lng too high" }), []);
  });

  it("returns empty array when the response is an array rather than an object", () => {
    // `find` answers with one object even for an ambiguous query; an array is a
    // shape we do not understand, not a candidate list to pick the first of.
    assert.deepEqual(provider.parseForward([{ lat: 40.4, lng: -3.7, address: "MAYOR" }]), []);
  });

  it("omits a blank portal number instead of appending a trailing space", () => {
    const matches = provider.parseForward({
      lat: 40.4,
      lng: -3.7,
      tip_via: "CALLE",
      address: "MAYOR",
      portalNumber: "",
      poblacion: "Madrid",
    });
    assert.equal(matches.length, 1);
    assert.ok(matches[0].displayName.startsWith("CALLE MAYOR,"));
  });

  it("falls back to muni for the locality when poblacion is absent", () => {
    // Shape taken from a live "A-6 km 120" response: a road kilometre point
    // carries muni but no poblacion, so the municipality must not be dropped.
    const matches = provider.parseForward({
      lat: 40.9,
      lng: -4.8,
      address: "A-6",
      postalCode: "05296",
      poblacion: null,
      muni: "Espinosa de los Caballeros",
      province: "Ávila",
      type: "portal",
    });
    assert.equal(matches.length, 1);
    assert.ok(matches[0].displayName.includes("05296 Espinosa de los Caballeros"));
  });

  it("prefers poblacion over muni when both are present", () => {
    const matches = provider.parseForward({
      lat: 42.05,
      lng: 1.74,
      address: "Cal Mayoral",
      poblacion: "Cal Mayoral",
      muni: "l'Espunyola",
      province: "Barcelona",
    });
    assert.equal(matches.length, 1);
    assert.ok(matches[0].displayName.includes("Cal Mayoral"));
    assert.ok(!matches[0].displayName.includes("Espunyola"));
  });

  it("builds a reverse URL with lat/lon params", () => {
    const config = configFor("cartociudad");
    const url = new URL(provider.buildReverseUrl(config, -3.7038, 40.4168, {}));
    assert.equal(url.searchParams.get("lat"), "40.4168");
    assert.equal(url.searchParams.get("lon"), "-3.7038");
    assert.ok(url.pathname.includes("reverseGeocode"));
  });

  it("parses a reverse result into display + structured parts", () => {
    const result = provider.parseReverse({
      lat: 40.41652681555059,
      lng: -3.7037876690807514,
      address: "PUERTA DEL SOL",
      tip_via: "PLAZA",
      portalNumber: 7,
      postalCode: "28012",
      poblacion: "Madrid",
      muni: "Madrid",
      province: "Madrid",
      type: "portal",
      refCatastral: "0444101VK4704C",
      state: 0,
    });
    assert.ok(result);
    assert.ok(result!.displayName.includes("PUERTA DEL SOL"));
    assert.equal(result!.parts.tip_via, "PLAZA");
    assert.equal(result!.parts.postalCode, "28012");
    assert.equal(result!.parts.refCatastral, "0444101VK4704C");
    assert.equal(result!.parts.province, "Madrid");
  });

  it("returns null for null/undefined reverse data", () => {
    assert.equal(provider.parseReverse(null), null);
    assert.equal(provider.parseReverse(undefined), null);
  });

  it("returns null for non-finite or out-of-range reverse coordinates", () => {
    assert.equal(provider.parseReverse({ address: "No coords" }), null);
    assert.equal(provider.parseReverse({ lat: null, lng: null, address: "Null" }), null);
    assert.equal(provider.parseReverse({ lat: "NaN", lng: "invalid", address: "Junk" }), null);
    assert.equal(provider.parseReverse({ lat: 95, lng: -3.7, address: "Lat too high" }), null);
    assert.equal(provider.parseReverse({ lat: 40.4, lng: -200, address: "Lng too low" }), null);
  });

  it("does not require an API key", () => {
    assert.equal(
      geocoderNeedsApiKey(resolveGeocoderConfig({ providerId: "cartociudad", apiKeys: {} })),
      false,
    );
  });

  it("rejects non-finite and out-of-bounds coordinates in geocodeReverse", async () => {
    // Longitude is wrapped rather than rejected (see the world-copy test above),
    // so only a non-finite longitude or an impossible latitude short-circuits.
    assert.equal(await geocodeReverse(NaN, 40.4), null);
    assert.equal(await geocodeReverse(-3.7, Infinity), null);
    assert.equal(await geocodeReverse(-3.7, -95), null);
    assert.equal(await geocodeReverse(-3.7, 95), null);
  });
});
