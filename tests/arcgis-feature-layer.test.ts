import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import {
  addArcGISLayer,
  refreshArcGISFeatureLayer,
  reloadArcGISViewportLayer,
  restoreArcGISViewportLayers,
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

// The same layer, advertising offset paging and an ObjectID field, so a viewport
// query is one page of features followed by an empty one.
const VIEWPORT_LAYER_INFO = {
  ...LAYER_INFO,
  objectIdField: "OBJECTID",
  advancedQueryCapabilities: { supportsPagination: true, supportsOrderBy: true },
};

function viewportFeature(objectId: number) {
  return {
    type: "Feature",
    id: objectId,
    geometry: { type: "Point", coordinates: [-157.8, 21.3] },
    properties: { OBJECTID: objectId, NAME: `City ${objectId}` },
  };
}

/**
 * A fake interactive map whose bounds the test can move, recording the
 * listeners the viewport loader attaches and detaches.
 */
function fakeViewportMap(initial: [number, number, number, number]) {
  let [west, south, east, north] = initial;
  const listeners = new Map<string, () => void>();
  const offCalls: Array<[string, () => void]> = [];
  const map = {
    getBounds: () => ({
      getWest: () => west,
      getSouth: () => south,
      getEast: () => east,
      getNorth: () => north,
    }),
    isMoving: () => false,
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    off: (event: string, listener: () => void) => {
      offCalls.push([event, listener]);
      listeners.delete(event);
    },
  };
  return {
    listeners,
    map,
    offCalls,
    setBounds: (next: [number, number, number, number]) => {
      [west, south, east, north] = next;
    },
  };
}

/** Let the loader's queued fetches and store writes settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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

  it("reassembles nested rings exported as separate ArcGIS polygons", async () => {
    const malformedMask = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { NAME: "Mask" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [
                [
                  [0, 0],
                  [0, 10],
                  [10, 10],
                  [10, 0],
                  [0, 0],
                ],
              ],
              [
                [
                  [2, 2],
                  [8, 2],
                  [8, 8],
                  [2, 8],
                  [2, 2],
                ],
              ],
              [
                [
                  [4, 4],
                  [4, 6],
                  [6, 6],
                  [6, 4],
                  [4, 4],
                ],
              ],
              [
                [
                  [9, 1],
                  [12, 1],
                  [12, 4],
                  [9, 4],
                  [9, 1],
                ],
              ],
            ],
          },
        },
      ],
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return jsonResponse(url.includes("/query") ? malformedMask : LAYER_INFO);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });
    const geometry = useAppStore.getState().layers.find((layer) => layer.id === id)?.geojson
      ?.features[0].geometry;

    assert.equal(geometry?.type, "MultiPolygon");
    if (geometry?.type !== "MultiPolygon") return;
    assert.equal(
      geometry.coordinates.length,
      3,
      "the nested island and overlapping polygon remain separate polygons",
    );
    assert.equal(geometry.coordinates[0].length, 2, "the contained ring becomes a hole");
    assert.deepEqual(geometry.coordinates[1][0][0], [4, 4]);
  });

  it("leaves disjoint one-ring ArcGIS polygons unchanged", async () => {
    const disjointGeometry = {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [0, 0],
            [0, 2],
            [2, 2],
            [2, 0],
            [0, 0],
          ],
        ],
        [
          [
            [10, 10],
            [10, 12],
            [12, 12],
            [12, 10],
            [10, 10],
          ],
        ],
      ],
    };
    const response = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: disjointGeometry }],
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return jsonResponse(url.includes("/query") ? response : LAYER_INFO);
    }) as typeof fetch;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });

    assert.deepEqual(
      useAppStore.getState().layers.find((layer) => layer.id === id)?.geojson?.features[0].geometry,
      disjointGeometry,
    );
  });

  it("adds an interactive layer immediately and queries the current viewport", async () => {
    const requests: URL[] = [];
    // Only the first page of each viewport query is deferred, so the test can
    // settle them out of order; the follow-up page is empty and ends the walk.
    const pages: Array<(response: Response) => void> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) return jsonResponse(VIEWPORT_LAYER_INFO);
      if (Number(url.searchParams.get("resultOffset") ?? "0") > 0) {
        return jsonResponse({ type: "FeatureCollection", features: [] });
      }
      requests.push(url);
      return new Promise<Response>((resolve) => pages.push(resolve));
    }) as typeof fetch;

    const view = fakeViewportMap([144, -39, 146, -37]);
    app = {
      getMap: () => view.map,
      fitBounds: (bounds) => fitBoundsCalls.push(bounds),
    } as unknown as GeoLibreAppAPI;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });
    await settle();

    const initial = useAppStore.getState().layers.find((layer) => layer.id === id);
    assert.equal(initial?.geojson?.features.length, 0);
    assert.equal(initial?.metadata.viewportLoading, true);
    const move = view.listeners.get("moveend");
    assert.ok(move, "expected a moveend listener");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("geometry"), "144,-39,146,-37");
    assert.equal(requests[0].searchParams.get("geometryType"), "esriGeometryEnvelope");
    assert.equal(requests[0].searchParams.get("spatialRel"), "esriSpatialRelIntersects");

    // Pan before the first query lands: the replacement must query the new
    // extent, and the superseded response must not overwrite it.
    view.setBounds([150, -35, 152, -33]);
    move();
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get("geometry"), "150,-35,152,-33");

    pages[0](jsonResponse({ type: "FeatureCollection", features: [viewportFeature(1)] }));
    await settle();
    assert.equal(
      useAppStore.getState().layers.find((layer) => layer.id === id)?.geojson?.features.length,
      0,
      "the superseded viewport response must be discarded",
    );

    pages[1](jsonResponse({ type: "FeatureCollection", features: [viewportFeature(2)] }));
    await settle();
    const loaded = useAppStore.getState().layers.find((layer) => layer.id === id);
    assert.deepEqual(
      loaded?.geojson?.features.map((feature) => feature.properties?.OBJECTID),
      [2],
    );

    // Removing the layer detaches the listener it registered.
    useAppStore.getState().removeLayer(id);
    assert.deepEqual(view.offCalls, [["moveend", move]]);
  });

  it("ignores a superseded viewport query that fails for its own reasons", async () => {
    const rejections: Array<(error: Error) => void> = [];
    let pan = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) return jsonResponse(VIEWPORT_LAYER_INFO);
      const offset = Number(url.searchParams.get("resultOffset") ?? "0");
      if (offset > 0) return jsonResponse({ type: "FeatureCollection", features: [] });
      // The first query never resolves until the test rejects it by hand; the
      // replacement answers normally.
      if (pan) return jsonResponse({ type: "FeatureCollection", features: [viewportFeature(7)] });
      return new Promise<Response>((_resolve, reject) => rejections.push(reject));
    }) as typeof fetch;

    const view = fakeViewportMap([144, -39, 146, -37]);
    app = {
      getMap: () => view.map,
      fitBounds: (bounds) => fitBoundsCalls.push(bounds),
    } as unknown as GeoLibreAppAPI;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });
    await settle();

    pan = true;
    view.setBounds([150, -35, 152, -33]);
    view.listeners.get("moveend")?.();
    await settle();

    // A plain network failure, not an AbortError, landing after the pan.
    rejections[0](new Error("Connection reset"));
    await settle();

    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    assert.equal(
      layer?.connection?.lastError ?? null,
      null,
      "a stale failure must not be reported",
    );
    assert.equal(layer?.geojson?.features.length, 1);
  });

  it("records a failed viewport query on the layer connection and clears it", async () => {
    let fail = true;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) return jsonResponse(VIEWPORT_LAYER_INFO);
      if (fail) throw new Error("Network unreachable");
      const offset = Number(url.searchParams.get("resultOffset") ?? "0");
      return jsonResponse({
        type: "FeatureCollection",
        features: offset > 0 ? [] : [viewportFeature(1)],
      });
    }) as typeof fetch;

    const view = fakeViewportMap([144, -39, 146, -37]);
    app = {
      getMap: () => view.map,
      fitBounds: (bounds) => fitBoundsCalls.push(bounds),
    } as unknown as GeoLibreAppAPI;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });
    await settle();

    // The Layers panel renders this as its sync-error status line.
    assert.match(
      useAppStore.getState().layers.find((layer) => layer.id === id)?.connection?.lastError ?? "",
      /Network unreachable/,
    );

    fail = false;
    view.listeners.get("moveend")?.();
    await settle();
    const recovered = useAppStore.getState().layers.find((layer) => layer.id === id);
    assert.equal(recovered?.connection?.lastError, null);
    assert.equal(recovered?.geojson?.features.length, 1);
  });

  it("splits an antimeridian-crossing viewport into two envelopes", async () => {
    const geometries: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) return jsonResponse(VIEWPORT_LAYER_INFO);
      const offset = Number(url.searchParams.get("resultOffset") ?? "0");
      if (offset > 0) return jsonResponse({ type: "FeatureCollection", features: [] });
      geometries.push(url.searchParams.get("geometry") ?? "");
      // Both halves return the feature straddling the dateline.
      return jsonResponse({ type: "FeatureCollection", features: [viewportFeature(1)] });
    }) as typeof fetch;

    const view = fakeViewportMap([170, -20, -170, 20]);
    app = {
      getMap: () => view.map,
      fitBounds: (bounds) => fitBoundsCalls.push(bounds),
    } as unknown as GeoLibreAppAPI;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });
    await settle();

    // Clamping each edge on its own would have inverted this envelope into
    // `170,-20,-170,20`, which ArcGIS answers with nothing.
    assert.deepEqual([...geometries].sort(), ["-180,-20,-170,20", "170,-20,180,20"]);
    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    assert.equal(layer?.geojson?.features.length, 1, "the shared feature is published once");
  });

  // The exact body Vicmap_Parcel returns (with HTTP 200) when it exceeds its
  // own query timeout on a wide extent — it blames the parameters, which are
  // correct: the identical request succeeds on a retry (GeoLibre#1756).
  const TIMEOUT_ENVELOPE = {
    error: {
      code: 400,
      message: "",
      details: ["Unable to perform query. Please check your parameters."],
    },
  };

  /** Answers the first `failures` viewport queries with a service timeout. */
  function timingOutService(failures: number) {
    const state = { attempts: 0 };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) return jsonResponse(VIEWPORT_LAYER_INFO);
      if (Number(url.searchParams.get("resultOffset") ?? "0") > 0) {
        return jsonResponse({ type: "FeatureCollection", features: [] });
      }
      state.attempts += 1;
      return state.attempts <= failures
        ? jsonResponse(TIMEOUT_ENVELOPE)
        : jsonResponse({ type: "FeatureCollection", features: [viewportFeature(1)] });
    }) as typeof fetch;
    return state;
  }

  async function addViewportLayer(): Promise<string> {
    const view = fakeViewportMap([144, -39, 146, -37]);
    app = {
      getMap: () => view.map,
      fitBounds: (bounds) => fitBoundsCalls.push(bounds),
    } as unknown as GeoLibreAppAPI;
    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
    });
    await settle();
    return id;
  }

  it("retries a viewport query the service timed out on", async () => {
    const state = timingOutService(1);
    const id = await addViewportLayer();

    assert.equal(state.attempts, 2, "the timed-out query is retried once");
    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    assert.equal(layer?.geojson?.features.length, 1, "the retry's features are published");
    assert.equal(layer?.connection?.lastError ?? null, null, "a recovered query reports no error");
  });

  it("reports actionable guidance when the retry times out too", async () => {
    const state = timingOutService(Number.POSITIVE_INFINITY);
    const id = await addViewportLayer();

    assert.equal(state.attempts, 2, "retried once, not indefinitely");
    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    // Not ArcGIS's own "check your parameters", which sends the user nowhere.
    assert.match(
      layer?.connection?.lastError ?? "",
      /did not return features for this extent in time/,
    );
  });

  it("re-binds a reopened project's layer to the viewport", async () => {
    const geometries: string[] = [];
    let metadataFailures = 1;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) {
        // The first metadata read fails, as a flaky reopen would.
        if (metadataFailures > 0) {
          metadataFailures -= 1;
          throw new Error("Service unavailable");
        }
        return jsonResponse(VIEWPORT_LAYER_INFO);
      }
      const offset = Number(url.searchParams.get("resultOffset") ?? "0");
      if (offset > 0) return jsonResponse({ type: "FeatureCollection", features: [] });
      geometries.push(url.searchParams.get("geometry") ?? "");
      return jsonResponse({ type: "FeatureCollection", features: [viewportFeature(1)] });
    }) as typeof fetch;

    // A layer as a saved project restores it: viewport metadata and the stored
    // query URL, but no live loader.
    const id = useAppStore
      .getState()
      .addGeoJsonLayer("Restored", { type: "FeatureCollection", features: [] }, undefined, null);
    useAppStore.getState().updateLayer(id, {
      source: { type: "geojson", arcgisQueryUrl: `${SERVICE_URL}/query` },
      metadata: { sourceKind: "arcgis-feature-query", viewportLoading: true },
    });
    assert.equal(reloadArcGISViewportLayer(id), null, "no loader before the project is restored");

    const view = fakeViewportMap([144, -39, 146, -37]);
    restoreArcGISViewportLayers({ getMap: () => view.map } as unknown as GeoLibreAppAPI);
    // Registered before the metadata fetch is even started, so a refresh in
    // this window never finds the layer unbound.
    assert.ok(view.listeners.has("moveend"), "the loader binds synchronously");
    await settle();

    // The first query failed on metadata, which is reported, not swallowed.
    assert.match(
      useAppStore.getState().layers.find((layer) => layer.id === id)?.connection?.lastError ?? "",
      /Service unavailable/,
    );

    // The next pan retries the metadata rather than staying stuck.
    view.setBounds([150, -35, 152, -33]);
    view.listeners.get("moveend")?.();
    await settle();
    assert.deepEqual(geometries, ["150,-35,152,-33"]);
    const restored = useAppStore.getState().layers.find((layer) => layer.id === id);
    assert.equal(restored?.connection?.lastError, null);
    assert.equal(restored?.geojson?.features.length, 1);

    // Re-running the restore against a new map rebinds rather than skipping.
    const remounted = fakeViewportMap([10, 10, 12, 12]);
    restoreArcGISViewportLayers({ getMap: () => remounted.map } as unknown as GeoLibreAppAPI);
    await settle();
    assert.deepEqual(
      view.offCalls.map(([event]) => event),
      ["moveend"],
      "the loader detaches from the old map",
    );
    assert.ok(remounted.listeners.has("moveend"));
    assert.deepEqual(geometries, ["150,-35,152,-33", "10,10,12,12"]);

    // A refresh takes this same bounded path rather than the unbounded replay.
    const reloaded = await reloadArcGISViewportLayer(id);
    assert.equal(reloaded?.features.length, 1);
    assert.deepEqual(geometries, ["150,-35,152,-33", "10,10,12,12", "10,10,12,12"]);
  });

  it("holds a split viewport to maxFeatures across both envelopes", async () => {
    // Each half answers with the cap's worth of distinct features, so an
    // uncoordinated limit would leave the layer holding twice the maximum.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (!url.pathname.endsWith("/query")) return jsonResponse(VIEWPORT_LAYER_INFO);
      const offset = Number(url.searchParams.get("resultOffset") ?? "0");
      if (offset > 0) return jsonResponse({ type: "FeatureCollection", features: [] });
      const west = url.searchParams.get("geometry")?.startsWith("170") === true;
      return jsonResponse({
        type: "FeatureCollection",
        features: west
          ? [viewportFeature(1), viewportFeature(2)]
          : [viewportFeature(3), viewportFeature(4)],
      });
    }) as typeof fetch;

    const view = fakeViewportMap([170, -20, -170, 20]);
    app = {
      getMap: () => view.map,
      fitBounds: (bounds) => fitBoundsCalls.push(bounds),
    } as unknown as GeoLibreAppAPI;

    const id = await addArcGISLayer(app, {
      layerType: "feature",
      sourceType: "url",
      url: SERVICE_URL,
      maxFeatures: 2,
    });
    await settle();

    const layer = useAppStore.getState().layers.find((entry) => entry.id === id);
    assert.equal(layer?.geojson?.features.length, 2);
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
