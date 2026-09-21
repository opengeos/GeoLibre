import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import {
  GODS_EYE_VIEW_CABLES_FLAG,
  GODS_EYE_VIEW_BIKE_SHARE_FLAG,
  GODS_EYE_VIEW_DAMS_FLAG,
  GODS_EYE_VIEW_DATACENTERS_FLAG,
  GODS_EYE_VIEW_DENSE_SATELLITES_FLAG,
  GODS_EYE_VIEW_OSM_INFRASTRUCTURE_FLAG,
  GODS_EYE_VIEW_RADIO_FLAG,
  GODS_EYE_VIEW_SPACE_MISSIONS_FLAG,
  GODS_EYE_VIEW_STREET_TRAFFIC_FLAG,
  GODS_EYE_VIEW_MAPPED_ALPR_FLAG,
  GODS_EYE_VIEW_FLIGHTS_FLAG,
  GODS_EYE_VIEW_MILITARY_FLIGHTS_FLAG,
  godsEyeViewPlugin,
  reattachGodsEyeView,
} from "../packages/plugins/src/plugins/gods-eye-view";
import { isPluginEngineSupported, type GeoLibreAppAPI } from "../packages/plugins/src/types";

// The plugin's reattach path (issue #2462). `CesiumEngine.getCesiumScene()`
// mints a brand-new handle object on every call, and the host re-runs the
// reattach on every project load — so a guard that compares handles instead of
// viewers never short-circuits, and each load silently re-fetches both public
// feeds and re-takes the clock. These drive it against a fake that reproduces
// the fresh-object-per-call shape.

const originalDocument = globalThis.document;
afterEach(() => {
  globalThis.document = originalDocument;
});

/** A Cesium widget reduced to what the plugin reads, behind a fresh handle. */
function makeGlobe(startingMultiplier = 0) {
  const points: Array<Record<string, unknown>> = [];
  class PointPrimitiveCollection {
    show = true;
    private readonly values: Array<Record<string, unknown>> = [];
    get length() {
      return this.values.length;
    }
    add(options: Record<string, unknown>) {
      const point = { ...options };
      this.values.push(point);
      points.push(point);
      return point;
    }
    get(index: number) {
      return this.values[index];
    }
  }
  class Cartesian3 {
    constructor(public x: number, public y: number, public z: number) {}
  }
  class NearFarScalar {
    constructor(
      public near: number,
      public nearValue: number,
      public far: number,
      public farValue: number,
    ) {}
  }
  let moveEndListener: (() => void) | null = null;
  let viewBounds: [number, number, number, number] = [-122.5, 37.7, -122.4, 37.8];
  const viewer = {
    id: "viewer",
    camera: {
      moveEnd: {
        addEventListener(callback: () => void) {
          moveEndListener = callback;
          return () => {
            if (moveEndListener === callback) moveEndListener = null;
          };
        },
      },
    },
    clock: {
      shouldAnimate: false,
      multiplier: startingMultiplier,
      startTime: null as number | null,
      stopTime: null as number | null,
      currentTime: null as number | null,
    },
  };
  // Julian dates reduced to epoch milliseconds: the plugin only sets the
  // window and compares the instant against its ends.
  const Cesium = {
    PointPrimitiveCollection,
    Cartesian3,
    NearFarScalar,
    Color: {
      fromCssColorString: (value: string) => ({
        value,
        withAlpha: (alpha: number) => ({ value, alpha }),
      }),
    },
    JulianDate: {
      fromDate: (date: Date) => date.getTime(),
      toDate: (value: number | Date) => (value instanceof Date ? value : new Date(value)),
      lessThan: (a: number, b: number) => a < b,
      greaterThan: (a: number, b: number) => a > b,
    },
  };
  let handles = 0;
  // The panel is plain DOM, so it renders only when the host calls `render`.
  const { document } = parseHTML('<html><body><div id="panel"></div></body></html>');
  const panel = document.getElementById("panel") as unknown as HTMLElement;
  const app = {
    getMap: () => null,
    getViewBounds: () => viewBounds,
    getCesiumScene: () => {
      handles += 1;
      return {
        Cesium,
        viewer,
        clock: viewer.clock,
        primary: true,
        scene: {
          primitives: { add: (value: unknown) => value, remove: () => true },
          preRender: { addEventListener: () => () => {} },
        },
        requestRender: () => {},
        registerMovingPointLayer: () => () => {},
      };
    },
    registerRightPanel: (options: { render: (container: HTMLElement) => () => void }) => {
      globalThis.document = document;
      options.render(panel);
      return () => {};
    },
    openRightPanel: () => {},
    onLocaleChange: () => () => {},
  } as unknown as GeoLibreAppAPI;
  return {
    app,
    viewer,
    panel,
    points,
    handleCount: () => handles,
    setViewBounds: (bounds: [number, number, number, number]) => {
      viewBounds = bounds;
    },
    fireMoveEnd: () => moveEndListener?.(),
  };
}

/** Count feed requests without touching the network; failures are expected. */
function stubFetch(): { calls: () => number; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("offline");
  }) as typeof fetch;
  console.warn = () => {};
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const TLE_TEXT = `ISS (ZARYA)
1 25544U 98067A   26262.50000000  .00016717  00000+0  30178-3 0  9991
2 25544  51.6400 120.0000 0005000  80.0000 280.0000 15.50000000400000
`;

const DENSE_TLE_TEXT = `STARLINK TEST
1 44713U 19074A   26262.50000000  .00001200  00000+0  90000-4 0  9991
2 44713  53.0500 210.0000 0001500  85.0000 275.0000 15.06000000300000
`;

/** Answer both public feeds with well-formed payloads, and count the calls. */
function stubFeeds(): { calls: () => string[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("earthquake.usgs.gov")) {
      return new Response(
        JSON.stringify({
          features: [
            {
              id: "q1",
              geometry: { type: "Point", coordinates: [10, 20, 5] },
              properties: { mag: 4, place: "Somewhere", time: Date.now() },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("radio-browser.info")) {
      return new Response(
        JSON.stringify([{ stationuuid: "radio-1", name: "Radio", geo_long: 10, geo_lat: 20 }]),
        { status: 200 },
      );
    }
    if (url.includes("datacenters.geojsonl")) {
      return new Response(
        JSON.stringify({
          type: "Feature",
          id: "dc-1",
          geometry: { type: "Point", coordinates: [10, 20] },
          properties: { name: "Datacenter" },
        }),
        { status: 200 },
      );
    }
    if (url.includes("/dams/")) {
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "dam-1",
              geometry: { type: "Point", coordinates: [10, 20] },
              properties: { name: "Dam" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("telegeography_submarine_cables")) {
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              id: "cable-1",
              geometry: {
                type: "LineString",
                coordinates: [
                  [10, 20],
                  [11, 21],
                ],
              },
              properties: { name: "Cable" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("tiles.geolibre.app/overpass")) {
      return new Response(
        JSON.stringify({
          elements: [
            {
              type: "node",
              id: 1,
              lon: 10,
              lat: 20,
              tags: { man_made: "tower" },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("launch-library/recent")) {
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "launch-1",
              name: "Launch",
              pad: { longitude: 10, latitude: 20 },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("station_information.json")) {
      return new Response(
        JSON.stringify({
          data: {
            stations: [{ station_id: "station-1", name: "Station", lon: 10, lat: 20 }],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("station_status.json")) {
      return new Response(
        JSON.stringify({
          data: {
            stations: [{ station_id: "station-1", num_bikes_available: 2 }],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes("opensky/states")) {
      return new Response(
        JSON.stringify({
          time: Date.now() / 1000,
          states: [
            [
              "abc123",
              "TEST",
              "US",
              null,
              Date.now() / 1000,
              10,
              20,
              1000,
              false,
              100,
              90,
              0,
              null,
              1100,
            ],
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("adsb-lol/military")) {
      return new Response(
        JSON.stringify({
          now: Date.now(),
          ac: [
            {
              hex: "ae1234",
              flight: "RCH1",
              lon: 10,
              lat: 20,
              alt_baro: 10000,
              gs: 200,
              track: 90,
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("adsbdb/aircraft")) {
      return new Response(JSON.stringify({ response: { aircraft: {} } }), {
        status: 200,
      });
    }
    return new Response(TLE_TEXT, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("God's Eye View availability", () => {
  it("can be opened on every renderer, so the globe-only note is reachable", () => {
    // `engines` gates whether the Plugins menu entry can be toggled at all. The
    // feeds draw on the globe alone, but a user on a 2D renderer has to be able
    // to open the panel to be told that.
    for (const engine of ["cesium", "maplibre", "mapbox", "arcgis"] as const) {
      assert.equal(isPluginEngineSupported(godsEyeViewPlugin, engine), true, engine);
    }
  });

  it("groups registered feeds in upstream panel order", () => {
    const net = stubFetch();
    const globe = makeGlobe();
    try {
      godsEyeViewPlugin.activate?.(globe.app);
      const sections = [
        ...globe.panel.querySelectorAll<HTMLElement>(".geolibre-gods-eye-view-feed-group"),
      ];
      assert.deepEqual(
        sections.map((section) => section.dataset.feedGroup),
        ["movement", "cameras", "infrastructure", "events", "utilities"],
      );
      assert.deepEqual(
        sections.map((section) => [
          section.querySelector("h3")?.textContent,
          [...section.querySelectorAll<HTMLElement>("[data-feed-id]")].map(
            (row) => row.dataset.feedId,
          ),
        ]),
        [
          ["Movement", ["flights", "militaryFlights", "satellites", "bikeShare", "streetTraffic"]],
          ["Cameras", ["mappedAlpr"]],
          ["Infrastructure", ["osmInfrastructure", "datacenters", "cables", "dams"]],
          ["Events", ["earthquakes", "spaceMissions"]],
          ["Utilities", ["radio"]],
        ],
      );
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      net.restore();
    }
  });
});

describe("God's Eye View feed refresh", () => {
  it("dispatches every Tier A feed with identity and attribution", async () => {
    const net = stubFeeds();
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
        radio: true,
        datacenters: true,
        dams: true,
        cables: true,
        osmInfrastructure: true,
        bikeShare: true,
        spaceMissions: true,
        streetTraffic: true,
        mappedAlpr: true,
        flights: true,
        militaryFlights: true,
      });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 20; i++) await flush();

      const layers = useAppStore.getState().layers;
      assert.deepEqual(
        layers.map((layer) => layer.metadata.godsEyeViewFeed).sort(),
        [
          "bikeShare",
          "cables",
          "dams",
          "datacenters",
          "earthquakes",
          "osmInfrastructure",
          "radio",
          "satellites",
          "spaceMissions",
          "streetTraffic",
          "mappedAlpr",
          "flights",
          "militaryFlights",
        ].sort(),
      );
      for (const layer of layers) assert.ok(layer.source.attribution, layer.name);
      const flags = [
        GODS_EYE_VIEW_RADIO_FLAG,
        GODS_EYE_VIEW_DATACENTERS_FLAG,
        GODS_EYE_VIEW_DAMS_FLAG,
        GODS_EYE_VIEW_CABLES_FLAG,
        GODS_EYE_VIEW_OSM_INFRASTRUCTURE_FLAG,
        GODS_EYE_VIEW_BIKE_SHARE_FLAG,
        GODS_EYE_VIEW_SPACE_MISSIONS_FLAG,
        GODS_EYE_VIEW_STREET_TRAFFIC_FLAG,
        GODS_EYE_VIEW_MAPPED_ALPR_FLAG,
        GODS_EYE_VIEW_FLIGHTS_FLAG,
        GODS_EYE_VIEW_MILITARY_FLIGHTS_FLAG,
      ];
      for (const flag of flags) {
        assert.ok(
          layers.some((layer) => layer.metadata[flag] === true),
          flag,
        );
      }
      const calls = net.calls().join("\n");
      for (const source of [
        "radio-browser.info",
        "datacenters.geojsonl",
        "/dams/",
        "telegeography_submarine_cables",
        "tiles.geolibre.app/overpass",
        "launch-library/recent",
        "station_information.json",
        "opensky/states",
        "adsb-lol/military",
      ]) {
        assert.ok(calls.includes(source), source);
      }
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("publishes the dense shell as a separate queryable layer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("earthquake.usgs.gov"))
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      return new Response(url.endsWith("/starlink") ? DENSE_TLE_TEXT : TLE_TEXT, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as typeof fetch;
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
        dense: true,
      });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 20; i++) await flush();

      const dense = useAppStore
        .getState()
        .layers.find((layer) => layer.metadata?.[GODS_EYE_VIEW_DENSE_SATELLITES_FLAG] === true);
      assert.ok(dense, "dense satellites have their own layer-panel entry");
      assert.equal(dense.geojson?.features.length, 1, "its Attribute Table has one row per point");
      assert.equal(dense.geojson?.features[0].properties?.catalogNumber, "44713");
      assert.equal(
        (globe.points[0]?.id as { geolibreLayerId?: string }).geolibreLayerId,
        dense.id,
        "the moving primitive picks back to the queryable layer",
      );
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      useAppStore.setState({ layers: [] });
      globalThis.fetch = originalFetch;
    }
  });

  it("says so when a feed times out", async () => {
    const net = stubFetch();
    const globe = makeGlobe();
    try {
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 6; i++) await flush();
      // The timeout watchdog aborts the very request whose generation still
      // matches, so an `aborted` guard here used to swallow the one failure
      // worth reporting and leave the panel on its stale timestamp.
      assert.match(globe.panel.textContent ?? "", /Update failed/);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      net.restore();
    }
  });

  it("adopts the loaded project's own feed layer instead of duplicating it", async () => {
    const net = stubFeeds();
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 8; i++) await flush();
      const first = useAppStore.getState().layers;
      assert.equal(first.length, 2, "one layer per feed");

      // A project switch replaces the store's layers wholesale while the plugin
      // stays active, so the remembered layer ids now point at nothing.
      const carried = first.map((layer) => ({
        ...layer,
        id: `${layer.id}-from-project-b`,
      }));
      useAppStore.setState({ layers: carried });
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
      });
      for (let i = 0; i < 8; i++) await flush();

      const after = useAppStore.getState().layers;
      assert.equal(after.length, 2, "the project's own layers are adopted, not duplicated");
      assert.deepEqual(
        after.map((layer) => layer.id).sort(),
        carried.map((layer) => layer.id).sort(),
      );
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("rebuilds a feed toggled off and on, however recently it was fetched", async () => {
    const net = stubFeeds();
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 8; i++) await flush();
      assert.equal(useAppStore.getState().layers.length, 2);

      // Switching off removes the layers, so the interval must not then spare
      // the fetch that would rebuild them — recent data nobody can see is no
      // data at all.
      godsEyeViewPlugin.deactivate?.(globe.app);
      assert.equal(useAppStore.getState().layers.length, 0);
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 8; i++) await flush();
      assert.equal(useAppStore.getState().layers.length, 2);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("moves the clock window forward with each refresh", async () => {
    const net = stubFeeds();
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      const before = Date.now();
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 8; i++) await flush();

      // The globe's own clock election only ever reads the first document for a
      // given layer id, so without this the feed would loop a stale window —
      // at 600x, back to a three-hour-old start every eighteen seconds.
      const { startTime, stopTime, currentTime } = globe.viewer.clock;
      assert.ok(typeof startTime === "number" && startTime >= before);
      assert.ok(typeof stopTime === "number" && stopTime > startTime);
      assert.ok(typeof currentTime === "number" && currentTime >= startTime);

      // An instant that ran off the end of the old window is reclaimed.
      globe.viewer.clock.currentTime = (stopTime as number) + 60_000;
      const checkbox = globe.panel.querySelector(
        '[data-feed-id="satellites"] input[type=checkbox]',
      ) as HTMLInputElement;
      checkbox.checked = false;
      checkbox.dispatchEvent(new (globe.panel.ownerDocument.defaultView as Window).Event("change"));
      const back = globe.panel.querySelector(
        '[data-feed-id="satellites"] input[type=checkbox]',
      ) as HTMLInputElement;
      back.checked = true;
      back.dispatchEvent(new (globe.panel.ownerDocument.defaultView as Window).Event("change"));
      for (let i = 0; i < 8; i++) await flush();
      const clock = globe.viewer.clock;
      assert.ok((clock.currentTime as number) <= (clock.stopTime as number));
      assert.ok((clock.currentTime as number) >= (clock.startTime as number));
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("gives the globe back the clock speed it had", async () => {
    const net = stubFeeds();
    const globe = makeGlobe(1);
    try {
      godsEyeViewPlugin.applyProjectState?.(globe.app, { speed: 600 });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 6; i++) await flush();
      assert.equal(globe.viewer.clock.multiplier, 600);

      // Leaving the globe at 600x would keep the Sun and the Time Slider racing
      // long after this panel is gone.
      godsEyeViewPlugin.deactivate?.(globe.app);
      assert.equal(globe.viewer.clock.multiplier, 1);
      assert.equal(globe.viewer.clock.shouldAnimate, false);
    } finally {
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("keeps the feed's rows out of a saved project, and rebuilds them on load", async () => {
    const net = stubFeeds();
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 8; i++) await flush();

      // `prepareLayerForSave` strips a layer's rows only when it says they are
      // transient; a catalogue's worth in every autosave would persist stale
      // positions and push the snapshot toward its ceiling.
      for (const layer of useAppStore.getState().layers) {
        assert.equal(layer.metadata.transientGeojson, true, layer.name);
        assert.equal(layer.metadata.transientCzml, true, layer.name);
        assert.ok(layer.geojson, "the live layer still carries its table");
      }

      // Reopening the project brings the layer back without those rows, so the
      // refresh interval must not spare the fetch that rebuilds them.
      const calls = net.calls().length;
      useAppStore.setState({
        layers: useAppStore.getState().layers.map(({ geojson: _dropped, ...rest }) => rest),
      });
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
      });
      for (let i = 0; i < 8; i++) await flush();
      assert.ok(net.calls().length > calls, "a stripped layer refetches");
      for (const layer of useAppStore.getState().layers) assert.ok(layer.geojson);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("does not re-read a feed it fetched moments ago", async () => {
    const net = stubFeeds();
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 8; i++) await flush();
      const afterActivate = net.calls().length;
      assert.ok(afterActivate > 0);

      // Every project load re-applies plugin state; CelesTrak asks not to be
      // re-read every few minutes, so a re-entry inside the interval is spared.
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
      });
      for (let i = 0; i < 8; i++) await flush();
      assert.equal(net.calls().length, afterActivate);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      useAppStore.setState({ layers: [] });
      net.restore();
    }
  });

  it("refreshes viewport feeds only after the camera enters a new snapped query cell", async () => {
    const originalFetch = globalThis.fetch;
    let overpassCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes("tiles.geolibre.app/overpass")) overpassCalls += 1;
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }) as typeof fetch;
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: false,
        satellites: false,
        mappedAlpr: true,
      });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let index = 0; index < 6; index += 1) await flush();
      assert.equal(overpassCalls, 1);

      globe.setViewBounds([-122.49, 37.71, -122.41, 37.79]);
      globe.fireMoveEnd();
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(overpassCalls, 1, "a move inside the snapped query cell reuses its result");

      globe.setViewBounds([-122.3, 37.7, -122.2, 37.8]);
      globe.fireMoveEnd();
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(overpassCalls, 2);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      useAppStore.setState({ layers: [] });
      globalThis.fetch = originalFetch;
    }
  });

  it("restores the current viewport when an intervening request is still in flight", async () => {
    const originalFetch = globalThis.fetch;
    let overpassCalls = 0;
    let resolveSecond: ((response: Response) => void) | null = null;
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (!String(input).includes("tiles.geolibre.app/overpass")) {
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }
      overpassCalls += 1;
      if (overpassCalls === 2) {
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      }
      return new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }) as typeof fetch;
    const globe = makeGlobe();
    try {
      useAppStore.setState({ layers: [] });
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: false,
        satellites: false,
        mappedAlpr: true,
      });
      godsEyeViewPlugin.activate?.(globe.app);
      for (let index = 0; index < 6; index += 1) await flush();
      assert.equal(overpassCalls, 1);

      globe.setViewBounds([-122.3, 37.7, -122.2, 37.8]);
      globe.fireMoveEnd();
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(overpassCalls, 2);

      globe.setViewBounds([-122.5, 37.7, -122.4, 37.8]);
      globe.fireMoveEnd();
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(overpassCalls, 3, "returning to A supersedes the pending B request");
      resolveSecond?.(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
      await flush();
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      useAppStore.setState({ layers: [] });
      globalThis.fetch = originalFetch;
    }
  });
});

describe("God's Eye View clock speed", () => {
  it("runs at real time by default and persists the chosen speed", async () => {
    const net = stubFetch();
    const globe = makeGlobe();
    try {
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      assert.deepEqual(godsEyeViewPlugin.getProjectState?.(), {
        flights: false,
        militaryFlights: false,
        earthquakes: true,
        spaceMissions: false,
        satellites: true,
        bikeShare: false,
        streetTraffic: false,
        mappedAlpr: false,
        radio: false,
        datacenters: false,
        dams: false,
        cables: false,
        osmInfrastructure: false,
        dense: false,
        // Real time, not the 60x the feeds used to hard-code: at 60x the ISS
        // laps the planet in ninety seconds, which reads as an animation
        // rather than as where the satellite is now.
        speed: 1,
      });

      godsEyeViewPlugin.activate?.(globe.app);
      for (let i = 0; i < 4; i++) await flush();
      assert.equal(globe.viewer.clock.multiplier, 1);
      assert.equal(
        globe.panel.querySelector('button[aria-label="Dense satellite catalog"]')?.textContent,
        "DENSE",
      );

      // The panel's select re-times the live globe without reloading a feed.
      const select = globe.panel.querySelector("select") as HTMLSelectElement;
      assert.deepEqual(
        [...select.options].map((option) => option.value),
        ["1", "10", "60", "600"],
      );
      assert.equal(select.value, "1");
      const afterActivate = net.calls();
      // linkedom's `select.value` is read-only, so pick the way a user does:
      // clear the current choice, then select the new one.
      for (const option of select.options) if (option.selected) option.selected = false;
      const sixty = [...select.options].find((option) => option.value === "60");
      assert.ok(sixty);
      sixty.selected = true;
      select.dispatchEvent(new (globe.panel.ownerDocument.defaultView as Window).Event("change"));
      // The panel re-renders on a setting change; the fresh select shows it.
      assert.equal((globe.panel.querySelector("select") as HTMLSelectElement).value, "60");
      assert.equal(globe.viewer.clock.multiplier, 60);
      assert.equal(net.calls(), afterActivate, "changing speed refetches nothing");
      assert.equal(godsEyeViewPlugin.getProjectState?.().speed, 60);

      // A project carrying a speed re-times a globe that is already running;
      // a hand-edited one carrying nonsense falls back to real time.
      godsEyeViewPlugin.applyProjectState?.(globe.app, {
        earthquakes: true,
        satellites: true,
        speed: 10,
      });
      assert.equal(globe.viewer.clock.multiplier, 10);
      godsEyeViewPlugin.applyProjectState?.(globe.app, { speed: 7 });
      assert.equal(globe.viewer.clock.multiplier, 1);
    } finally {
      godsEyeViewPlugin.deactivate?.(globe.app);
      godsEyeViewPlugin.applyProjectState?.(globe.app, {});
      net.restore();
    }
  });
});

describe("God's Eye View reattach", () => {
  it("re-binds on an engine swap and no-ops on a project load", async () => {
    const net = stubFetch();
    const first = makeGlobe();
    try {
      godsEyeViewPlugin.activate?.(first.app);
      for (let i = 0; i < 4; i++) await flush();
      const afterActivate = net.calls();
      assert.ok(afterActivate > 0, "activating on the globe loads the enabled feeds");
      assert.equal(first.viewer.clock.shouldAnimate, true);

      // The user paused the clock, then loaded a project: the handle is a new
      // object but the viewer is the same one, so nothing should restart.
      first.viewer.clock.shouldAnimate = false;
      reattachGodsEyeView(first.app);
      for (let i = 0; i < 4; i++) await flush();
      assert.equal(net.calls(), afterActivate, "an unchanged viewer re-fetches nothing");
      assert.equal(first.viewer.clock.shouldAnimate, false, "and does not override the pause");
      assert.ok(first.handleCount() > 1, "the fake mints a fresh handle per call, as Cesium does");

      // A renderer swap hands over a different viewer: that is a real rebind.
      const second = makeGlobe();
      reattachGodsEyeView(second.app);
      for (let i = 0; i < 4; i++) await flush();
      assert.ok(net.calls() > afterActivate, "a new viewer reloads the feeds");
      assert.equal(second.viewer.clock.shouldAnimate, true);

      godsEyeViewPlugin.deactivate?.(second.app);
      for (let i = 0; i < 4; i++) await flush();
    } finally {
      godsEyeViewPlugin.deactivate?.(first.app);
      net.restore();
    }
  });
});
