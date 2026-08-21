import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createEmptyProject,
  redactCredentials,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  addArcGISLayer,
  fetchArcGISImageServiceRasterFunctions,
  fetchArcGISMapServiceSublayers,
} from "../packages/plugins/src/plugins/arcgis-layer";

const MAP_SERVICE_URL = "https://example.com/arcgis/rest/services/Boundaries/MapServer";
const IMAGE_SERVICE_URL = "https://example.com/arcgis/rest/services/Elevation/ImageServer";

/** A dynamic (uncached) MapServer: no fused cache, so `/export` is the only way in. */
const DYNAMIC_MAP_SERVICE = {
  mapName: "Layers",
  singleFusedMapCache: false,
  copyrightText: "© Example Boundaries",
  fullExtent: {
    xmin: -125,
    ymin: 24,
    xmax: -66,
    ymax: 50,
    spatialReference: { wkid: 4326 },
  },
};

/** A MapServer cached on the standard Web Mercator scheme, levels 0-3. */
const CACHED_MAP_SERVICE = {
  ...DYNAMIC_MAP_SERVICE,
  singleFusedMapCache: true,
  tileInfo: {
    rows: 256,
    cols: 256,
    origin: { x: -20037508.342787, y: 20037508.342787 },
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    lods: [
      { level: 0, resolution: 156543.03392800014 },
      { level: 1, resolution: 78271.51696399994 },
      { level: 2, resolution: 39135.75848200009 },
      { level: 3, resolution: 19567.87924099992 },
    ],
  },
};

const IMAGE_SERVICE = {
  name: "Elevation",
  copyrightText: "© Example Elevation",
  fullExtent: {
    // Web Mercator, so the bounds conversion is exercised too.
    xmin: -13914936,
    ymin: 2870341,
    xmax: -7451501,
    ymax: 6446275,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
  },
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("addArcGISLayer (map and image services)", () => {
  let fitBoundsCalls: Array<[number, number, number, number]>;
  let fetchUrls: string[];
  let app: GeoLibreAppAPI;
  let originalFetch: typeof fetch;
  let serviceInfo: unknown;

  /** Answers every `?f=json` request with the service description under test. */
  function respondWith(info: unknown): void {
    serviceInfo = info;
  }

  beforeEach(() => {
    useAppStore.getState().newProject({ name: "ArcGIS" });
    useAppStore.temporal.getState().clear();
    fitBoundsCalls = [];
    fetchUrls = [];
    serviceInfo = DYNAMIC_MAP_SERVICE;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetchUrls.push(typeof input === "string" ? input : input.toString());
      return jsonResponse(serviceInfo);
    }) as typeof fetch;
    app = {
      // Neither service touches the map: both become plain raster layers.
      getMap: () => null,
      fitBounds: (bounds) => {
        fitBoundsCalls.push(bounds);
      },
    } as unknown as GeoLibreAppAPI;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The single tile template of the layer that was just added. */
  function tileTemplate(id: string): string {
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, "expected the service layer to be added to the store");
    const tiles = layer.source.tiles as string[] | undefined;
    assert.equal(tiles?.length, 1);
    return tiles?.[0] ?? "";
  }

  it("loads a dynamic map service as a raster layer of /export requests", async () => {
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      name: "Boundaries",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    // A plain raster layer, so opacity, the raster style controls, reordering,
    // and project save/reload work with no dedicated handler.
    assert.equal(layer.type, "raster");
    assert.notEqual(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.metadata.sourceKind, "arcgis-map-service");
    assert.equal(layer.metadata.arcgisTiled, false);

    const template = tileTemplate(id);
    assert.match(template, /\/MapServer\/export\?/);
    // MapLibre only substitutes literal braces, so the bbox token must survive
    // unencoded while everything else is escaped.
    assert.ok(template.includes("bbox={bbox-epsg-3857}"), template);
    assert.ok(template.includes("bboxSR=3857"), template);
    assert.ok(template.includes("imageSR=3857"), template);
    assert.ok(template.includes("size=256%2C256"), template);
    // Transparent png32 is what lets the service draw over the basemap.
    assert.ok(template.includes("format=png32"), template);
    assert.ok(template.includes("transparent=true"), template);
    assert.ok(template.endsWith("f=image"), template);

    assert.equal(layer.source.attribution, "© Example Boundaries");
    assert.deepEqual(fitBoundsCalls, [[-125, 24, -66, 50]]);
  });

  it("loads an image service through /exportImage", async () => {
    respondWith(IMAGE_SERVICE);
    const id = await addArcGISLayer(app, {
      layerType: "image-service",
      sourceType: "url",
      url: IMAGE_SERVICE_URL,
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.equal(layer?.metadata.sourceKind, "arcgis-image-service");
    // The service name is read off the URL when the caller supplies none.
    assert.equal(layer?.name, "Elevation");
    assert.match(tileTemplate(id), /\/ImageServer\/exportImage\?/);
    // The Web Mercator extent is converted to the geographic bounds MapLibre wants.
    const [west, south, east, north] = fitBoundsCalls[0] ?? [];
    assert.ok(west > -126 && west < -124, `west ${west}`);
    assert.ok(east > -67 && east < -66, `east ${east}`);
    assert.ok(south > 24 && south < 25, `south ${south}`);
    assert.ok(north > 49 && north < 51, `north ${north}`);
  });

  it("uses the tile cache when the service has a standard Web Mercator one", async () => {
    respondWith(CACHED_MAP_SERVICE);
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
    });

    // Pre-rendered tiles are cheaper than an export per tile, so they win.
    assert.equal(tileTemplate(id), `${MAP_SERVICE_URL}/tile/{z}/{y}/{x}`);
    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.equal(layer?.metadata.arcgisTiled, true);
    assert.equal(layer?.source.tileSize, 256);
    // The cache's own level range, so MapLibre neither requests levels the
    // service does not hold nor stops short of the ones it does.
    assert.equal(layer?.source.minzoom, 0);
    assert.equal(layer?.source.maxzoom, 3);
  });

  it("falls back to /export when the cache uses a non-standard scheme", async () => {
    respondWith({
      ...CACHED_MAP_SERVICE,
      tileInfo: {
        ...CACHED_MAP_SERVICE.tileInfo,
        // A cache in a state plane projection cannot be read as XYZ tiles.
        spatialReference: { wkid: 2229 },
      },
    });
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
    });
    assert.match(tileTemplate(id), /\/export\?/);
  });

  it("falls back to /export when the cache origin is off the Web Mercator corner", async () => {
    respondWith({
      ...CACHED_MAP_SERVICE,
      tileInfo: {
        ...CACHED_MAP_SERVICE.tileInfo,
        // The left edge is right but the top edge is not: read as XYZ tiles this
        // renders horizontally aligned and vertically shifted, which looks like
        // real imagery in the wrong place rather than an obvious break.
        origin: { x: -20037508.342787, y: 19999999 },
      },
    });
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
    });
    assert.match(tileTemplate(id), /\/export\?/);
  });

  it("falls back to /export when the cache LODs are not the standard resolutions", async () => {
    respondWith({
      ...CACHED_MAP_SERVICE,
      tileInfo: {
        ...CACHED_MAP_SERVICE.tileInfo,
        // A custom LOD table would render at the wrong scale per zoom level.
        lods: [
          { level: 0, resolution: 100000 },
          { level: 1, resolution: 50000 },
        ],
      },
    });
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
    });
    assert.match(tileTemplate(id), /\/export\?/);
  });

  it("draws selected sublayers dynamically even when the service is cached", async () => {
    respondWith(CACHED_MAP_SERVICE);
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      sublayers: " 2, 5 ",
    });

    const template = tileTemplate(id);
    // A fused cache holds one image per tile, so honoring a sublayer choice
    // means giving the cache up for the dynamic endpoint.
    assert.match(template, /\/export\?/);
    assert.ok(template.includes("layers=show%3A2%2C5"), template);
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === id)?.metadata.arcgisSublayers,
      "2,5",
    );
  });

  it("derives WGS84 bounds from selected layers when the service uses a local CRS", async () => {
    respondWith({
      ...DYNAMIC_MAP_SERVICE,
      fullExtent: {
        xmin: -18715,
        ymin: 36680,
        xmax: 1090090,
        ymax: 943128,
        spatialReference: { wkid: 3078 },
      },
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      fetchUrls.push(url);
      if (url.includes("/1/query?")) {
        return jsonResponse({
          extent: {
            xmin: -90.56,
            ymin: 41.68,
            xmax: -81.78,
            ymax: 48.33,
            spatialReference: { wkid: 4326 },
          },
        });
      }
      if (url.includes("/2/query?")) {
        return jsonResponse({
          extent: {
            xmin: -90.55,
            ymin: 41.63,
            xmax: -82.07,
            ymax: 48.28,
            spatialReference: { wkid: 4326 },
          },
        });
      }
      return jsonResponse(serviceInfo);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      sublayers: "1,2",
    });

    assert.deepEqual(fitBoundsCalls, [[-90.56, 41.63, -81.78, 48.33]]);
    assert.deepEqual(
      useAppStore.getState().layers.find((layer) => layer.id === id)?.source.bounds,
      [-90.56, 41.63, -81.78, 48.33],
    );
    assert.ok(fetchUrls.some((url) => url.includes("returnExtentOnly=true")));
    assert.ok(fetchUrls.some((url) => url.includes("outSR=4326")));
  });

  it("reads a sublayer id off a /MapServer/<id> URL", async () => {
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: `${MAP_SERVICE_URL}/3`,
    });

    const template = tileTemplate(id);
    // `/export` lives on the service root, so the id becomes a selection.
    assert.ok(template.startsWith(`${MAP_SERVICE_URL}/export?`), template);
    assert.ok(template.includes("layers=show%3A3"), template);
  });

  it("rejects a sublayer list that is not made of ids", async () => {
    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "map-service",
        sourceType: "url",
        url: MAP_SERVICE_URL,
        sublayers: "roads",
      }),
      /numeric ids/,
    );
    // Nothing must be added: a silently ignored selection would look honored.
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("applies an image service rendering rule and skips the cache for it", async () => {
    respondWith({ ...IMAGE_SERVICE, ...CACHED_MAP_SERVICE, name: "Elevation" });
    const id = await addArcGISLayer(app, {
      layerType: "image-service",
      sourceType: "url",
      url: IMAGE_SERVICE_URL,
      renderingRule: '{"rasterFunction":"Hillshade"}',
    });

    const template = tileTemplate(id);
    assert.match(template, /\/exportImage\?/);
    assert.ok(template.includes(encodeURIComponent('{"rasterFunction":"Hillshade"}')), template);
  });

  it("ignores the option that does not belong to the selected service type", async () => {
    respondWith(CACHED_MAP_SERVICE);
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      // The Add Data form keeps both fields when the layer type is switched, so
      // a map service can arrive carrying whatever was typed for an image
      // service. An unparseable leftover must not block the submission, and a
      // parseable one must not cost the layer its tile cache.
      renderingRule: "not json at all",
    });
    assert.equal(tileTemplate(id), `${MAP_SERVICE_URL}/tile/{z}/{y}/{x}`);

    respondWith({ ...IMAGE_SERVICE, ...CACHED_MAP_SERVICE });
    const imageId = await addArcGISLayer(app, {
      layerType: "image-service",
      sourceType: "url",
      url: IMAGE_SERVICE_URL,
      sublayers: "not an id",
    });
    assert.equal(tileTemplate(imageId), `${IMAGE_SERVICE_URL}/tile/{z}/{y}/{x}`);
  });

  it("rejects a rendering rule that is not JSON", async () => {
    respondWith(IMAGE_SERVICE);
    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "image-service",
        sourceType: "url",
        url: IMAGE_SERVICE_URL,
        renderingRule: "Hillshade",
      }),
      /must be JSON/,
    );
  });

  it("rejects a URL that is not the expected service type", async () => {
    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "map-service",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      }),
      /MapServer URL/,
    );
    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "image-service",
        sourceType: "url",
        url: MAP_SERVICE_URL,
      }),
      /ImageServer URL/,
    );
  });

  it("drops a query string left on a pasted service URL", async () => {
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      // What the REST directory's address bar hands you.
      url: `${MAP_SERVICE_URL}?f=html`,
    });
    // The request template is rebuilt from scratch, so `f=html` must not
    // survive to fight with `f=image`.
    assert.ok(tileTemplate(id).startsWith(`${MAP_SERVICE_URL}/export?`), tileTemplate(id));
    assert.doesNotMatch(tileTemplate(id), /f=html/);
  });

  it("carries the token into the tile requests and flags the layer", async () => {
    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      token: "secret-token-123",
    });

    // Unlike the feature path, a raster tile cannot be fetched without the
    // token in its URL, so it travels there and the layer is flagged for the
    // credential redaction that runs on any project leaving the app.
    assert.ok(tileTemplate(id).includes("token=secret-token-123"), tileTemplate(id));
    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === id)?.metadata.hasAccessToken,
      true,
    );
    assert.ok(
      fetchUrls.some((url) => url.includes("token=secret-token-123")),
      "expected the metadata request to carry the token",
    );
  });

  it("redacts the token from the tile URL when the project leaves the app", async () => {
    await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      token: "secret-token-123",
    });

    // The token has to sit in the tile template for the tiles to load, so what
    // keeps it out of a shared, embedded, or collaborated project is the egress
    // redaction pass. Assert that here rather than trusting the flag alone.
    const project = createEmptyProject("ArcGIS");
    project.layers = useAppStore.getState().layers;
    const serialized = serializeProject(redactCredentials(project));
    assert.doesNotMatch(serialized, /secret-token-123/);
    // The layer is still recognizable as token-protected on the other side, so
    // a viewer can be told why it will not draw.
    assert.match(serialized, /"hasAccessToken": true/);
  });

  it("resolves a portal item to the service it points at", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchUrls.push(url);
      return jsonResponse(
        url.includes("/content/items/") ? { url: MAP_SERVICE_URL } : DYNAMIC_MAP_SERVICE,
      );
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "portal-item",
      itemId: "abc123",
    });

    assert.ok(tileTemplate(id).startsWith(`${MAP_SERVICE_URL}/export?`), tileTemplate(id));
    assert.equal(useAppStore.getState().layers.find((l) => l.id === id)?.metadata.itemId, "abc123");
  });

  it("leaves the camera alone when the caller opts out of zooming", async () => {
    await addArcGISLayer(app, {
      layerType: "map-service",
      sourceType: "url",
      url: MAP_SERVICE_URL,
      // Project import restores its own camera, so fitting each service in turn
      // would pan away from the saved extent.
      zoomTo: false,
    });
    assert.deepEqual(fitBoundsCalls, []);
  });
});

describe("fetchArcGISMapServiceSublayers", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retrieves named MapServer layers and carries credentials", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return jsonResponse({
        layers: [
          null,
          { name: "Missing id" },
          { id: -1, name: "Negative id" },
          {
            id: 2,
            name: "Hydrography Lines",
            parentLayerId: -1,
            defaultVisibility: true,
            subLayerIds: null,
          },
        ],
      });
    }) as typeof fetch;

    const layers = await fetchArcGISMapServiceSublayers({
      url: `${MAP_SERVICE_URL}/?f=html`,
      token: "private token",
    });

    assert.deepEqual(
      layers.map(({ id, name }) => ({ id, name })),
      [{ id: 2, name: "Hydrography Lines" }],
    );
    assert.match(requestedUrl, /\/MapServer\?f=json&token=private\+token$/);
  });

  it("rejects URLs that are not MapServer endpoints", async () => {
    await assert.rejects(
      fetchArcGISMapServiceSublayers({ url: IMAGE_SERVICE_URL }),
      /Enter an ArcGIS MapServer URL/,
    );
  });
});

describe("fetchArcGISImageServiceRasterFunctions", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retrieves named ImageServer raster functions and carries credentials", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = input.toString();
      return jsonResponse({
        rasterFunctionInfos: [
          null,
          { description: "Missing name" },
          { name: 42, description: "Non-string name" },
          { name: "", description: "Blank name" },
          { name: "Missing description" },
          {
            name: "Multidirectional Hillshade",
            description: "Creates a shaded-relief representation of the surface.",
            help: "",
          },
          { name: "Multidirectional Hillshade", description: "Duplicate" },
        ],
      });
    }) as typeof fetch;

    const rasterFunctions = await fetchArcGISImageServiceRasterFunctions({
      url: `${IMAGE_SERVICE_URL}/?f=html`,
      token: "private token",
    });

    assert.deepEqual(rasterFunctions, [
      { name: "Missing description", description: "" },
      {
        name: "Multidirectional Hillshade",
        description: "Creates a shaded-relief representation of the surface.",
      },
    ]);
    assert.match(requestedUrl, /\/ImageServer\?f=json&token=private\+token$/);
  });

  it("returns an empty catalog when the service advertises no raster functions", async () => {
    globalThis.fetch = (async () => jsonResponse({ name: "Elevation" })) as typeof fetch;

    assert.deepEqual(await fetchArcGISImageServiceRasterFunctions({ url: IMAGE_SERVICE_URL }), []);
  });

  it("rejects URLs that are not ImageServer endpoints", async () => {
    await assert.rejects(
      fetchArcGISImageServiceRasterFunctions({ url: MAP_SERVICE_URL }),
      /Enter an ArcGIS ImageServer URL/,
    );
  });
});
