import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { GeoLibreLayer } from "../packages/core/src/types";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";

// Verifies the store → Cesium reconciler against a fake Cesium namespace + viewer
// (the real engine never loads here — its import in the module is type-only). It
// exercises the create path for each supported layer kind, live appearance
// updates, rebuild-on-source-change, removal, and skipping unsupported kinds.

// --- fakes ----------------------------------------------------------------
function makeFakes() {
  const calls = {
    imageryAdded: [] as unknown[],
    imageryRemoved: [] as unknown[],
    imageryStack: [] as { url?: string }[],
    raiseToTopCount: 0,
    dataSourcesAdded: [] as unknown[],
    dataSourcesRemoved: [] as unknown[],
    primitivesAdded: [] as unknown[],
    primitivesRemoved: [] as unknown[],
    urlProviders: [] as Record<string, unknown>[],
    wmsProviders: [] as Record<string, unknown>[],
    arcgisProviders: [] as { url: unknown; options?: Record<string, unknown> }[],
    wmtsProviders: [] as Record<string, unknown>[],
    singleTileProviders: [] as { url: unknown; options?: Record<string, unknown> }[],
    geojsonLoads: [] as { data: unknown; options: Record<string, unknown> }[],
    tilesetUrls: [] as unknown[],
  };

  const viewer = {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
      primitives: {
        add: (p: unknown) => calls.primitivesAdded.push(p),
        remove: (p: unknown) => calls.primitivesRemoved.push(p),
      },
    },
    imageryLayers: {
      addImageryProvider: (provider: unknown) => {
        const layer = {
          kind: "imagery",
          provider,
          url: (provider as { url?: string }).url,
          show: true,
          alpha: 1,
        };
        calls.imageryAdded.push(layer);
        calls.imageryStack.push(layer);
        return layer;
      },
      remove: (layer: unknown, _destroy?: boolean) => {
        calls.imageryRemoved.push(layer);
        const i = calls.imageryStack.indexOf(layer as { url?: string });
        if (i >= 0) calls.imageryStack.splice(i, 1);
      },
      raiseToTop: (layer: unknown) => {
        calls.raiseToTopCount++;
        const i = calls.imageryStack.indexOf(layer as { url?: string });
        if (i >= 0) calls.imageryStack.push(...calls.imageryStack.splice(i, 1));
      },
    },
    dataSources: {
      add: (ds: unknown) => {
        calls.dataSourcesAdded.push(ds);
        return Promise.resolve(ds);
      },
      remove: (ds: unknown, _destroy?: boolean) => calls.dataSourcesRemoved.push(ds),
    },
  };

  const Cesium = {
    GeographicTilingScheme: class {},
    WebMercatorTilingScheme: class {},
    UrlTemplateImageryProvider: class {
      url?: string;
      constructor(opts: Record<string, unknown>) {
        this.url = opts.url as string | undefined;
        calls.urlProviders.push(opts);
      }
    },
    WebMapServiceImageryProvider: class {
      url?: string;
      constructor(opts: Record<string, unknown>) {
        this.url = opts.url as string | undefined;
        calls.wmsProviders.push(opts);
      }
    },
    WebMapTileServiceImageryProvider: class {
      url?: string;
      constructor(opts: Record<string, unknown>) {
        this.url = opts.url as string | undefined;
        calls.wmtsProviders.push(opts);
      }
    },
    ArcGisMapServerImageryProvider: {
      fromUrl: (url: unknown, options?: Record<string, unknown>) => {
        calls.arcgisProviders.push({ url, options });
        const providerUrl =
          typeof url === "string" ? url : (url as { opts?: { url?: string } })?.opts?.url;
        return Promise.resolve({ url: providerUrl });
      },
    },
    SingleTileImageryProvider: {
      fromUrl: (url: unknown, options?: Record<string, unknown>) => {
        calls.singleTileProviders.push({ url, options });
        const providerUrl =
          typeof url === "string" ? url : (url as { opts?: { url?: string } })?.opts?.url;
        return Promise.resolve({ url: providerUrl });
      },
    },
    Rectangle: {
      fromDegrees: (west: number, south: number, east: number, north: number) => ({
        west,
        south,
        east,
        north,
      }),
    },
    GeoJsonDataSource: {
      load: (data: unknown, options: Record<string, unknown>) => {
        calls.geojsonLoads.push({ data, options });
        return Promise.resolve({
          kind: "geojson",
          show: true,
          // One entity of each kind so in-place restyle (applyGeoJsonStyle) can
          // be checked for polygons, lines, and points.
          entities: {
            values: [
              { polygon: { material: options.fill } },
              { polyline: { material: options.stroke } },
              { billboard: { color: undefined } },
            ],
          },
        });
      },
    },
    ColorMaterialProperty: class {
      constructor(public color: unknown) {}
    },
    ConstantProperty: class {
      constructor(public value: unknown) {}
    },
    Cesium3DTileset: {
      fromUrl: (url: unknown) => {
        calls.tilesetUrls.push(url);
        return Promise.resolve({
          kind: "tileset",
          show: true,
          destroy: () => {},
          modelMatrix: null,
          boundingSphere: { center: {} },
        });
      },
    },
    Color: {
      fromCssColorString: (css: string) => ({
        css,
        withAlpha: (a: number) => ({ css, alpha: a }),
      }),
      WHITE: { withAlpha: (a: number) => ({ css: "WHITE", alpha: a }) },
    },
    Resource: class {
      constructor(public opts: Record<string, unknown>) {}
    },
  };

  // Flush the microtasks behind the async create paths (load → add / fromUrl).
  const flush = () => new Promise((r) => setTimeout(r, 0));

  return { calls, viewer, Cesium, flush };
}

function mkLayer(over: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "l1",
    name: "layer",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {},
    metadata: {},
    ...over,
  } as GeoLibreLayer;
}

function newSync(f: ReturnType<typeof makeFakes>) {
  // The fakes stand in for the Cesium namespace + Viewer (cast through unknown).
  return new CesiumLayerSync(
    f.Cesium as unknown as typeof import("cesium"),
    f.viewer as unknown as import("cesium").Viewer,
  );
}

// --- tests -----------------------------------------------------------------
describe("CesiumLayerSync", () => {
  let f: ReturnType<typeof makeFakes>;
  beforeEach(() => {
    f = makeFakes();
  });

  it("renders a geojson layer as a draped GeoJsonDataSource", async () => {
    const sync = newSync(f);
    const fc = { type: "FeatureCollection", features: [{}] };
    sync.sync([mkLayer({ type: "geojson", geojson: fc as never, visible: true })]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 1);
    assert.equal(f.calls.geojsonLoads[0].data, fc);
    assert.equal(f.calls.geojsonLoads[0].options.clampToGround, true);
    assert.equal(f.calls.dataSourcesAdded.length, 1);
  });

  it("renders every non-tile layer carrying GeoJSON through the GeoJSON path", async () => {
    const sync = newSync(f);
    const types = ["flatgeobuf", "geoparquet", "duckdb-query"] as const;
    const layers = types.map((type, index) =>
      mkLayer({
        id: `geojson-backed-${index}`,
        type,
        geojson: { type: "FeatureCollection", features: [{}] } as never,
      }),
    );

    sync.sync(layers);
    await f.flush();

    assert.equal(f.calls.geojsonLoads.length, types.length);
    assert.equal(f.calls.dataSourcesAdded.length, types.length);
    for (const layer of layers) assert.equal(isCesiumSupportedLayerType(layer), true, layer.type);
  });

  it("renders a layer kind the module never names, keyed on the data alone", async () => {
    // The globe decides on `layer.geojson`, not on a list of blessed types, so
    // a producer that starts attaching a FeatureCollection to a kind this
    // module has never heard of renders with no change here. `"zarr"` and
    // `"lidar"` are only stand-ins for that: nothing populates their geojson
    // today, and this asserts the mechanism rather than either kind's behavior.
    const sync = newSync(f);
    const types = ["zarr", "lidar"] as const;
    const layers = types.map((type, index) =>
      mkLayer({
        id: `unlisted-${index}`,
        type,
        geojson: { type: "FeatureCollection", features: [{}] } as never,
      }),
    );

    sync.sync(layers);
    await f.flush();

    assert.equal(f.calls.geojsonLoads.length, types.length);
    for (const layer of layers) assert.equal(isCesiumSupportedLayerType(layer), true, layer.type);
  });

  it("keeps an imagery layer on the imagery path despite a stray FeatureCollection", async () => {
    const sync = newSync(f);
    const layer = mkLayer({
      type: "xyz",
      geojson: { type: "FeatureCollection", features: [{}] } as never,
      source: { tiles: ["https://example.com/{z}/{x}/{y}.png"] },
    });

    sync.sync([layer]);
    await f.flush();

    assert.equal(f.calls.geojsonLoads.length, 0);
    assert.equal(f.calls.imageryAdded.length, 1);
  });

  it("keeps tile-backed vector layers 2D-only even if they carry incidental GeoJSON", async () => {
    const sync = newSync(f);
    const layers = ["vector-tiles", "pmtiles", "mbtiles", "arcgis"].map((type, index) =>
      mkLayer({
        id: `vector-tiles-${index}`,
        type: type as "vector-tiles" | "pmtiles" | "mbtiles" | "arcgis",
        geojson: { type: "FeatureCollection", features: [{}] } as never,
      }),
    );

    sync.sync(layers);
    await f.flush();

    assert.equal(f.calls.geojsonLoads.length, 0);
    for (const layer of layers) assert.equal(isCesiumSupportedLayerType(layer), false, layer.type);
  });

  it("keeps specialized non-GeoJSON layer kinds out of the plain GeoJSON path", async () => {
    const sync = newSync(f);
    const layer = mkLayer({
      type: "deckgl-viz",
      geojson: { type: "FeatureCollection", features: [{}] } as never,
    });

    sync.sync([layer]);
    await f.flush();

    assert.equal(f.calls.geojsonLoads.length, 0);
    assert.equal(isCesiumSupportedLayerType(layer), false);
  });

  it("keeps ArcGIS vector tiles without a FeatureCollection marked 2D-only", () => {
    const layer = mkLayer({
      type: "arcgis",
      source: { url: "https://example.com/VectorTileServer" },
    });
    assert.equal(isCesiumSupportedLayerType(layer), false);
  });

  it("skips a geojson layer with no features", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({ type: "geojson", geojson: { type: "FeatureCollection", features: [] } as never }),
    ]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 0);
  });

  it("classifies empty GeoJSON-backed kinds as supported but not ready to render", async () => {
    const sync = newSync(f);
    const layer = mkLayer({
      type: "flatgeobuf",
      geojson: { type: "FeatureCollection", features: [] } as never,
    });

    assert.equal(isCesiumSupportedLayerType(layer), true);
    sync.sync([layer]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 0);
  });

  it("does not treat an empty GeoJSON-backed layer with incidental tiles as imagery", async () => {
    const sync = newSync(f);
    const layer = mkLayer({
      type: "flatgeobuf",
      geojson: { type: "FeatureCollection", features: [] } as never,
      source: { tiles: ["https://example.com/{z}/{x}/{y}.png"] },
    });

    sync.sync([layer]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 0);
    assert.equal(f.calls.imageryAdded.length, 0);
  });

  it("restyles a geojson layer's fill opacity in place without reloading", async () => {
    const sync = newSync(f);
    const fc = { type: "FeatureCollection", features: [{}] };
    const base = mkLayer({
      type: "geojson",
      geojson: fc as never,
      opacity: 1,
      style: { fillOpacity: 0.6 },
    });
    sync.sync([base]);
    await f.flush();
    assert.equal(f.calls.geojsonLoads.length, 1);
    const ds = f.calls.dataSourcesAdded[0] as {
      entities: { values: { polygon: { material: { color?: { alpha: number } } } }[] };
    };

    // Change only the layer opacity: no reload, no teardown — the fill alpha is
    // updated on the existing entity (0.6 fill opacity × 0.3 layer opacity).
    sync.sync([{ ...base, opacity: 0.3 }]);
    assert.equal(f.calls.geojsonLoads.length, 1, "opacity change must not reload");
    assert.equal(f.calls.dataSourcesRemoved.length, 0, "opacity change must not tear down");
    const alpha = ds.entities.values[0].polygon.material.color?.alpha;
    assert.ok(alpha !== undefined && Math.abs(alpha - 0.18) < 1e-9);
  });

  it("fades polygon fill, line stroke, and point markers by layer opacity", async () => {
    const sync = newSync(f);
    const fc = { type: "FeatureCollection", features: [{}] };
    sync.sync([
      mkLayer({
        type: "geojson",
        geojson: fc as never,
        opacity: 0.4,
        style: { fillOpacity: 0.5 },
      }),
    ]);
    await f.flush();
    const ds = f.calls.dataSourcesAdded[0] as {
      entities: {
        values: [
          { polygon: { material: { color: { alpha: number } } } },
          { polyline: { material: { color: { alpha: number } } } },
          { billboard: { color: { value: { alpha: number } } } },
        ];
      };
    };
    const v = ds.entities.values;
    // fill = 0.5 fill opacity × 0.4 layer opacity; stroke/markers = layer opacity.
    assert.ok(Math.abs(v[0].polygon.material.color.alpha - 0.2) < 1e-9);
    assert.ok(Math.abs(v[1].polyline.material.color.alpha - 0.4) < 1e-9);
    assert.ok(Math.abs(v[2].billboard.color.value.alpha - 0.4) < 1e-9);
  });

  it("renders xyz/raster tiles as an imagery layer with opacity + visibility", () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "x",
        type: "xyz",
        source: { tiles: ["https://t/{z}/{x}/{y}.png"], maxzoom: 18 },
        opacity: 0.5,
        visible: false,
      }),
    ]);
    assert.equal(f.calls.urlProviders.length, 1);
    assert.equal(f.calls.urlProviders[0].url, "https://t/{z}/{x}/{y}.png");
    assert.equal(f.calls.imageryAdded.length, 1);
    const layer = f.calls.imageryAdded[0] as { alpha: number; show: boolean };
    assert.equal(layer.alpha, 0.5);
    assert.equal(layer.show, false);
  });

  it("renders a wms layer via WebMapServiceImageryProvider with its GetMap params", () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "w",
        type: "wms",
        source: {
          url: "https://wms/service",
          layers: "topo",
          styles: "boundaries",
          format: "image/jpeg",
          transparent: false,
          version: "1.3.0",
          tiles: ["ignored{bbox-epsg-3857}"],
        },
      }),
    ]);
    assert.equal(f.calls.wmsProviders.length, 1);
    assert.equal(f.calls.wmsProviders[0].url, "https://wms/service");
    assert.equal(f.calls.wmsProviders[0].layers, "topo");
    // The user's chosen style/format/version/transparent must pass through so
    // the globe matches the 2D map (not silent defaults).
    const params = f.calls.wmsProviders[0].parameters as Record<string, unknown>;
    assert.equal(params.styles, "boundaries");
    assert.equal(params.format, "image/jpeg");
    assert.equal(params.version, "1.3.0");
    assert.equal(params.transparent, false);
    assert.equal(f.calls.urlProviders.length, 0);
  });

  it("does not rebuild a tile layer when unrelated bounds or token metadata change", () => {
    // metadata.bounds is set broadly (raster/time-slider layers), and a tile URL
    // can carry an unrelated token= param; neither feeds a UrlTemplateImageryProvider.
    const sync = newSync(f);
    const base = mkLayer({
      id: "r",
      type: "raster",
      source: { tiles: ["https://tiles.host/{z}/{x}/{y}.png?token=abc"] },
      metadata: { bounds: [0, 0, 1, 1] },
    });
    sync.sync([base]);
    assert.equal(f.calls.urlProviders.length, 1);

    sync.sync([{ ...base, metadata: { bounds: [0, 0, 2, 2] } }]);
    assert.equal(f.calls.urlProviders.length, 1);
    assert.equal(f.calls.imageryRemoved.length, 0);
  });

  it("treats a wms layer with only a service url as globe-supported", () => {
    // WebMapServiceImageryProvider defaults `layers` to "", so a url is enough —
    // a scripted or hand-edited project without `layers` must not read "2D only".
    const wms = mkLayer({ id: "w", type: "wms", source: { url: "https://wms.host/ows" } });
    assert.equal(isCesiumSupportedLayerType(wms), true);
    const sync = newSync(f);
    sync.sync([wms]);
    assert.equal(f.calls.wmsProviders.length, 1);
    assert.equal(f.calls.wmsProviders[0].layers, "");
  });

  it("re-asserts imagery stacking in store order after a middle-layer rebuild", () => {
    const sync = newSync(f);
    const A = mkLayer({ id: "a", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    const B = mkLayer({ id: "b", type: "xyz", source: { tiles: ["b/{z}/{x}/{y}"] } });
    const C = mkLayer({ id: "c", type: "xyz", source: { tiles: ["c/{z}/{x}/{y}"] } });
    sync.sync([A, B, C]);
    // Rebuild the middle layer (its handle re-appends to the top); the reorder
    // pass must restore [a, b2, c] bottom-to-top instead of leaving [a, c, b2].
    sync.sync([A, { ...B, source: { tiles: ["b2/{z}/{x}/{y}"] } }, C]);
    assert.deepEqual(
      f.calls.imageryStack.map((l) => l.url),
      ["a/{z}/{x}/{y}", "b2/{z}/{x}/{y}", "c/{z}/{x}/{y}"],
    );
  });

  it("rebuilds a wms layer when a GetMap param (e.g. styles) changes", () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "w",
      type: "wms",
      source: { url: "https://wms/service", layers: "topo", styles: "a" },
    });
    sync.sync([base]);
    sync.sync([{ ...base, source: { ...base.source, styles: "b" } }]);
    assert.equal(f.calls.wmsProviders.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
    assert.equal((f.calls.wmsProviders[1].parameters as { styles: string }).styles, "b");
  });

  it("skips the imagery reorder pass when nothing affects stacking", () => {
    const sync = newSync(f);
    const A = mkLayer({ id: "a", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    const B = mkLayer({ id: "b", type: "xyz", source: { tiles: ["b/{z}/{x}/{y}"] } });
    sync.sync([A, B]);
    const afterCreate = f.calls.raiseToTopCount;
    assert.ok(afterCreate > 0, "creating imagery re-asserts order");
    // A pure opacity change reruns sync() but must not touch imagery stacking.
    sync.sync([{ ...A, opacity: 0.5 }, B]);
    assert.equal(f.calls.raiseToTopCount, afterCreate, "no redundant reorder");
  });

  it("renders a 3d-tiles layer as a primitive from its tileset url", async () => {
    const sync = newSync(f);
    sync.sync([mkLayer({ id: "t", type: "3d-tiles", source: { url: "https://tiles/root.json" } })]);
    await f.flush();
    assert.equal(f.calls.tilesetUrls[0], "https://tiles/root.json");
    assert.equal(f.calls.primitivesAdded.length, 1);
  });

  it("keeps the Google Maps API key header on a Google Photorealistic tileset", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "g",
        type: "3d-tiles",
        source: {
          url: "https://tile.googleapis.com/v1/3dtiles/root.json",
          // The 3D-tiles resolver keeps a real key present in the headers; this
          // asserts createTileset routes headers through it (a plain pass-through
          // would also work, but the store normally strips the key, so the
          // resolver's env fallback is what makes Google tiles load on the globe).
          requestHeaders: { "X-GOOG-API-KEY": "test-key" },
        },
      }),
    ]);
    await f.flush();
    const resource = f.calls.tilesetUrls[0] as {
      opts: { headers: Record<string, string> };
    };
    assert.equal(resource.opts.headers["X-GOOG-API-KEY"], "test-key");
  });

  it("updates visibility in place without recreating the imagery layer", () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "x",
      type: "xyz",
      source: { tiles: ["u/{z}/{x}/{y}"] },
      visible: true,
    });
    sync.sync([base]);
    sync.sync([{ ...base, visible: false }]);
    assert.equal(f.calls.imageryAdded.length, 1); // created once
    assert.equal(f.calls.imageryRemoved.length, 0);
    assert.equal((f.calls.imageryAdded[0] as { show: boolean }).show, false);
  });

  it("rebuilds the imagery layer when the tile url changes", () => {
    const sync = newSync(f);
    const base = mkLayer({ id: "x", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    sync.sync([base]);
    sync.sync([{ ...base, source: { tiles: ["b/{z}/{x}/{y}"] } }]);
    assert.equal(f.calls.imageryAdded.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
  });

  it("forwards min/maxzoom and rebuilds an xyz layer when they change", () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "x",
      type: "xyz",
      source: { tiles: ["u/{z}/{x}/{y}"], minzoom: 3, maxzoom: 18 },
    });
    sync.sync([base]);
    assert.equal(f.calls.urlProviders[0].minimumLevel, 3);
    assert.equal(f.calls.urlProviders[0].maximumLevel, 18);
    sync.sync([{ ...base, source: { ...base.source, maxzoom: 22 } }]);
    assert.equal(f.calls.imageryAdded.length, 2, "maxzoom change rebuilds");
    assert.equal(f.calls.urlProviders[1].maximumLevel, 22);
    sync.sync([{ ...base, source: { ...base.source, minzoom: 5, maxzoom: 22 } }]);
    assert.equal(f.calls.imageryAdded.length, 3, "minzoom change rebuilds");
    assert.equal(f.calls.urlProviders[2].minimumLevel, 5);
  });

  it("removes a layer's handle when it leaves the layer list", () => {
    const sync = newSync(f);
    sync.sync([mkLayer({ id: "x", type: "xyz", source: { tiles: ["u/{z}/{x}/{y}"] } })]);
    sync.sync([]);
    assert.equal(f.calls.imageryRemoved.length, 1);
  });

  it("renders an arcgis MapServer layer via ArcGisMapServerImageryProvider.fromUrl", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "arc",
        type: "raster",
        sourcePath: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer",
        source: {
          tiles: [
            "https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/export?token=secret-token",
          ],
          token: "secret-token",
        },
        metadata: {
          sourceKind: "arcgis-map-service",
          arcgisSublayers: "0,1",
          hasAccessToken: true,
        },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 1);
    assert.equal(
      f.calls.arcgisProviders[0].url,
      "https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer",
    );
    assert.equal(f.calls.arcgisProviders[0].options?.layers, "0,1");
    assert.equal(f.calls.arcgisProviders[0].options?.token, "secret-token");
    assert.equal(f.calls.imageryAdded.length, 1);
  });

  it("forwards requestHeaders on an arcgis layer via Cesium.Resource", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "arc",
        type: "raster",
        sourcePath: "https://secure.arcgis/MapServer",
        source: {
          tiles: ["https://secure.arcgis/MapServer/export"],
          requestHeaders: { Authorization: "Bearer token123" },
        },
        metadata: {
          sourceKind: "arcgis-map-service",
        },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 1);
    const res = f.calls.arcgisProviders[0].url as {
      opts: { url: string; headers: Record<string, string> };
    };
    assert.equal(res.opts.url, "https://secure.arcgis/MapServer");
    assert.equal(res.opts.headers["Authorization"], "Bearer token123");
  });

  it("reads the arcgis token off the pre-built export tile url", async () => {
    // The Add ArcGIS Layer flow only ever bakes the token into the tile
    // template; `source.token` is never populated.
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "arc",
        type: "raster",
        sourcePath: "https://server/MapServer",
        source: { tiles: ["https://server/MapServer/export?bbox=1&token=secret-token&f=image"] },
        metadata: { sourceKind: "arcgis-map-service", hasAccessToken: true },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 1);
    assert.equal(f.calls.arcgisProviders[0].options?.token, "secret-token");
  });

  it("routes an arcgis image service through the tile template, not the MapServer provider", async () => {
    // ArcGisMapServerImageryProvider speaks `/export` + a MapServer capabilities
    // document; an ImageServer answers neither.
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "img",
        type: "raster",
        sourcePath: "https://server/ImageServer",
        source: { tiles: ["https://server/ImageServer/exportImage?f=image"] },
        metadata: { sourceKind: "arcgis-image-service" },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 0);
    assert.equal(f.calls.urlProviders.length, 1);
    assert.equal(f.calls.urlProviders[0].url, "https://server/ImageServer/exportImage?f=image");
  });

  it("skips a layer whose request headers would go out over plaintext", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "insecure",
        type: "xyz",
        source: {
          tiles: ["http://tiles.example/{z}/{x}/{y}.png"],
          requestHeaders: { Authorization: "Bearer token123" },
        },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.urlProviders.length, 0);
    assert.equal(f.calls.imageryAdded.length, 0);
  });

  it("does not retry a failed provider on every unrelated sync pass", async () => {
    const sync = newSync(f);
    const bad = mkLayer({
      id: "insecure",
      type: "xyz",
      source: {
        tiles: ["http://tiles.example/{z}/{x}/{y}.png"],
        requestHeaders: { Authorization: "Bearer token123" },
      },
    });
    const other = mkLayer({ id: "ok", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    sync.sync([bad, other]);
    await f.flush();
    assert.equal(f.calls.urlProviders.length, 1);

    // An unrelated change (opacity) re-runs sync for the whole pane; the failed
    // layer must not re-attempt its provider.
    sync.sync([bad, { ...other, opacity: 0.5 }]);
    await f.flush();
    assert.equal(f.calls.urlProviders.length, 1);
  });

  it("keeps both arcgis FeatureServer shapes out of imagery sync", async () => {
    // arcgis-layer.ts stores a FeatureServer two ways, and neither is imagery:
    // createArcGISStoreLayer() emits type "arcgis" (maplibre-arcgis renders it
    // natively, so it is 2D-only on the globe), while the paged query flow emits
    // a plain geojson layer tagged arcgis-feature-query, which the globe renders
    // through the GeoJsonDataSource path. Only type "raster" +
    // sourceKind "arcgis-map-service" may reach ArcGisMapServerImageryProvider.
    const native = mkLayer({
      id: "feat-native",
      type: "arcgis",
      sourcePath: "https://server/arcgis/rest/services/USA/FeatureServer/0",
      source: {
        url: "https://server/arcgis/rest/services/USA/FeatureServer/0",
        layerType: "feature",
        type: "geojson",
      },
      metadata: { sourceKind: "arcgis-feature-url", arcgisLayerType: "feature" },
    });
    const queried = mkLayer({
      id: "feat-query",
      type: "geojson",
      source: { type: "geojson", arcgisQueryUrl: "https://server/FeatureServer/0/query" },
      metadata: { sourceKind: "arcgis-feature-query" },
      geojson: { type: "FeatureCollection", features: [{}] } as never,
    });

    assert.equal(isCesiumSupportedLayerType(native), false);
    assert.equal(isCesiumSupportedLayerType(queried), true);

    const sync = newSync(f);
    sync.sync([native, queried]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 0);
    assert.equal(f.calls.imageryAdded.length, 0);
    // The queried layer still renders — via GeoJSON, not imagery.
    assert.equal(f.calls.geojsonLoads.length, 1);
  });

  it("renders an arcgis-tagged raster with no sourcePath via its tile template", async () => {
    // createImagery's ArcGIS branch needs a sourcePath for the service URL and
    // otherwise falls through to the generic tile-template branch; isSupported
    // must agree, or a hand-authored/MCP project that tags a plain raster
    // arcgis-map-service silently loses the globe rendering it had.
    const sync = newSync(f);
    const layer = mkLayer({
      id: "arc-tiles",
      type: "raster",
      source: { tiles: ["https://server/MapServer/tile/{z}/{y}/{x}"] },
      metadata: { sourceKind: "arcgis-map-service" },
    });
    assert.equal(isCesiumSupportedLayerType(layer), true);
    sync.sync([layer]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 0);
    assert.equal(f.calls.urlProviders.length, 1);
    assert.equal(f.calls.urlProviders[0].url, "https://server/MapServer/tile/{z}/{y}/{x}");
    assert.equal(f.calls.imageryAdded.length, 1);
  });

  it("rebuilds an arcgis layer when url or sublayers change", async () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "arc",
      type: "raster",
      sourcePath: "https://server/MapServer",
      source: { tiles: ["https://server/MapServer/export"] },
      metadata: { sourceKind: "arcgis-map-service", arcgisSublayers: "1,2" },
    });
    sync.sync([base]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 1);

    sync.sync([{ ...base, metadata: { ...base.metadata, arcgisSublayers: "1,2,3" } }]);
    await f.flush();
    assert.equal(f.calls.arcgisProviders.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
    assert.equal(f.calls.arcgisProviders[1].options?.layers, "1,2,3");
  });

  it("renders a capabilities-driven wmts layer via WebMapTileServiceImageryProvider", () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "wmts",
        type: "wmts",
        source: {
          url: "https://wmts.service/endpoint",
          layer: "ortho",
          style: "default",
          format: "image/png",
          tileMatrixSetID: "EPSG:3857",
          minzoom: 1,
          maxzoom: 19,
        },
      }),
    ]);
    assert.equal(f.calls.wmtsProviders.length, 1);
    assert.equal(f.calls.wmtsProviders[0].url, "https://wmts.service/endpoint");
    assert.equal(f.calls.wmtsProviders[0].layer, "ortho");
    assert.equal(f.calls.wmtsProviders[0].style, "default");
    assert.equal(f.calls.wmtsProviders[0].format, "image/png");
    assert.equal(f.calls.wmtsProviders[0].tileMatrixSetID, "EPSG:3857");
    assert.equal(f.calls.wmtsProviders[0].minimumLevel, 1);
    assert.equal(f.calls.wmtsProviders[0].maximumLevel, 19);
    assert.equal(f.calls.imageryAdded.length, 1);
  });

  it("reports a capabilities-driven wmts layer with no tileMatrixSetID as 2D only", () => {
    // Cesium throws on a missing tileMatrixSetID and a guessed one 404s per
    // tile, so an incomplete hand-authored entry must not read as globe-capable.
    const sync = newSync(f);
    const layer = mkLayer({
      id: "wmts",
      type: "wmts",
      source: { url: "https://wmts.service/endpoint", layer: "ortho" },
    });
    assert.equal(isCesiumSupportedLayerType(layer), true);
    sync.sync([layer]);
    assert.equal(f.calls.wmtsProviders.length, 0);
    assert.equal(f.calls.imageryAdded.length, 0);

    // A tile template needs no matrix-set negotiation, so it still renders.
    sync.sync([
      {
        ...layer,
        source: { ...layer.source, tiles: ["https://wmts.service/{z}/{x}/{y}.png"] },
      },
    ]);
    assert.equal(f.calls.urlProviders.length, 1);
  });

  it("rebuilds a wmts layer when tileMatrixSetID or layer changes", () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "wmts",
      type: "wmts",
      source: {
        url: "https://wmts.service/endpoint",
        layer: "l1",
        tileMatrixSetID: "setA",
      },
    });
    sync.sync([base]);
    assert.equal(f.calls.wmtsProviders.length, 1);
    sync.sync([{ ...base, source: { ...base.source, tileMatrixSetID: "setB" } }]);
    assert.equal(f.calls.wmtsProviders.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
    assert.equal(f.calls.wmtsProviders[1].tileMatrixSetID, "setB");

    // test tilingScheme change
    sync.sync([{ ...base, source: { ...base.source, tilingScheme: "GeographicTilingScheme" } }]);
    assert.equal(f.calls.wmtsProviders.length, 3);
    assert.equal(f.calls.imageryRemoved.length, 2);

    // test tileMatrixLabels change
    sync.sync([{ ...base, source: { ...base.source, tileMatrixLabels: ["0", "1", "2"] } }]);
    assert.equal(f.calls.wmtsProviders.length, 4);
    assert.equal(f.calls.imageryRemoved.length, 3);
  });

  it("renders an image layer via SingleTileImageryProvider from bounds or coordinates", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "img1",
        type: "image",
        source: {
          url: "https://images.org/photo.png",
        },
        metadata: {
          bounds: [-122.5, 37.5, -122.0, 38.0],
        },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 1);
    assert.equal(f.calls.singleTileProviders[0].url, "https://images.org/photo.png");
    assert.deepEqual(f.calls.singleTileProviders[0].options?.rectangle, {
      west: -122.5,
      south: 37.5,
      east: -122.0,
      north: 38.0,
    });
    assert.equal(f.calls.imageryAdded.length, 1);

    // Test with 4 corner coordinates (top-left, top-right, bottom-right, bottom-left)
    const sync2 = newSync(f);
    sync2.sync([
      mkLayer({
        id: "img2",
        type: "image",
        source: {
          url: "data:image/png;base64,AAA",
          coordinates: [
            [-10, 20],
            [5, 20],
            [5, 10],
            [-10, 10],
          ],
        },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 2);
    assert.deepEqual(f.calls.singleTileProviders[1].options?.rectangle, {
      west: -10,
      south: 10,
      east: 5,
      north: 20,
    });

    // Test antimeridian crossing (e.g. 179 to -179)
    const sync3 = newSync(f);
    sync3.sync([
      mkLayer({
        id: "img3",
        type: "image",
        source: {
          url: "data:image/png;base64,AAA",
          coordinates: [
            [179, 20],
            [-179, 20],
            [-179, 10],
            [179, 10],
          ],
        },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 3);
    assert.deepEqual(f.calls.singleTileProviders[2].options?.rectangle, {
      west: 179,
      south: 10,
      east: -179,
      north: 20,
    });
  });

  it("prefers corner coordinates over a plain min/max metadata.bounds", async () => {
    // cornersToBounds() (Georeferencer) and the KML ground-overlay importer both
    // cache metadata.bounds as a plain min/max, which inverts to a near-global
    // rectangle across the antimeridian. The corners are authoritative.
    const sync = newSync(f);
    const base = mkLayer({
      id: "img",
      type: "image",
      source: {
        url: "data:image/png;base64,AAA",
        coordinates: [
          [179, 20],
          [-179, 20],
          [-179, 10],
          [179, 10],
        ],
      },
      metadata: { bounds: [-179, 10, 179, 20] },
    });
    sync.sync([base]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 1);
    assert.deepEqual(f.calls.singleTileProviders[0].options?.rectangle, {
      west: 179,
      south: 10,
      east: -179,
      north: 20,
    });

    // A corner-only edit (a future edit-GCPs flow) rebuilds even though the
    // cached metadata.bounds is untouched.
    sync.sync([
      {
        ...base,
        source: {
          ...base.source,
          coordinates: [
            [178, 20],
            [-179, 20],
            [-179, 10],
            [178, 10],
          ],
        },
      },
    ]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 2);
    assert.deepEqual(f.calls.singleTileProviders[1].options?.rectangle, {
      west: 178,
      south: 10,
      east: -179,
      north: 20,
    });
  });

  it("falls back to metadata.bounds when out-of-range corners can't be unwrapped", async () => {
    // A >180 degree spread that doesn't straddle zero (only reachable with
    // out-of-range longitudes from a hand-authored project) would leave
    // Math.min/max of an empty array — an infinite corner Cesium would throw on.
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "img",
        type: "image",
        source: {
          url: "data:image/png;base64,AAA",
          coordinates: [
            [0, 20],
            [200, 20],
            [200, 10],
            [0, 10],
          ],
        },
        metadata: { bounds: [0, 10, 20, 20] },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 1);
    assert.deepEqual(f.calls.singleTileProviders[0].options?.rectangle, {
      west: 0,
      south: 10,
      east: 20,
      north: 20,
    });
  });

  it("rebuilds an image layer when url or bounds change", async () => {
    const sync = newSync(f);
    const base = mkLayer({
      id: "img",
      type: "image",
      source: {
        url: "https://images.org/a.png",
      },
      metadata: { bounds: [0, 0, 10, 10] },
    });
    sync.sync([base]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 1);

    sync.sync([{ ...base, metadata: { ...base.metadata, bounds: [0, 0, 15, 15] } }]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 2);
    assert.equal(f.calls.imageryRemoved.length, 1);
  });

  it("skips an image layer missing bounds or coordinates", async () => {
    const sync = newSync(f);
    sync.sync([
      mkLayer({
        id: "img",
        type: "image",
        source: { url: "https://images.org/a.png" },
      }),
    ]);
    await f.flush();
    assert.equal(f.calls.singleTileProviders.length, 0);
    assert.equal(f.calls.imageryAdded.length, 0);
  });

  it("re-asserts imagery stacking after an async provider resolves", async () => {
    const sync = newSync(f);
    const A = mkLayer({ id: "a", type: "xyz", source: { tiles: ["a/{z}/{x}/{y}"] } });
    const B = mkLayer({
      id: "b",
      type: "raster",
      sourcePath: "https://server/MapServer",
      metadata: { sourceKind: "arcgis-map-service" },
      source: { tiles: ["https://server/MapServer/export"] },
    });
    const C = mkLayer({ id: "c", type: "xyz", source: { tiles: ["c/{z}/{x}/{y}"] } });
    sync.sync([A, B, C]);
    await f.flush();
    assert.deepEqual(
      f.calls.imageryStack.map((l) => l.url),
      ["a/{z}/{x}/{y}", "https://server/MapServer", "c/{z}/{x}/{y}"],
    );
  });

  it("classifies supported vs 2D-only layer kinds", () => {
    for (const type of ["geojson", "xyz", "raster", "wms", "wmts", "image", "3d-tiles"] as const) {
      assert.equal(isCesiumSupportedLayerType(mkLayer({ type })), true, type);
    }
    for (const type of [
      "pmtiles",
      "mbtiles",
      "zarr",
      "lidar",
      "gaussian-splat",
      "deckgl-viz",
    ] as const) {
      assert.equal(isCesiumSupportedLayerType(mkLayer({ type })), false, type);
    }
  });

  it("skips unsupported layer kinds", () => {
    const sync = newSync(f);
    const layers = [
      mkLayer({ id: "p", type: "pmtiles", source: { url: "x.pmtiles" } }),
      mkLayer({ id: "z", type: "zarr", source: {} }),
    ];
    sync.sync(layers);
    assert.equal(f.calls.imageryAdded.length, 0);
    assert.equal(f.calls.primitivesAdded.length, 0);
    // The kind-level predicate the UI uses to flag "2D only" layers agrees.
    assert.deepEqual(
      layers.filter((l) => !isCesiumSupportedLayerType(l)).map((l) => l.id),
      ["p", "z"],
    );
  });
});
