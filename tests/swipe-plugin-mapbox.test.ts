import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getSwipeControlOptions,
  maplibreSwipePlugin as plugin,
  swipeComparisonMapFactory,
} from "../packages/plugins/src/plugins/maplibre-swipe";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

/** A host with only the doors the swipe options read. */
function host(overrides: Partial<GeoLibreAppAPI> = {}): GeoLibreAppAPI {
  return {
    getMap: () => null,
    getActiveBasemap: () => "https://example.test/style.json",
    getBasemapLayerIds: () => ["basemap-water", "basemap-roads"],
    ...overrides,
  } as unknown as GeoLibreAppAPI;
}

/** A mapbox-gl namespace with just the class the factory constructs. */
function mapboxGl() {
  const built: unknown[] = [];
  class FakeMapboxMap {
    constructor(public options: unknown) {
      built.push(options);
    }
  }
  return { gl: { Map: FakeMapboxMap } as never, built, FakeMapboxMap };
}

describe("maplibreSwipePlugin engines", () => {
  it("declares both 2D engines", () => {
    assert.deepEqual(plugin.engines, ["maplibre", "mapbox"]);
  });
});

describe("swipeComparisonMapFactory", () => {
  it("leaves the upstream default (a MapLibre pane) on a MapLibre host", () => {
    // `undefined` is meaningful: maplibre-gl-swipe then builds its own
    // `new maplibregl.Map(...)`, which is right on MapLibre.
    assert.equal(swipeComparisonMapFactory(null), undefined);
    assert.equal(swipeComparisonMapFactory(host()), undefined);
    assert.equal(swipeComparisonMapFactory(host({ getMapboxGl: () => null })), undefined);
  });

  it("builds the comparison pane with mapbox-gl on a Mapbox host", () => {
    const { gl, built, FakeMapboxMap } = mapboxGl();
    const create = swipeComparisonMapFactory(host({ getMapboxGl: () => gl }));
    assert.ok(create, "a Mapbox host must get a factory");

    const container = { nodeType: 1 } as unknown as HTMLElement;
    const options = {
      container,
      style: { version: 8 as const, layers: [], sources: {} },
      center: { lng: 0, lat: 0 },
      zoom: 4,
      bearing: 0,
      pitch: 0,
      interactive: false as const,
      attributionControl: false as const,
    };
    const map = create!(options as never);
    assert.ok(map instanceof FakeMapboxMap, "a MapLibre pane cannot overlay a mapbox-gl canvas");
    assert.deepEqual(built, [options]);
  });
});

describe("swipe control options per engine", () => {
  it("keeps the deck.gl raster provider on MapLibre", () => {
    const options = getSwipeControlOptions(host());
    // COG and maplibre-gl-raster layers are custom layers getStyle() omits, so
    // the panel only sees them through this provider.
    assert.ok(options.layerProvider, "MapLibre must keep the raster provider");
    assert.equal(options.createMap, undefined);
  });

  it("drops it on Mapbox, where neither raster control runs", () => {
    const { gl } = mapboxGl();
    const options = getSwipeControlOptions(host({ getMapboxGl: () => gl }));
    // A project authored on MapLibre can still carry those layers in the store,
    // but nothing draws them here, so offering sides for them would be a lie.
    assert.equal(options.layerProvider, undefined);
    assert.ok(options.createMap, "Mapbox must build its own comparison pane");
  });

  it("hands the token to the comparison pane, which mapbox-gl needs per map", () => {
    const { gl, built } = mapboxGl();
    const create = swipeComparisonMapFactory(
      host({ getMapboxGl: () => gl, getMapboxAccessToken: () => "pk.test" }),
    );
    create!({ container: {} as HTMLElement } as never);
    // mapbox-gl reads its token from the global `mapboxgl.accessToken` unless
    // the constructor is handed one, and GeoLibre never sets that global; a
    // pane built without it renders nothing and logs every frame.
    assert.equal((built[0] as { accessToken?: string }).accessToken, "pk.test");
  });

  it("fetches a fetchable basemap style and names the ids when it is not", () => {
    const { gl } = mapboxGl();
    // http(s): the control can fetch it, so leave the established path alone.
    const fetchable = getSwipeControlOptions(host());
    assert.equal(fetchable.basemapStyle, "https://example.test/style.json");
    assert.equal(fetchable.basemapLayerIds, undefined);

    // mapbox://: `fetch` rejects the scheme outright, so the control would lose
    // the basemap grouping (and its default selection) without the ids.
    const mapbox = getSwipeControlOptions(
      host({
        getMapboxGl: () => gl,
        getActiveBasemap: () => "mapbox://styles/mapbox/standard",
      }),
    );
    assert.deepEqual(mapbox.basemapLayerIds, ["basemap-water", "basemap-roads"]);
  });

  it("passes the same native-layer configuration on both engines", () => {
    const { gl } = mapboxGl();
    const maplibre = getSwipeControlOptions(host());
    const mapbox = getSwipeControlOptions(host({ getMapboxGl: () => gl }));
    for (const key of [
      "excludeLayers",
      "visibleLayersOnly",
      "showPanel",
      "basemapStyle",
    ] as const) {
      assert.deepEqual(mapbox[key], maplibre[key], `${key} must not differ by engine`);
    }
  });
});
