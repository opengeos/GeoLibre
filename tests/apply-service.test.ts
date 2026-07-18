import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { GEBCO_ATTRIBUTION } from "../apps/geolibre-desktop/src/components/layout/add-data/constants";
import {
  applyServiceEntry,
  arcgisFieldsToOptions,
  buildWfsGeoJsonLayer,
  buildWmsLayer,
  buildWmtsLayer,
  buildXyzLayer,
  wfsFieldsToRequest,
  wmsFieldsToParams,
  wmtsFieldsToParams,
  xyzFieldsToRequest,
} from "../apps/geolibre-desktop/src/components/layout/add-data/apply-service";
import type {
  ServiceFields,
  ServiceLibraryEntry,
  ServiceLibraryKind,
} from "../apps/geolibre-desktop/src/components/layout/add-data/service-library";

/** Builds a service-library entry for a test with the given kind and fields. */
function entry(
  kind: ServiceLibraryKind,
  fields: ServiceFields,
  name = "Test service",
): ServiceLibraryEntry {
  return { id: "test-id", name, category: "", kind, fields };
}

describe("buildXyzLayer", () => {
  it("builds a raster XYZ layer with the rendered tile URL", () => {
    const layer = buildXyzLayer({
      name: "Imagery",
      tileUrl: {
        originalUrl: "https://x/{z}/{x}/{y}.png",
        renderUrl: "https://x/{z}/{x}/{y}.png",
        url: "https://x/{z}/{x}/{y}.png",
        redirected: false,
      },
      tileSize: "256",
      shortUrl: false,
    });
    assert.equal(layer.type, "xyz");
    assert.equal(layer.name, "Imagery");
    const source = layer.source as Record<string, unknown>;
    assert.equal(source.type, "raster");
    assert.deepEqual(source.tiles, ["https://x/{z}/{x}/{y}.png"]);
    assert.equal(source.tileSize, 256);
    // A non-shortUrl, non-redirected layer records no original/resolved URL.
    const metadata = layer.metadata as Record<string, unknown>;
    assert.equal(metadata.sourceKind, "xyz-url");
    assert.equal(metadata.originalUrl, undefined);
    assert.equal(metadata.resolvedUrl, undefined);
  });

  it("falls back to tile size 256 for a negative or non-numeric value", () => {
    const negative = buildXyzLayer({
      name: "Neg",
      tileUrl: {
        originalUrl: "https://x",
        renderUrl: "https://x",
        url: "https://x",
        redirected: false,
      },
      tileSize: "-256",
      shortUrl: false,
    });
    assert.equal((negative.source as Record<string, unknown>).tileSize, 256);
  });

  it("records the original and resolved URLs for a redirected short URL", () => {
    const layer = buildXyzLayer({
      name: "Short",
      tileUrl: {
        originalUrl: "https://short.example/abc",
        renderUrl: "geolibre-xyz://abc/{z}/{x}/{y}",
        url: "https://cdn.example/{z}/{x}/{y}.png",
        redirected: true,
      },
      tileSize: "",
      shortUrl: true,
    });
    const source = layer.source as Record<string, unknown>;
    // An empty tile size falls back to the MapLibre default of 256.
    assert.equal(source.tileSize, 256);
    assert.equal(source.url, "https://short.example/abc");
    const metadata = layer.metadata as Record<string, unknown>;
    assert.equal(metadata.originalUrl, "https://short.example/abc");
    assert.equal(metadata.resolvedUrl, "https://cdn.example/{z}/{x}/{y}.png");
  });
});

describe("buildWmsLayer", () => {
  it("builds a GetMap tile template, stripping operation params", () => {
    const layer = buildWmsLayer({
      name: "WMS",
      // A pasted GetCapabilities URL: its operation params must be stripped.
      endpoint: "https://example.com/wms?REQUEST=GetCapabilities&SERVICE=WMS",
      layers: " topp:states ",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: "512",
      version: "1.3.0",
    });
    assert.equal(layer.type, "wms");
    const source = layer.source as Record<string, unknown>;
    assert.equal(source.tileSize, 512);
    assert.equal(source.layers, "topp:states");
    assert.equal(source.version, "1.3.0");
    // Endpoint is stripped of the leftover REQUEST/SERVICE params.
    assert.equal(source.url, "https://example.com/wms");
    const tileUrl = (source.tiles as string[])[0];
    assert.match(tileUrl, /REQUEST=GetMap/);
    assert.match(tileUrl, /LAYERS=topp%3Astates/);
    // WMS 1.3.0 uses CRS (not SRS) for the coordinate system parameter.
    assert.match(tileUrl, /[?&]CRS=EPSG%3A3857/);
    assert.equal((layer.metadata as Record<string, unknown>).service, "wms");
  });

  it("attaches the GEBCO attribution for a GEBCO endpoint", () => {
    const layer = buildWmsLayer({
      name: "GEBCO",
      endpoint: "https://wms.gebco.net/mapserv",
      layers: "GEBCO_LATEST",
      styles: "",
      format: "image/png",
      transparent: true,
      tileSize: "256",
      version: "1.3.0",
    });
    assert.equal((layer.source as Record<string, unknown>).attribution, GEBCO_ATTRIBUTION);
  });
});

describe("buildWmtsLayer", () => {
  it("builds a raster layer and trims the URL", () => {
    const layer = buildWmtsLayer({
      name: "WMTS",
      url: "  https://tiles.example/{z}/{x}/{y}.png  ",
      tileSize: "256",
    });
    assert.equal(layer.type, "wmts");
    const source = layer.source as Record<string, unknown>;
    assert.deepEqual(source.tiles, ["https://tiles.example/{z}/{x}/{y}.png"]);
    assert.equal(source.attribution, undefined);
  });

  it("attaches the GEBCO attribution for a GEBCO tile host", () => {
    const layer = buildWmtsLayer({
      name: "GEBCO tiles",
      url: "https://tiles.gebco.net/{z}/{x}/{y}.png",
      tileSize: "256",
    });
    assert.equal((layer.source as Record<string, unknown>).attribution, GEBCO_ATTRIBUTION);
  });
});

describe("buildWfsGeoJsonLayer", () => {
  it("embeds the fetched collection and records the feature count", () => {
    const data: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: null, properties: {} },
        { type: "Feature", geometry: null, properties: {} },
      ],
    };
    const layer = buildWfsGeoJsonLayer({
      name: "States",
      featureUrl: "https://example.com/wfs?REQUEST=GetFeature",
      data,
      typeName: "topp:states",
      version: "2.0.0",
      outputFormat: "application/json",
      srsName: "EPSG:4326",
    });
    assert.equal(layer.type, "geojson");
    assert.equal(layer.geojson, data);
    assert.equal(layer.sourcePath, "https://example.com/wfs?REQUEST=GetFeature");
    const metadata = layer.metadata as Record<string, unknown>;
    assert.equal(metadata.featureCount, 2);
    assert.equal(metadata.sourceKind, "wfs-getfeature");
    assert.equal(metadata.typeName, "topp:states");
  });

  it("omits an empty srsName from the source", () => {
    const layer = buildWfsGeoJsonLayer({
      name: "No SRS",
      featureUrl: "https://example.com/wfs",
      data: { type: "FeatureCollection", features: [] },
      typeName: "t",
      version: "2.0.0",
      outputFormat: "application/json",
      srsName: "",
    });
    assert.equal((layer.source as Record<string, unknown>).srsName, undefined);
  });
});

describe("field mappers", () => {
  it("reads XYZ fields with defaults", () => {
    assert.deepEqual(xyzFieldsToRequest({ url: "https://x" }), {
      url: "https://x",
      tileSize: "256",
      shortUrl: false,
    });
    assert.deepEqual(xyzFieldsToRequest({ url: "https://x", tileSize: "512", shortUrl: true }), {
      url: "https://x",
      tileSize: "512",
      shortUrl: true,
    });
  });

  it("resolves the WMS version from a saved field over the endpoint", () => {
    const params = wmsFieldsToParams(
      entry("wms", {
        endpoint: "https://e/wms?VERSION=1.1.1",
        layers: "a",
        version: "1.3.0",
      }),
    );
    // An explicit saved version wins over the endpoint's VERSION parameter.
    assert.equal(params.version, "1.3.0");
    assert.equal(params.layers, "a");
    assert.equal(params.format, "image/png");
    assert.equal(params.transparent, true);
  });

  it("falls back to the endpoint VERSION when no version field is saved", () => {
    const params = wmsFieldsToParams(
      entry("wms", { endpoint: "https://e/wms?VERSION=1.3.0", layers: "a" }),
    );
    assert.equal(params.version, "1.3.0");
  });

  it("defaults the WMS version to 1.1.1 when neither source has it", () => {
    const params = wmsFieldsToParams(entry("wms", { endpoint: "https://e/wms", layers: "a" }));
    assert.equal(params.version, "1.1.1");
  });

  it("reads WMTS fields with defaults", () => {
    assert.deepEqual(wmtsFieldsToParams(entry("wmts", { url: "https://t" })), {
      name: "Test service",
      url: "https://t",
      tileSize: "256",
    });
  });

  it("strips WFS operation params and maps an empty maxFeatures to undefined", () => {
    const request = wfsFieldsToRequest(
      entry("wfs", {
        endpoint: "https://e/wfs?REQUEST=GetCapabilities",
        typeName: " topp:states ",
        maxFeatures: "   ",
      }),
    );
    assert.equal(request.endpoint, "https://e/wfs");
    assert.equal(request.typeName, "topp:states");
    assert.equal(request.version, "2.0.0");
    assert.equal(request.outputFormat, "application/json");
    assert.equal(request.srsName, "EPSG:4326");
    assert.equal(request.maxFeatures, undefined);
  });

  it("detects ArcGIS vector-tile / portal-item and trims blanks to undefined", () => {
    assert.deepEqual(
      arcgisFieldsToOptions(
        entry("arcgis", {
          layerType: "vector-tile",
          sourceType: "portal-item",
          itemId: " abc ",
          url: "",
          portalUrl: "",
        }),
      ),
      {
        name: "Test service",
        layerType: "vector-tile",
        sourceType: "portal-item",
        url: undefined,
        itemId: "abc",
        portalUrl: undefined,
      },
    );
    // Unknown/absent values fall back to the feature + url defaults.
    const defaults = arcgisFieldsToOptions(entry("arcgis", { url: "https://s" }));
    assert.equal(defaults.layerType, "feature");
    assert.equal(defaults.sourceType, "url");
    assert.equal(defaults.url, "https://s");
  });
});

describe("applyServiceEntry", () => {
  /** A dispatcher deps stub that records the layers added to the store. */
  function stubDeps() {
    const added: { layer: GeoLibreLayer; beforeLayerId: string | null }[] = [];
    return {
      added,
      deps: {
        addLayer: (layer: GeoLibreLayer, beforeLayerId: string | null = null) => {
          added.push({ layer, beforeLayerId });
        },
        mapControllerRef: { current: null },
      },
    };
  }

  it("adds a WMS layer through the store, honoring the insert position", async () => {
    const { added, deps } = stubDeps();
    await applyServiceEntry(entry("wms", { endpoint: "https://e/wms", layers: "a" }, "My WMS"), {
      ...deps,
      beforeLayerId: "layer-2",
    });
    assert.equal(added.length, 1);
    assert.equal(added[0].layer.type, "wms");
    assert.equal(added[0].layer.name, "My WMS");
    assert.equal(added[0].beforeLayerId, "layer-2");
  });

  it("adds a WMTS layer through the store", async () => {
    const { added, deps } = stubDeps();
    await applyServiceEntry(entry("wmts", { url: "https://t/{z}/{x}/{y}" }), deps);
    assert.equal(added.length, 1);
    assert.equal(added[0].layer.type, "wmts");
    assert.equal(added[0].beforeLayerId, null);
  });

  it("fetches WFS GeoJSON, adds the layer, and fits the map to it", async () => {
    const added: { layer: GeoLibreLayer; beforeLayerId: string | null }[] = [];
    const fitted: GeoLibreLayer[] = [];
    const fc: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [1, 2] },
          properties: { id: 1 },
        },
      ],
    };
    const realFetch = globalThis.fetch;
    // Stub the network so the wfs branch drives its real dynamic import +
    // fetchWfsGeoJson + buildWfsGeoJsonLayer + addLayer/fitLayer wiring.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fc), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof globalThis.fetch;
    try {
      await applyServiceEntry(
        entry("wfs", { endpoint: "https://e/wfs", typeName: "topp:states" }, "States"),
        {
          addLayer: (layer, beforeLayerId = null) => {
            added.push({ layer, beforeLayerId });
          },
          mapControllerRef: {
            current: { fitLayer: (layer: GeoLibreLayer) => fitted.push(layer) },
          } as unknown as Parameters<typeof applyServiceEntry>[1]["mapControllerRef"],
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(added.length, 1);
    assert.equal(added[0].layer.type, "geojson");
    assert.equal(added[0].layer.name, "States");
    assert.equal(added[0].layer.geojson?.features.length, 1);
    // The map is fit to the freshly added WFS layer (the same object).
    assert.equal(fitted.length, 1);
    assert.equal(fitted[0], added[0].layer);
  });

  it("throws (before any layer is added) when required fields are missing", async () => {
    const { added, deps } = stubDeps();
    await assert.rejects(
      () => applyServiceEntry(entry("wms", { endpoint: "https://e" }), deps),
      /no layers/i,
    );
    await assert.rejects(
      () => applyServiceEntry(entry("wmts", { url: "  " }), deps),
      /no tile URL/i,
    );
    // XYZ validates before the (browser-only) maplibre import, so this is safe
    // to assert under Node.
    await assert.rejects(() => applyServiceEntry(entry("xyz", { url: "" }), deps), /no tile URL/i);
    await assert.rejects(() => applyServiceEntry(entry("wfs", { endpoint: "" }), deps), /no URL/i);
    // WFS mirrors WfsSource's output-format and numeric max-features guards.
    await assert.rejects(
      () =>
        applyServiceEntry(
          entry("wfs", {
            endpoint: "https://e/wfs",
            typeName: "t",
            outputFormat: "",
          }),
          deps,
        ),
      /output format/i,
    );
    await assert.rejects(
      () =>
        applyServiceEntry(
          entry("wfs", {
            endpoint: "https://e/wfs",
            typeName: "t",
            maxFeatures: "abc",
          }),
          deps,
        ),
      /max features/i,
    );
    assert.equal(added.length, 0);
  });
});
