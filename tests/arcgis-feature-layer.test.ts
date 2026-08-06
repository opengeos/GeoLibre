import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  addArcGISLayer,
  refreshArcGISFeatureLayer,
} from "../packages/plugins/src/plugins/arcgis-layer";

// Minimal ArcGIS FeatureServer layer metadata (the `?f=json` response) with a
// geographic extent so the bounds resolve without Web Mercator reprojection,
// and a copyrightText so the attribution propagation can be asserted.
const LAYER_INFO = {
  name: "USA Major Cities",
  geometryType: "esriGeometryPoint",
  copyrightText: "© Example City Data",
  extent: {
    xmin: -160,
    ymin: 18,
    xmax: -154,
    ymax: 23,
    spatialReference: { wkid: 4326 },
  },
};

// The `/query?f=geojson` response — features carry the attributes that the label
// field picker (and attribute table) read once the layer is a GeoJSON layer.
const QUERY_GEOJSON = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-157.8, 21.3] },
      properties: { NAME: "Honolulu", POPULATION: 350000 },
    },
  ],
};

// addArcGISLayer reads layer metadata via `response.json()` and query results via
// `response.text()` (it guards against HTML before parsing), so a mock response
// must answer both. `raw` overrides the text body (for the HTML-page case).
function jsonResponse(body: unknown, raw?: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => raw ?? JSON.stringify(body),
  } as Response;
}

/** Routes the two ArcGIS requests by URL: the query endpoint returns GeoJSON. */
function makeArcGISFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return jsonResponse(url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO);
  }) as typeof fetch;
}

const SERVICE_URL = "https://example.com/arcgis/rest/services/Cities/FeatureServer/0";

interface FakeArcGISServiceOptions {
  /** The per-query ceiling the service actually enforces. */
  maxRecordCount: number;
  /**
   * Drop `maxRecordCount` from the layer metadata while still enforcing it.
   * Real services do this, and it is what lets the caller's page size exceed
   * the cap the service will honor.
   */
  hideMaxRecordCount?: boolean;
  /**
   * Refuse `returnCountOnly`, as a service with statistics disabled does. The
   * walk then has no total to measure its result against.
   */
  hideCount?: boolean;
  /** Whether `resultOffset` is actually honored (false replays page one). */
  honorsOffset?: boolean;
  /** Whether the layer advertises `advancedQueryCapabilities.supportsPagination`. */
  supportsPagination?: boolean;
  /** Feature count the service holds. */
  total: number;
}

/**
 * A fake ArcGIS FeatureServer layer that behaves like a real one: it caps each
 * page at `maxRecordCount`, flags `exceededTransferLimit`, and answers
 * `returnCountOnly`/`returnIdsOnly`. Records what was asked of it so a test can
 * assert on the request pattern, not just the assembled result.
 */
function fakeArcGISService(config: FakeArcGISServiceOptions) {
  const { total, maxRecordCount } = config;
  const honorsOffset = config.honorsOffset !== false;
  const supportsPagination = config.supportsPagination !== false;
  const objectIds = Array.from({ length: total }, (_, index) => index + 1);
  const queries: string[] = [];
  const pageSizes: number[] = [];
  const objectIdRanges: Array<[number, number]> = [];

  const feature = (objectId: number) => ({
    type: "Feature" as const,
    id: objectId,
    geometry: { type: "Point" as const, coordinates: [-157.8, 21.3] },
    properties: { OBJECTID: objectId, NAME: `City ${objectId}` },
  });

  const layerInfo = {
    ...LAYER_INFO,
    maxRecordCount: config.hideMaxRecordCount ? undefined : maxRecordCount,
    objectIdField: "OBJECTID",
    advancedQueryCapabilities: { supportsPagination, supportsOrderBy: true },
  };

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (!url.pathname.endsWith("/query")) return jsonResponse(layerInfo);

    const params = url.searchParams;
    if (params.get("returnCountOnly") === "true") {
      return config.hideCount ? jsonResponse({}) : jsonResponse({ count: total });
    }
    if (params.get("returnIdsOnly") === "true") {
      return jsonResponse({ objectIdFieldName: "OBJECTID", objectIds });
    }

    queries.push(url.toString());

    // ObjectID-range paging: `OBJECTID >= a AND OBJECTID <= b`.
    const range = /OBJECTID >= (\d+) AND OBJECTID <= (\d+)/.exec(params.get("where") ?? "");
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      objectIdRanges.push([from, to]);
      const selected = objectIds.filter((id) => id >= from && id <= to).slice(0, maxRecordCount);
      return jsonResponse({
        type: "FeatureCollection",
        features: selected.map(feature),
        exceededTransferLimit: selected.length < to - from + 1,
      });
    }

    // resultOffset/resultRecordCount paging.
    const requested = Number(params.get("resultRecordCount") ?? total);
    pageSizes.push(requested);
    const offset = honorsOffset ? Number(params.get("resultOffset") ?? 0) : 0;
    const size = Math.min(requested, maxRecordCount);
    const selected = objectIds.slice(offset, offset + size);
    return jsonResponse({
      type: "FeatureCollection",
      features: selected.map(feature),
      // Real services report the cap in the GeoJSON `properties` bag.
      properties: { exceededTransferLimit: offset + selected.length < total },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, objectIds, objectIdRanges, pageSizes, queries };
}

/** Collect `console.warn` output for the duration of a test. */
function captureWarnings() {
  const messages: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.warn = originalWarn;
    },
  };
}

describe("addArcGISLayer (feature layer)", () => {
  let fitBoundsCalls: Array<[number, number, number, number]>;
  let app: GeoLibreAppAPI;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    useAppStore.getState().newProject({ name: "ArcGIS" });
    useAppStore.temporal.getState().clear();
    fitBoundsCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = makeArcGISFetch();
    app = {
      // The feature path never touches the map; only fitBounds is exercised.
      getMap: () => null,
      fitBounds: (bounds) => {
        fitBoundsCalls.push(bounds);
      },
    } as unknown as GeoLibreAppAPI;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads a feature layer as a GeoJSON layer with its attributes intact", async () => {
    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      name: "Cities",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, "expected the feature layer to be added to the store");
    // A plain GeoJSON layer (not an opaque external-native "arcgis" layer) is
    // what unlocks labels, the attribute table, identify, and symbology.
    assert.equal(layer.type, "geojson");
    assert.notEqual(layer.metadata.externalNativeLayer, true);
    assert.equal(layer.geojson?.features.length, 1);
    // The attributes the label field picker reads must survive the round trip.
    assert.deepEqual(Object.keys(layer.geojson?.features[0]?.properties ?? {}), [
      "NAME",
      "POPULATION",
    ]);
    // The persisted source path is the GeoJSON query endpoint (so a refresh
    // re-fetches features), not the service-description base URL.
    assert.match(layer.sourcePath ?? "", /\/FeatureServer\/0\/query\?/);
    // The service copyright is carried into MapLibre's attribution control.
    assert.equal(layer.source.attribution, "© Example City Data");
    // The geographic extent is fitted directly (no Web Mercator conversion).
    assert.deepEqual(fitBoundsCalls, [[-160, 18, -154, 23]]);
  });

  it("never persists the access token in the refresh URL", async () => {
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchUrls.push(url);
      return jsonResponse(url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      token: "secret-token-123",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    // The token reaches the live request but must not be saved to the project.
    assert.ok(
      fetchUrls.some((url) => url.includes("token=secret-token-123")),
      "expected the query request to carry the token",
    );
    assert.doesNotMatch(layer?.sourcePath ?? "", /token=/);
  });

  it("rejects a non-GeoJSON query response instead of adding an empty layer", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/query")
        ? jsonResponse({ error: { message: "Token Required" } })
        : jsonResponse(LAYER_INFO);
    }) as typeof fetch;

    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      }),
      /Token Required/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  // ArcGIS routinely leaves `message` empty and puts the only useful text in
  // `details` — asking a hosted FeatureServer for a layer id it does not have
  // answers `{"code":400,"message":"","details":["The requested layer (layerId:
  // 0) was not found."]}`. Reporting the generic fallback instead hides the one
  // thing the user needs to correct.
  it("surfaces error `details` when the service leaves `message` empty", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        error: {
          code: 400,
          message: "",
          details: ["The requested layer (layerId: 0) was not found."],
        },
      })) as typeof fetch;

    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      }),
      /The requested layer \(layerId: 0\) was not found\./,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("rejects an HTML login page returned with a 200 status", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/query")
        ? jsonResponse(null, "<!DOCTYPE html><html><body>Sign in</body></html>")
        : jsonResponse(LAYER_INFO);
    }) as typeof fetch;

    await assert.rejects(
      addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      }),
      /HTML instead of GeoJSON/,
    );
    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("warns but still loads when the query exceeds the service record limit", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/query")
        ? jsonResponse({ ...QUERY_GEOJSON, exceededTransferLimit: true })
        : jsonResponse(LAYER_INFO);
    }) as typeof fetch;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const id = await addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: "https://example.com/arcgis/rest/services/Cities/FeatureServer/0",
      });
      // The partial dataset still loads — truncation must not block the layer.
      const layer = useAppStore.getState().layers.find((l) => l.id === id);
      assert.equal(layer?.geojson?.features.length, 1);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /truncated/i);
  });

  it("pages a large layer into many requests instead of one unbounded query", async () => {
    // The shape of GeoLibre#1745: a service that answers the unbounded
    // `where=1=1` query with a 500 but pages the same data back fine.
    const service = fakeArcGISService({ total: 2500, maxRecordCount: 50_000 });
    globalThis.fetch = service.fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.equal(layer?.geojson?.features.length, 2500);
    // Every ObjectID exactly once — no page overlapped or was skipped.
    const ids = layer?.geojson?.features.map((feature) => feature.id) ?? [];
    assert.deepEqual(ids, service.objectIds);
    // The default page size is used rather than the service's 50000 ceiling,
    // which is the ceiling that makes these services fall over. The third
    // request asks for a full page too and simply gets a short one back, which
    // is how the walk learns it has reached the end.
    assert.deepEqual(service.pageSizes, [1000, 1000, 1000]);
    // Paging is ordered by the ObjectID field so pages cannot drift.
    assert.ok(service.queries.every((url) => url.includes("orderByFields=OBJECTID")));
    // The unbounded single-shot query is never sent.
    assert.ok(service.queries.every((url) => url.includes("resultRecordCount=")));
  });

  it("holds the page size under the service's maxRecordCount", async () => {
    const service = fakeArcGISService({ total: 300, maxRecordCount: 100 });
    globalThis.fetch = service.fetch;

    await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
      // Asking for more than the service will return would make a capped page
      // look like the last one and silently drop the rest of the layer.
      pageSize: 5000,
    });

    assert.deepEqual(service.pageSizes, [100, 100, 100]);
    assert.equal(
      useAppStore.getState().layers[0]?.geojson?.features.length,
      300,
      "expected the whole layer despite the oversized page request",
    );
  });

  it("uses a caller-supplied page size and reports progress per page", async () => {
    const service = fakeArcGISService({ total: 250, maxRecordCount: 2000 });
    globalThis.fetch = service.fetch;
    const progress: Array<[number, number | null]> = [];

    await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
      pageSize: 100,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });

    assert.deepEqual(service.pageSizes, [100, 100, 100]);
    // The running count carries the service's own total, so the Add Data dialog
    // can show "Loaded 200 of 250" rather than an inert spinner.
    assert.deepEqual(progress, [
      [100, 250],
      [200, 250],
      [250, 250],
    ]);
  });

  it("stops at maxFeatures and warns that the layer is partial", async () => {
    const service = fakeArcGISService({ total: 5000, maxRecordCount: 2000 });
    globalThis.fetch = service.fetch;

    const warnings = captureWarnings();
    let id: string;
    try {
      id = await addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: SERVICE_URL,
        pageSize: 400,
        maxFeatures: 900,
      });
    } finally {
      warnings.restore();
    }

    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === id)?.geojson?.features.length,
      900,
    );
    // The final page is trimmed to the cap rather than overshooting it.
    assert.deepEqual(service.pageSizes, [400, 400, 100]);
    assert.match(warnings.messages.join("\n"), /maximum of 900 features/);
  });

  it("walks ObjectIDs when the service does not support resultOffset paging", async () => {
    const service = fakeArcGISService({
      total: 250,
      maxRecordCount: 100,
      supportsPagination: false,
    });
    globalThis.fetch = service.fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });

    assert.equal(
      useAppStore.getState().layers.find((l) => l.id === id)?.geojson?.features.length,
      250,
    );
    // ObjectID ranges, not resultOffset — this is the path older ArcGIS Server
    // deployments need.
    assert.ok(service.queries.every((url) => !url.includes("resultOffset=")));
    assert.deepEqual(service.objectIdRanges, [
      [1, 100],
      [101, 200],
      [201, 250],
    ]);
  });

  // The ObjectID walk consumes ids by advancing past the requested range, so a
  // page the service caps below that range would drop the ids it did not
  // return. Reachable whenever the page size exceeds the service's real cap,
  // which is what happens when the metadata omits `maxRecordCount`.
  it("re-requests a smaller ObjectID range when the service caps the page", async () => {
    const service = fakeArcGISService({
      total: 700,
      maxRecordCount: 250,
      hideMaxRecordCount: true,
      supportsPagination: false,
    });
    globalThis.fetch = service.fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });

    const features =
      useAppStore.getState().layers.find((l) => l.id === id)?.geojson?.features ?? [];
    assert.equal(features.length, 700, "expected no ObjectID to be skipped");
    assert.deepEqual(
      features.map((feature) => feature.id),
      service.objectIds,
    );
    // The oversized first range is retried at the cap the service revealed,
    // then the walk proceeds in 250-id steps.
    assert.deepEqual(service.objectIdRanges, [
      [1, 700],
      [1, 250],
      [251, 500],
      [501, 700],
    ]);
  });

  // The page guard stops the ObjectID walk with ids still unread. A service
  // that will not answer `returnCountOnly` leaves no total to compare against,
  // so without the guard reporting truncation the short layer looks complete.
  it("reports truncation when the page guard stops the ObjectID walk", async () => {
    // MAX_ARCGIS_PAGES (5000) pages of one id each, against 5001 ids.
    const service = fakeArcGISService({
      total: 5001,
      maxRecordCount: 1,
      supportsPagination: false,
      hideCount: true,
    });
    globalThis.fetch = service.fetch;

    const warnings = captureWarnings();
    let id: string;
    try {
      id = await addArcGISLayer(app, {
        layerType: "feature",
        sourceType: "url",
        url: SERVICE_URL,
      });
    } finally {
      warnings.restore();
    }

    const features =
      useAppStore.getState().layers.find((l) => l.id === id)?.geojson?.features ?? [];
    assert.equal(features.length, 5000, "expected the walk to stop at the page guard");
    assert.match(warnings.messages.join("\n"), /truncated: loaded 5000 features/);
  });

  it("falls back to ObjectIDs when a service advertises paging it ignores", async () => {
    // Advertises supportsPagination but replays page one for every offset —
    // without detection that loops forever over the same rows.
    const service = fakeArcGISService({ total: 250, maxRecordCount: 100, honorsOffset: false });
    globalThis.fetch = service.fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });

    const features =
      useAppStore.getState().layers.find((l) => l.id === id)?.geojson?.features ?? [];
    assert.equal(features.length, 250);
    assert.deepEqual(
      features.map((feature) => feature.id),
      service.objectIds,
      "expected the ObjectID walk to assemble the layer without duplicates",
    );
    // Two offset pages were tried before the replay was spotted.
    assert.equal(service.queries.filter((url) => url.includes("resultOffset=")).length, 2);
  });

  // A refresh that re-fetched the stored `sourcePath` would send the unbounded
  // `where=1=1` query — exactly the request paging exists to avoid — and shrink
  // the layer to whatever one page the service happens to return.
  it("stores what a refresh needs to replay the paged download", async () => {
    const service = fakeArcGISService({ total: 2500, maxRecordCount: 1000 });
    globalThis.fetch = service.fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
      pageSize: 400,
      maxFeatures: 1600,
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.equal(layer?.metadata.sourceKind, "arcgis-feature-query");
    assert.equal(layer?.source.arcgisQueryUrl, `${SERVICE_URL}/query`);
    assert.equal(layer?.source.pageSize, 400);
    assert.equal(layer?.source.maxFeatures, 1600);
    // The token must still stay out of everything that gets saved.
    assert.equal(layer?.source.token, undefined);

    // Replaying from exactly those stored values reproduces the same layer.
    const replayed = await refreshArcGISFeatureLayer({
      queryUrl: String(layer?.source.arcgisQueryUrl),
      pageSize: Number(layer?.source.pageSize),
      maxFeatures: Number(layer?.source.maxFeatures),
    });
    assert.equal(replayed.features.length, 1600);
  });

  it("resolves a portal-item feature layer through the portal item URL", async () => {
    const serviceUrl = "https://example.com/arcgis/rest/services/Cities/FeatureServer/0";
    const fetchUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchUrls.push(url);
      if (url.includes("/content/items/")) {
        return jsonResponse({ url: serviceUrl });
      }
      return jsonResponse(url.includes("/query") ? QUERY_GEOJSON : LAYER_INFO);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "portal-item",
      itemId: "abc123def456",
      name: "Cities",
    });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer, "expected the portal-item feature layer to be added");
    assert.equal(layer.type, "geojson");
    assert.equal(layer.geojson?.features.length, 1);
    assert.deepEqual(fitBoundsCalls, [[-160, 18, -154, 23]]);
    // Assert the portal path was genuinely walked: the item metadata lookup and
    // a query against the resolved service URL both happened.
    assert.ok(
      fetchUrls.some((url) => url.includes("/content/items/abc123def456")),
      "expected portal item metadata to be fetched",
    );
    assert.ok(
      fetchUrls.some((url) => url.startsWith(`${serviceUrl}/query`)),
      "expected the resolved service URL to be queried",
    );
  });
});
