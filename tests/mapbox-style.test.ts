import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { getMapboxAccessToken } from "@geolibre/core";
import type * as maplibregl from "maplibre-gl";
import {
  isMapboxStyleUrl,
  mapboxAccessTokenFromStyleUrl,
  redactMapboxStyleUrl,
  resolveMapboxInternalUrl,
  transformMapboxStyle,
} from "../packages/map/src/mapbox-style";

/**
 * A Mapbox style descriptor in the shape `api.mapbox.com/styles/v1/mapbox/*`
 * actually serves: `mapbox://` sprite/glyphs/source URLs and Mapbox's
 * `projection: { name }` spelling. Both are what MapLibre chokes on.
 */
function mapboxDescriptor(): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: "Mapbox Streets",
    sprite: "mapbox://sprites/mapbox/streets-v12",
    glyphs: "mapbox://fonts/mapbox/{fontstack}/{range}.pbf",
    projection: { name: "globe" },
    sources: {
      composite: {
        type: "vector",
        url: "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2",
      },
      hosted: {
        type: "raster",
        tiles: ["https://example.com/{z}/{x}/{y}.png"],
      },
    },
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#fff" } }],
  } as unknown as maplibregl.StyleSpecification;
}

describe("isMapboxStyleUrl", () => {
  it("matches Mapbox style descriptor URLs", () => {
    assert.equal(
      isMapboxStyleUrl("https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=pk.abc"),
      true,
    );
    assert.equal(isMapboxStyleUrl("https://api.mapbox.com/styles/v1/someone/custom"), true);
  });

  it("rejects other basemap URLs and GeoLibre sentinels", () => {
    assert.equal(isMapboxStyleUrl(undefined), false);
    assert.equal(isMapboxStyleUrl(""), false);
    assert.equal(isMapboxStyleUrl("https://tiles.openfreemap.org/styles/liberty"), false);
    // Not a style descriptor, so it needs no rewrite (and must not be fetched).
    assert.equal(isMapboxStyleUrl("https://api.mapbox.com/v4/mapbox.satellite.json"), false);
    assert.equal(isMapboxStyleUrl("geolibre://planetary/moon"), false);
    // A look-alike host must not be treated as Mapbox.
    assert.equal(isMapboxStyleUrl("https://api.mapbox.com.evil.test/styles/v1/x"), false);
    assert.equal(isMapboxStyleUrl("not a url"), false);
  });
});

describe("mapboxAccessTokenFromStyleUrl", () => {
  it("reads the token the control embedded in the URL", () => {
    assert.equal(
      mapboxAccessTokenFromStyleUrl(
        "https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=pk.token",
      ),
      "pk.token",
    );
  });

  it("trims a token padded by the query string", () => {
    assert.equal(
      mapboxAccessTokenFromStyleUrl(
        "https://api.mapbox.com/styles/v1/mapbox/dark-v11?access_token=%20pk.token%20",
      ),
      "pk.token",
    );
  });

  it("returns an empty string when there is no token", () => {
    assert.equal(mapboxAccessTokenFromStyleUrl("https://api.mapbox.com/styles/v1/mapbox/x"), "");
    assert.equal(mapboxAccessTokenFromStyleUrl("nonsense"), "");
  });
});

describe("redactMapboxStyleUrl", () => {
  it("drops the query string so the access token never reaches a log", () => {
    const redacted = redactMapboxStyleUrl(
      "https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=pk.secret",
    );
    assert.equal(redacted, "https://api.mapbox.com/styles/v1/mapbox/streets-v12");
    assert.ok(!redacted.includes("pk.secret"));
  });

  it("never echoes an unparseable URL back", () => {
    assert.equal(redactMapboxStyleUrl("not a url?access_token=pk.secret"), "(unparseable URL)");
  });
});

describe("resolveMapboxInternalUrl", () => {
  it("rewrites sprite, font and tileset URLs to public HTTPS endpoints", () => {
    assert.equal(
      resolveMapboxInternalUrl("mapbox://sprites/mapbox/streets-v12", "tok"),
      "https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite?access_token=tok",
    );
    assert.equal(
      resolveMapboxInternalUrl("mapbox://fonts/mapbox/{fontstack}/{range}.pbf", "tok"),
      "https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=tok",
    );
    assert.equal(
      resolveMapboxInternalUrl("mapbox://mapbox.satellite", "tok"),
      "https://api.mapbox.com/v4/mapbox.satellite.json?secure&access_token=tok",
    );
    // Comma-joined tileset lists are a single v4 request.
    assert.equal(
      resolveMapboxInternalUrl("mapbox://mapbox.a,mapbox.b", "tok"),
      "https://api.mapbox.com/v4/mapbox.a,mapbox.b.json?secure&access_token=tok",
    );
  });

  it("leaves non-mapbox:// URLs untouched", () => {
    assert.equal(
      resolveMapboxInternalUrl("https://example.com/tiles.json", "tok"),
      "https://example.com/tiles.json",
    );
  });
});

describe("transformMapboxStyle", () => {
  it("produces a style MapLibre's validator accepts", () => {
    const raw = mapboxDescriptor();
    // Guard the premise: the untransformed descriptor is what MapLibre rejects,
    // and Style._load bails on the first validation error, blanking the map.
    assert.deepEqual(
      validateStyleMin(raw).map((error) => error.message),
      ['name: unknown property "name"'],
    );

    assert.deepEqual(validateStyleMin(transformMapboxStyle(raw, "pk.token")), []);
  });

  it("resolves every mapbox:// URL with the encoded token", () => {
    const style = transformMapboxStyle(mapboxDescriptor(), "pk a/b");
    const encoded = encodeURIComponent("pk a/b");

    assert.equal(
      style.sprite,
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite?access_token=${encoded}`,
    );
    assert.equal(
      style.glyphs,
      `https://api.mapbox.com/fonts/v1/mapbox/{fontstack}/{range}.pbf?access_token=${encoded}`,
    );
    const composite = style.sources.composite as { url: string };
    assert.equal(
      composite.url,
      `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure&access_token=${encoded}`,
    );
  });

  it("pins the projection to mercator and leaves tile-backed sources alone", () => {
    const style = transformMapboxStyle(mapboxDescriptor(), "tok");
    // MapController.enforceProjection re-applies the user's own preference right
    // after the style loads, so Mapbox's choice is deliberately not carried over.
    assert.deepEqual(style.projection, { type: "mercator" });
    assert.deepEqual(style.sources.hosted, {
      type: "raster",
      tiles: ["https://example.com/{z}/{x}/{y}.png"],
    });
  });

  it("does not mutate the fetched descriptor", () => {
    const raw = mapboxDescriptor();
    transformMapboxStyle(raw, "tok");
    assert.equal(raw.sprite, "mapbox://sprites/mapbox/streets-v12");
    assert.deepEqual(raw.projection, { name: "globe" } as unknown as typeof raw.projection);
    // Nested too: rewriting a source URL in place would leave the descriptor
    // unusable for a retry while still passing the top-level assertions above.
    assert.equal(
      (raw.sources.composite as { url: string }).url,
      "mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2",
    );
  });
});

describe("getMapboxAccessToken", () => {
  it("returns undefined when env is missing or blank", () => {
    assert.equal(getMapboxAccessToken({}), undefined);
    assert.equal(getMapboxAccessToken({ VITE_MAPBOX_ACCESS_TOKEN: "  " }), undefined);
    assert.equal(getMapboxAccessToken({ MAPBOX_TOKEN: "" }), undefined);
  });

  it("prefers the VITE_ name and falls back to the bare MAPBOX_TOKEN", () => {
    assert.equal(
      getMapboxAccessToken({ VITE_MAPBOX_ACCESS_TOKEN: "  pk.prefixed  " }),
      "pk.prefixed",
    );
    assert.equal(getMapboxAccessToken({ MAPBOX_TOKEN: "  pk.bare  " }), "pk.bare");
    assert.equal(
      getMapboxAccessToken({ VITE_MAPBOX_ACCESS_TOKEN: "pk.a", MAPBOX_TOKEN: "pk.b" }),
      "pk.a",
    );
    assert.equal(
      getMapboxAccessToken({ VITE_MAPBOX_ACCESS_TOKEN: "   ", MAPBOX_TOKEN: "pk.b" }),
      "pk.b",
    );
  });
});
