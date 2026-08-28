import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_STORY_MAP,
  createDefaultPrintLayout,
  createEmptyProject,
  createSampleStoryMap,
  normalizeModelGraph,
  parseProject,
  parseStoryMapCsv,
  parseStoryMapJson,
  applyProjectToStore,
  projectFromStore,
  serializeProject,
  serializeStoryMapCsv,
  serializeStoryMapJson,
  useAppStore,
} from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";

describe("project parsing", () => {
  it("round-trips a custom blank background color and defaults legacy projects", () => {
    const base = createEmptyProject("Blank background");
    const customized = parseProject(serializeProject({ ...base, blankBackgroundColor: "#1f2937" }));
    assert.equal(customized.blankBackgroundColor, "#1f2937");

    const legacy = { ...base };
    delete legacy.blankBackgroundColor;
    assert.equal(parseProject(serializeProject(legacy)).blankBackgroundColor, null);
    assert.equal(
      parseProject(serializeProject({ ...base, blankBackgroundColor: "not-a-color" }))
        .blankBackgroundColor,
      null,
    );
  });

  it("preserves a valid selected layer and drops a dangling selection", () => {
    const base = createEmptyProject("Selection");
    const layer = geojsonLayer({ id: "chosen" });
    const selected = parseProject(
      serializeProject({ ...base, layers: [layer], selectedLayerId: "chosen" }),
    );
    assert.equal(selected.selectedLayerId, "chosen");

    const dangling = parseProject(
      serializeProject({ ...base, layers: [layer], selectedLayerId: "missing" }),
    );
    assert.equal(dangling.selectedLayerId, undefined);
  });

  it("normalizes the selected layer on save as well as on load", () => {
    const layer = geojsonLayer({ id: "chosen" });
    const save = (selectedLayerId: string | null | undefined) =>
      parseProject(
        serializeProject(
          projectFromStore({
            projectName: "Selection",
            mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
            basemapStyleUrl: DEFAULT_BASEMAP,
            basemapVisible: true,
            basemapOpacity: 1,
            layers: [layer],
            selectedLayerId,
            preferences: createEmptyProject().preferences,
            metadata: {},
          }),
        ),
      );

    assert.equal(save("chosen").selectedLayerId, "chosen");
    assert.equal(save("missing").selectedLayerId, undefined);
    assert.equal(save(undefined).selectedLayerId, undefined);
    // An explicit null is a saved "nothing active", so it must survive the trip.
    assert.equal(save(null).selectedLayerId, null);
  });

  it("fills defaults while preserving valid project fields", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Loaded",
        mapView: { center: [1, 2], zoom: 3, bearing: 4, pitch: 5 },
        layers: [
          {
            id: "layer-a",
            name: "Layer A",
            type: "geojson",
            source: { type: "geojson" },
            style: { fillColor: "#ff0000" },
          },
        ],
        preferences: {
          map: {
            bounds: [-220, -90, 220, 90],
            minZoom: "bad",
            maxZoom: 18,
            maxPitch: 70,
            restrictBounds: true,
            renderWorldCopies: false,
          },
          environmentVariables: [
            { key: "VALID_KEY", value: "1", enabled: true },
            { key: "not valid", value: "2", enabled: true },
          ],
        },
        plugins: {
          manifestUrls: [
            "https://example.com/plugin.json",
            "http://localhost:3000/plugin.json",
            "http://example.com/insecure.json",
          ],
          activePluginIds: ["maplibre-gl-swipe", "maplibre-gl-swipe", ""],
          mapControlPositions: {
            "maplibre-gl-swipe": "top-left",
            bad: "center",
          },
          settings: {
            "maplibre-gl-swipe": { position: 50 },
            bad: undefined,
          },
        },
      }),
    );

    assert.equal(project.basemapStyleUrl, DEFAULT_BASEMAP);
    assert.equal(project.layers[0].visible, true);
    assert.equal(project.layers[0].opacity, 1);
    assert.equal(project.layers[0].style.fillColor, "#ff0000");
    assert.equal(project.layers[0].style.strokeColor, DEFAULT_LAYER_STYLE.strokeColor);
    assert.deepEqual(project.preferences.map.bounds, [-180, -85, 180, 85]);
    assert.equal(project.preferences.map.minZoom, 0);
    assert.equal(project.preferences.map.maxZoom, 18);
    assert.equal(project.preferences.map.renderWorldCopies, false);
    // Projects saved before projection was persisted default to globe.
    assert.equal(project.preferences.map.projection, "globe");
    assert.deepEqual(project.preferences.environmentVariables, [
      { key: "VALID_KEY", value: "1", enabled: true },
    ]);
    assert.deepEqual(project.plugins?.manifestUrls, [
      "https://example.com/plugin.json",
      "http://localhost:3000/plugin.json",
    ]);
    assert.deepEqual(project.plugins?.activePluginIds, ["maplibre-gl-swipe"]);
    assert.deepEqual(project.plugins?.mapControlPositions, {
      "maplibre-gl-swipe": "top-left",
    });
    assert.deepEqual(project.plugins?.settings, {
      "maplibre-gl-swipe": { position: 50 },
    });
  });

  it("round-trips the map projection preference", () => {
    const base = createEmptyProject("Projection");
    const mercator = {
      ...base,
      preferences: {
        ...base.preferences,
        map: { ...base.preferences.map, projection: "mercator" as const },
      },
    };
    const reloaded = parseProject(serializeProject(mercator));
    assert.equal(reloaded.preferences.map.projection, "mercator");
  });

  it("round-trips the scale unit preference and defaults unknown values to metric", () => {
    const base = createEmptyProject("Scale");
    assert.equal(base.preferences.map.scaleUnit, "metric");
    const imperial = {
      ...base,
      preferences: {
        ...base.preferences,
        map: { ...base.preferences.map, scaleUnit: "imperial" as const },
      },
    };
    const reloaded = parseProject(serializeProject(imperial));
    assert.equal(reloaded.preferences.map.scaleUnit, "imperial");
    // A hand-edited project with a bogus unit falls back to metric.
    const bogus = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Bogus",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        preferences: { map: { scaleUnit: "furlongs" } },
      }),
    );
    assert.equal(bogus.preferences.map.scaleUnit, "metric");
  });

  it("normalizes a legend config, dropping malformed overrides", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Legend",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        legend: {
          title: "My Legend",
          groupByLayer: false,
          order: ["a", "a", "b", 5],
          overrides: {
            a: { label: "Renamed", hidden: true },
            b: { hidden: "yes", label: 3 },
            c: { hidden: false },
            d: { label: "   " },
            "": { hidden: true },
          },
        },
      }),
    );
    assert.equal(project.legend?.title, "My Legend");
    assert.equal(project.legend?.groupByLayer, false);
    assert.deepEqual(project.legend?.order, ["a", "b"]);
    assert.deepEqual(project.legend?.overrides, { a: { label: "Renamed", hidden: true } });
  });

  it("keeps hand-authored legend item sizes and drops nonsensical ones", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Legend",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        legend: {
          title: "Legend",
          groupByLayer: true,
          order: [],
          overrides: {},
          customEntries: {
            a: {
              items: [
                { label: "Small", color: "#440154", shape: "circle", size: 4 },
                { label: "Huge", color: "#fde725", shape: "circle", size: 9e9 },
                { label: "Bad", color: "#000000", size: "big" },
                { label: "None", color: "#111111", size: 0 },
              ],
            },
          },
        },
      }),
    );
    assert.deepEqual(project.legend?.customEntries?.a.items, [
      { label: "Small", color: "#440154", shape: "circle", size: 4 },
      { label: "Huge", color: "#fde725", shape: "circle", size: 1000 },
      { label: "Bad", color: "#000000" },
      { label: "None", color: "#111111" },
    ]);
  });

  it("strips the transient per-feature filters when saving", () => {
    // `timeFilter` (Time Slider) and `embedFilter` (the embed API's runtime
    // `setFilter`, set by whatever host page framed the app) are both session
    // state, not project state. A leaked `embedFilter` would silently bake one
    // host's runtime filter into the shared `.geolibre.json` — the next person
    // to open it would see a filtered map with nothing in the UI explaining it.
    const layer = {
      ...geojsonLayer({ id: "roads" }),
      timeFilter: ["<=", ["get", "t"], 5],
      embedFilter: ["==", ["get", "kind"], "road"],
    } as unknown as Parameters<typeof projectFromStore>[0]["layers"][number];
    const project = projectFromStore({
      projectName: "Filters",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [layer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    const saved = project.layers[0] as Record<string, unknown>;
    assert.ok(!("timeFilter" in saved), "timeFilter must not be saved");
    assert.ok(!("embedFilter" in saved), "embedFilter must not be saved");
    // Everything else about the layer survives.
    assert.equal(saved.id, "roads");

    const reparsed = parseProject(serializeProject(project)).layers[0] as Record<string, unknown>;
    assert.ok(!("embedFilter" in reparsed));
  });

  it("keeps quick filters, which are project state rather than session state", () => {
    // The contrast with the test above is the point: `timeFilter`/`embedFilter`
    // are set at runtime by the Time Slider and the host page, but a quick
    // filter is something the author chose and expects to find again — and it
    // persists as control state, not as a compiled expression, so it can be
    // reopened and changed.
    const quickFilters = [
      { id: "qf-1", field: "state", kind: "categorical", values: ["OR", "WA"] },
      { id: "qf-2", field: "pop", kind: "range", min: 1000, max: null },
    ];
    const layer = {
      ...geojsonLayer({ id: "cities" }),
      quickFilters,
    } as unknown as Parameters<typeof projectFromStore>[0]["layers"][number];
    const project = projectFromStore({
      projectName: "Filters",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [layer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    const reparsed = parseProject(serializeProject(project)).layers[0] as Record<string, unknown>;
    assert.deepEqual(reparsed.quickFilters, quickFilters);
  });

  it("round-trips a legend config through projectFromStore", () => {
    const legend = {
      title: "Custom",
      groupByLayer: false,
      order: ["a"],
      overrides: { a: { label: "A renamed" } },
    };
    const project = projectFromStore({
      projectName: "Legend",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      legend,
      metadata: {},
    });
    assert.deepEqual(project.legend, legend);
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.legend, legend);
  });

  it("round-trips vector symbology style fields through projectFromStore", () => {
    const layer = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "rule-based",
        vectorRules: [
          {
            id: "1",
            label: "Parks",
            filter: '["==", ["get", "TYPE"], "park"]',
            color: "#00ff00",
            isElse: false,
          },
          { id: "e", label: "Else", filter: "", color: "#cccccc", isElse: true },
        ],
        proportionalSizeEnabled: true,
        proportionalSizeProperty: "pop",
        proportionalSizeMaxValue: 5000,
        fillPattern: "hatch",
        fillPatternColor: "#112233",
        markerEnabled: true,
        markerShape: "star",
        markerColor: "#ff8800",
        markerSize: 24,
      },
    });
    const project = projectFromStore({
      projectName: "Symbology",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [layer],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    const reparsed = parseProject(serializeProject(project));
    const style = reparsed.styles[layer.id];
    assert.equal(style.vectorStyleMode, "rule-based");
    assert.equal(style.vectorRules.length, 2);
    assert.equal(style.vectorRules[0].label, "Parks");
    assert.equal(style.vectorRules[0].filter, '["==", ["get", "TYPE"], "park"]');
    assert.equal(style.vectorRules[0].color, "#00ff00");
    assert.equal(style.vectorRules[0].isElse, false);
    assert.equal(style.vectorRules[1].isElse, true);
    assert.equal(style.proportionalSizeEnabled, true);
    assert.equal(style.proportionalSizeProperty, "pop");
    assert.equal(style.proportionalSizeMaxValue, 5000);
    assert.equal(style.fillPattern, "hatch");
    assert.equal(style.fillPatternColor, "#112233");
    assert.equal(style.markerEnabled, true);
    assert.equal(style.markerShape, "star");
    assert.equal(style.markerColor, "#ff8800");
    assert.equal(style.markerSize, 24);
  });

  it("round-trips saved processing models through projectFromStore", () => {
    const models = [
      {
        id: "model-1",
        name: "Buffer then centroids",
        steps: [
          {
            id: "step-1",
            toolId: "buffer",
            parameters: { layer: "roads", distance: 2, units: "kilometers" },
          },
          { id: "step-2", toolId: "centroids", parameters: {} },
        ],
      },
    ];
    const project = projectFromStore({
      projectName: "Models",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      models,
      metadata: {},
    });
    assert.deepEqual(project.models, models);
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.models, models);
  });

  it("drops invalid models and omits the key when none remain", () => {
    const project = projectFromStore({
      projectName: "Models",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      // Missing id / no usable steps: normalized away entirely.
      models: [{ id: "", name: "no id", steps: [] }] as never,
      metadata: {},
    });
    assert.equal("models" in project, false);
  });

  it("saves original XYZ tile templates instead of resolved URLs", () => {
    const project = projectFromStore({
      projectName: "Tiles",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [
        geojsonLayer({
          id: "xyz-a",
          type: "xyz",
          source: { url: "geolibre-xyz://resolved", tiles: ["geolibre-xyz://resolved"] },
          metadata: {
            originalUrl: "https://tiles.example.com/{z}/{x}/{y}.png",
            resolvedUrl: "geolibre-xyz://resolved",
          },
          geojson: undefined,
        }),
      ],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    assert.deepEqual(project.layers[0].source.tiles, ["https://tiles.example.com/{z}/{x}/{y}.png"]);
    assert.equal(project.layers[0].source.url, "https://tiles.example.com/{z}/{x}/{y}.png");
    assert.equal("resolvedUrl" in project.layers[0].metadata, false);
  });

  it("drops redundant geojson for external native layers restorable from a source URL", () => {
    const project = projectFromStore({
      projectName: "Native URL",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [
        geojsonLayer({
          id: "native-url",
          source: { type: "geojson", url: "https://example.com/data.geojson" },
          metadata: { externalNativeLayer: true },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [1, 2] },
              },
            ],
          },
        }),
      ],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    assert.equal(project.layers[0].geojson, undefined);
  });

  it("keeps geojson for external native layers without a restorable source URL", () => {
    const project = projectFromStore({
      projectName: "Native File",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [
        geojsonLayer({
          id: "native-file",
          source: { type: "geojson" },
          metadata: {
            externalNativeLayer: true,
            sourceKind: "plugin-control",
          },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [1, 2] },
              },
            ],
          },
        }),
      ],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    assert.ok(
      project.layers[0].geojson,
      "geojson is the only copy for a source-less native layer and must be retained",
    );
    assert.equal(project.layers[0].geojson?.features.length, 1);

    // The features must survive the full on-disk round-trip so the restore
    // path (ensureExternalGeoJsonNativeLayer) can re-render them on reopen.
    const reopened = parseProject(serializeProject(project));
    assert.equal(reopened.layers[0].geojson?.features.length, 1);
  });

  it("drops geojson for Add Vector Layer (maplibre-gl-vector) local-file layers", () => {
    // These layers restore via the control (file path on desktop, embedded
    // GeoJSON on the web), not from `geojson` — which is only the attribute
    // table's copy. Persisting it would silently embed the dataset and bypass
    // the web embed prompt, so it must be stripped even without a source URL.
    const project = projectFromStore({
      projectName: "Add Vector Layer file",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [
        geojsonLayer({
          id: "vector-file",
          source: { type: "geojson" },
          sourcePath: "/home/user/data/buildings.gpkg",
          metadata: {
            externalNativeLayer: true,
            sourceKind: "maplibre-gl-vector",
            localFileReloadable: true,
          },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [1, 2] },
              },
            ],
          },
        }),
      ],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    assert.equal(project.layers[0].geojson, undefined);
    // The reload path is preserved so the layer still restores on reopen.
    assert.equal(project.layers[0].sourcePath, "/home/user/data/buildings.gpkg");
  });

  it("drops geojson for a plain local-file layer flagged localFileReloadable", () => {
    // A drag-dropped or Add Data desktop layer whose absolute path was captured:
    // the data is re-read from disk on reopen, so it must not be embedded.
    const project = projectFromStore({
      projectName: "Dropped file",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [
        geojsonLayer({
          id: "dropped",
          source: { type: "geojson" },
          sourcePath: "/home/user/data/cities.geojson",
          metadata: { localFileReloadable: true },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [1, 2] },
              },
            ],
          },
        }),
      ],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    assert.equal(project.layers[0].geojson, undefined);
    assert.equal(project.layers[0].sourcePath, "/home/user/data/cities.geojson");
    assert.equal(project.layers[0].metadata.localFileReloadable, true);
  });
});

describe("project serialization", () => {
  /** A layer whose features carry enough coordinates to show the whitespace cost. */
  const featureRichLayer = () =>
    geojsonLayer({
      id: "cities",
      geojson: {
        type: "FeatureCollection",
        features: Array.from({ length: 200 }, (_, index) => ({
          type: "Feature" as const,
          properties: { name: `City ${index}` },
          geometry: {
            type: "LineString" as const,
            coordinates: Array.from(
              { length: 20 },
              (_, point) => [index / 10 + point, point / 10] as [number, number],
            ),
          },
        })),
      },
    });

  it("writes embedded GeoJSON compactly while indenting the project structure", () => {
    const project = createEmptyProject("Compact");
    project.layers = [featureRichLayer()];
    const text = serializeProject(project);

    // The structure stays readable...
    assert.match(text, /^\{\n {2}"version":/);
    assert.match(text, /\n {2}"layers": \[\n {4}\{\n {6}"id": "cities",/);
    // ...but the whole feature collection sits on one line, so no coordinate
    // ever gets its own line of indentation (GeoLibre#1829).
    assert.match(
      text,
      /\n {6}"geojson": \{"type":"FeatureCollection","features":\[\{"type":"Feature"/,
    );
    assert.ok(!text.includes('"coordinates": ['), "coordinate arrays must not be pretty-printed");
  });

  it("compacts an embedded GeoJSON copy held in layer metadata", () => {
    const project = createEmptyProject("Embedded");
    const { geojson, ...layer } = featureRichLayer();
    project.layers = [{ ...layer, metadata: { embeddedGeoJSON: geojson } }];
    const text = serializeProject(project);

    assert.match(text, /"embeddedGeoJSON": \{"type":"FeatureCollection"/);
    assert.ok(!text.includes('"coordinates": ['));
  });

  it("keeps a feature-heavy project within a few percent of a fully minified file", () => {
    const project = createEmptyProject("Sized");
    project.layers = [featureRichLayer()];
    const minified = JSON.stringify(project).length;

    // Pretty-printing every coordinate used to cost more than 3x; the structure
    // that stays indented is a rounding error next to the feature data.
    assert.ok(
      serializeProject(project).length < minified * 1.05,
      "serialized project should be close to the minified size",
    );
  });

  it("formats a project without GeoJSON exactly as JSON.stringify does", () => {
    const project = createEmptyProject("Plain");
    assert.equal(serializeProject(project), JSON.stringify(project, null, 2));
  });

  it("matches JSON.stringify for values it drops, empty containers, and toJSON", () => {
    const project = createEmptyProject("Edges");
    project.metadata = {
      dropped: undefined,
      inArray: [undefined, () => "fn", 1],
      notFinite: Number.NaN,
      emptyObject: {},
      emptyArray: [],
      nested: { deep: { deeper: [1, { two: 2 }] } },
      date: new Date("2026-08-10T00:00:00.000Z"),
      quote: 'a "quoted" \\ value\n',
    };
    assert.equal(serializeProject(project), JSON.stringify(project, null, 2));
  });

  it("writes a sparse array's holes as null, matching JSON.stringify", () => {
    const project = createEmptyProject("Sparse");
    // eslint-disable-next-line no-sparse-arrays
    project.metadata = { gappy: [1, , 2] };
    const text = serializeProject(project);
    assert.equal(text, JSON.stringify(project, null, 2));
    assert.deepEqual((JSON.parse(text) as typeof project).metadata.gappy, [1, null, 2]);
  });

  it("passes the property key to a custom toJSON, as JSON.stringify does", () => {
    const project = createEmptyProject("Keys");
    const probe = { toJSON: (key: string) => `saw:${key}` };
    project.metadata = { named: probe, list: [probe] };
    assert.equal(serializeProject(project), JSON.stringify(project, null, 2));
    const parsed = JSON.parse(serializeProject(project)) as typeof project;
    assert.equal(parsed.metadata.named, "saw:named");
    assert.deepEqual(parsed.metadata.list, ["saw:0"]);
  });

  it("unwraps boxed primitives the way JSON.stringify does", () => {
    const project = createEmptyProject("Boxed");
    project.metadata = {
      // eslint-disable-next-line no-new-wrappers
      count: new Number(7),
      // eslint-disable-next-line no-new-wrappers
      label: new String("x"),
      // eslint-disable-next-line no-new-wrappers
      flag: new Boolean(true),
    };
    const text = serializeProject(project);
    assert.equal(text, JSON.stringify(project, null, 2));
    assert.deepEqual((JSON.parse(text) as typeof project).metadata, {
      count: 7,
      label: "x",
      flag: true,
    });
  });

  it("throws on a circular reference instead of overflowing the stack", () => {
    const project = createEmptyProject("Cyclic");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    project.metadata = { cycle };
    // A RangeError here would be read as "project too large to save" by the
    // save path, sending the user after a size problem they do not have.
    assert.throws(() => serializeProject(project), TypeError);
  });

  it("serializes a value referenced twice side by side without calling it a cycle", () => {
    const project = createEmptyProject("Shared");
    const shared = { shared: true };
    project.metadata = { first: shared, second: shared };
    assert.equal(serializeProject(project), JSON.stringify(project, null, 2));
  });

  it("round-trips a feature-heavy project through parseProject", () => {
    const project = createEmptyProject("Round trip");
    project.layers = [featureRichLayer()];
    assert.deepEqual(
      parseProject(serializeProject(project)).layers[0].geojson,
      project.layers[0].geojson,
    );
  });
});

describe("multi-map grid persistence", () => {
  it("omits the grid keys for a default single-map project", () => {
    const project = projectFromStore({
      projectName: "Single",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });
    assert.equal(project.mapLayout, undefined);
    assert.equal(project.secondaryMapViews, undefined);
  });

  it("round-trips a 2x2 grid with per-pane layer visibility and labels", () => {
    const secondaryMapViews = [
      {
        id: "pane-1",
        view: { center: [10, 20], zoom: 5, bearing: 0, pitch: 0 },
        label: "2024",
        layerVisibility: { "layer-a": false, "layer-b": true },
      },
      {
        id: "pane-2",
        view: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        layerVisibility: { "layer-a": true },
      },
      {
        id: "pane-3",
        view: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        layerVisibility: {},
      },
    ];
    const project = projectFromStore({
      projectName: "Grid",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      mapLayout: { rows: 2, cols: 2, syncView: false },
      secondaryMapViews,
      primaryMapLabel: "2020",
      metadata: {},
    });
    assert.deepEqual(project.mapLayout, { rows: 2, cols: 2, syncView: false });
    assert.deepEqual(project.secondaryMapViews, secondaryMapViews);
    assert.equal(project.primaryMapLabel, "2020");
    const reparsed = parseProject(serializeProject(project));
    assert.deepEqual(reparsed.mapLayout, { rows: 2, cols: 2, syncView: false });
    assert.deepEqual(reparsed.secondaryMapViews, secondaryMapViews);
    assert.equal(reparsed.primaryMapLabel, "2020");
  });

  it("round-trips a secondary pane's 3D-globe viewKind", () => {
    const secondaryMapViews = [
      {
        id: "globe",
        view: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        viewKind: "cesium" as const,
        layerVisibility: {},
      },
    ];
    const project = projectFromStore({
      projectName: "Globe",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [],
      preferences: createEmptyProject().preferences,
      mapLayout: { rows: 1, cols: 2, syncView: true },
      secondaryMapViews,
      primaryMapLabel: "",
      metadata: {},
    });
    const reparsed = parseProject(serializeProject(project));
    assert.equal(reparsed.secondaryMapViews?.[0].viewKind, "cesium");
  });

  it("drops an unknown viewKind so the pane defaults to the 2D map", () => {
    const reparsed = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Bad kind",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        mapLayout: { rows: 1, cols: 2, syncView: true },
        secondaryMapViews: [
          {
            id: "a",
            view: { center: [1, 1], zoom: 3, bearing: 0, pitch: 0 },
            viewKind: "webgpu",
          },
        ],
      }),
    );
    assert.equal(reparsed.secondaryMapViews?.[0].viewKind, undefined);
  });

  it("reconciles surplus secondary panes down to rows * cols - 1", () => {
    const reparsed = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Too many",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        mapLayout: { rows: 1, cols: 2, syncView: true },
        secondaryMapViews: [
          { id: "a", view: { center: [1, 1], zoom: 3, bearing: 0, pitch: 0 } },
          { id: "b", view: { center: [2, 2], zoom: 4, bearing: 0, pitch: 0 } },
          { id: "c", view: { center: [3, 3], zoom: 5, bearing: 0, pitch: 0 } },
        ],
      }),
    );
    // A 1x2 grid has exactly one secondary pane; surplus entries are dropped.
    assert.equal(reparsed.secondaryMapViews?.length, 1);
    assert.equal(reparsed.secondaryMapViews?.[0].id, "a");
  });

  it("fills missing secondary panes by cloning the primary map", () => {
    const reparsed = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "Too few",
        mapView: { center: [7, 8], zoom: 6, bearing: 0, pitch: 0 },
        basemapStyleUrl: "https://tiles.openfreemap.org/styles/dark",
        mapLayout: { rows: 2, cols: 2, syncView: true },
        secondaryMapViews: [{ id: "a", view: { center: [1, 1], zoom: 3, bearing: 0, pitch: 0 } }],
      }),
    );
    // A 2x2 grid needs three secondary panes; the two missing ones clone primary.
    assert.equal(reparsed.secondaryMapViews?.length, 3);
    assert.deepEqual(reparsed.secondaryMapViews?.[1].view.center, [7, 8]);
    // Cloned panes start with no visibility overrides (they inherit the primary).
    assert.deepEqual(reparsed.secondaryMapViews?.[1].layerVisibility, {});
  });

  it("ignores a 1x1 grid so single-map files stay clean", () => {
    const reparsed = parseProject(
      JSON.stringify({
        version: "0.2.0",
        name: "One pane",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        mapLayout: { rows: 1, cols: 1, syncView: true },
      }),
    );
    assert.equal(reparsed.mapLayout, undefined);
    assert.equal(reparsed.secondaryMapViews, undefined);
  });
});

describe("app store", () => {
  it("normalizes Blank background colors written through the store", () => {
    useAppStore.getState().setBlankBackgroundColor("#123abc");
    assert.equal(useAppStore.getState().blankBackgroundColor, "#123abc");
    useAppStore.getState().setBlankBackgroundColor("invalid");
    assert.equal(useAppStore.getState().blankBackgroundColor, null);
  });

  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Test Project" });
    useAppStore.getState().clearRecentProjects();
  });

  it("adds, selects, moves, and removes layers consistently", () => {
    const store = useAppStore.getState();
    const first = store.addGeoJsonLayer("First", {
      type: "FeatureCollection",
      features: [],
    });
    const second = useAppStore.getState().addGeoJsonLayer("Second", {
      type: "FeatureCollection",
      features: [],
    });

    assert.equal(useAppStore.getState().selectedLayerId, second);
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      [first, second],
    );

    useAppStore.getState().moveLayer(first, 1);
    assert.deepEqual(
      useAppStore.getState().layers.map((layer) => layer.id),
      [second, first],
    );

    useAppStore.getState().selectLayer(first);
    useAppStore.getState().removeLayer(first);
    assert.equal(useAppStore.getState().selectedLayerId, second);
  });

  it("restores the saved active layer and keeps the legacy first-layer fallback", () => {
    const first = geojsonLayer({ id: "first", name: "First" });
    const second = geojsonLayer({ id: "second", name: "Second" });
    const base = createEmptyProject("Selection");

    useAppStore.getState().loadProject({
      ...base,
      layers: [first, second],
      selectedLayerId: "second",
    });
    assert.equal(useAppStore.getState().selectedLayerId, "second");

    useAppStore.getState().loadProject({ ...base, layers: [first, second] });
    assert.equal(useAppStore.getState().selectedLayerId, "first");

    useAppStore.getState().loadProject({
      ...base,
      layers: [first, second],
      selectedLayerId: null,
    });
    assert.equal(useAppStore.getState().selectedLayerId, null);
  });

  it("renames a layer without changing its id (keeps MapLibre sync stable)", () => {
    const id = useAppStore.getState().addGeoJsonLayer("Original", {
      type: "FeatureCollection",
      features: [],
    });

    useAppStore.getState().updateLayer(id, { name: "Renamed" });

    const layer = useAppStore.getState().layers.find((l) => l.id === id);
    assert.ok(layer);
    assert.equal(layer.name, "Renamed");
    // The id is the MapLibre source/layer key — renaming must not touch it.
    assert.equal(layer.id, id);
  });

  it("deduplicates recent projects and normalizes empty names", () => {
    useAppStore.getState().setRecentProjects([
      { path: "/tmp/a.geolibre.json", name: "", openedAt: "2026-01-01T00:00:00Z" },
      { path: "/tmp/a.geolibre.json", name: "Duplicate", openedAt: "2026-01-02T00:00:00Z" },
    ]);

    assert.deepEqual(useAppStore.getState().recentProjects, [
      {
        path: "/tmp/a.geolibre.json",
        name: "a.geolibre.json",
        openedAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });
});

function chapter(patch: Record<string, unknown> = {}) {
  return {
    id: "chapter-1",
    title: "Intro",
    description: "Hello",
    alignment: "left",
    hidden: false,
    location: { center: [10, 20], zoom: 4, pitch: 30, bearing: 45 },
    mapAnimation: "flyTo",
    rotateAnimation: false,
    onChapterEnter: [],
    onChapterExit: [],
    ...patch,
  };
}

describe("story maps", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Story Project" });
  });

  it("parses a valid story map and drops invalid chapters", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Story",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        storymap: {
          title: "My Story",
          theme: "weird",
          insetPosition: "nowhere",
          chapters: [
            chapter({ alignment: "diagonal", mapAnimation: "warp" }),
            chapter({ id: "", location: { center: [0, 0], zoom: 1 } }),
            { id: "no-location", title: "Bad" },
          ],
        },
      }),
    );

    assert.ok(project.storymap);
    // The theme/inset fall back to defaults, and only the first chapter (with a
    // valid id and center) survives; its bad enums normalize to defaults.
    assert.equal(project.storymap.theme, "dark");
    assert.equal(project.storymap.insetPosition, "bottom-left");
    assert.equal(project.storymap.chapters.length, 1);
    assert.equal(project.storymap.chapters[0].alignment, "left");
    assert.equal(project.storymap.chapters[0].mapAnimation, "flyTo");
  });

  it("dedupes chapter ids and clamps negative effect durations", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Story",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        storymap: {
          chapters: [
            chapter({
              id: "dup",
              onChapterEnter: [{ layerId: "a", opacity: 1, duration: -500 }],
            }),
            chapter({ id: "dup", title: "Duplicate id" }),
            chapter({ id: "unique" }),
          ],
        },
      }),
    );

    assert.ok(project.storymap);
    // The second "dup" chapter is dropped; the first one wins.
    assert.deepEqual(
      project.storymap.chapters.map((c) => c.id),
      ["dup", "unique"],
    );
    assert.equal(project.storymap.chapters[0].onChapterEnter[0].duration, 0);
  });

  it("clamps chapter zoom/pitch and wraps bearing into range", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Story",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        storymap: {
          chapters: [
            chapter({
              id: "a",
              location: { center: [10, 20], zoom: 999, pitch: 200, bearing: -43.2 },
            }),
          ],
        },
      }),
    );
    const loc = project.storymap?.chapters[0].location;
    assert.equal(loc?.zoom, 24);
    assert.equal(loc?.pitch, 85);
    // -43.2 wraps to an equivalent positive bearing rather than clamping to 0.
    assert.ok(Math.abs((loc?.bearing ?? 0) - 316.8) < 1e-9);
  });

  it("omits a wholly-default empty story map but keeps settings-only stories", () => {
    const base = {
      version: "0.1.0",
      name: "Story",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
    };
    // No chapters and all-default settings -> dropped.
    const empty = parseProject(JSON.stringify({ ...base, storymap: { chapters: [] } }));
    assert.equal(empty.storymap, undefined);
    // No chapters but an author-entered title -> kept (settings preserved).
    const settingsOnly = parseProject(
      JSON.stringify({ ...base, storymap: { title: "My Story", chapters: [] } }),
    );
    assert.equal(settingsOnly.storymap?.title, "My Story");
    assert.equal(settingsOnly.storymap?.chapters.length, 0);
  });

  it("normalizes hideChapterNav and start/closing slide settings", () => {
    const base = {
      version: "0.1.0",
      name: "Story",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
    };
    // Valid values round-trip; an invalid slide mode falls back to "none".
    const project = parseProject(
      JSON.stringify({
        ...base,
        storymap: {
          hideChapterNav: true,
          startSlide: "global",
          endSlide: "warp",
          chapters: [chapter()],
        },
      }),
    );
    assert.ok(project.storymap);
    assert.equal(project.storymap.hideChapterNav, true);
    assert.equal(project.storymap.startSlide, "global");
    assert.equal(project.storymap.endSlide, "none");

    // Defaults when omitted.
    const defaults = parseProject(JSON.stringify({ ...base, storymap: { chapters: [chapter()] } }));
    assert.equal(defaults.storymap?.hideChapterNav, false);
    assert.equal(defaults.storymap?.startSlide, "none");
    assert.equal(defaults.storymap?.endSlide, "none");

    // A settings-only story is kept when it only sets a non-default slide.
    const settingsOnly = parseProject(
      JSON.stringify({ ...base, storymap: { startSlide: "black", chapters: [] } }),
    );
    assert.equal(settingsOnly.storymap?.startSlide, "black");
  });

  it("round-trips a story map through the store and back to a project", () => {
    const store = useAppStore.getState();
    store.addStoryChapter(chapter() as never);
    store.addStoryChapter(chapter({ id: "chapter-2", title: "Second" }) as never);
    store.updateStorymapSettings({ title: "Trip", showMarkers: true });

    const saved = projectFromStore({
      projectName: useAppStore.getState().projectName,
      mapView: useAppStore.getState().mapView,
      basemapStyleUrl: useAppStore.getState().basemapStyleUrl,
      basemapVisible: useAppStore.getState().basemapVisible,
      basemapOpacity: useAppStore.getState().basemapOpacity,
      layers: useAppStore.getState().layers,
      preferences: useAppStore.getState().preferences,
      plugins: useAppStore.getState().projectPlugins,
      storymap: useAppStore.getState().storymap,
      metadata: useAppStore.getState().metadata,
    });

    assert.ok(saved.storymap);
    assert.equal(saved.storymap.title, "Trip");
    assert.equal(saved.storymap.showMarkers, true);
    assert.equal(saved.storymap.chapters.length, 2);

    // Reloading the serialized project restores the chapters in order.
    const reloaded = parseProject(serializeProject(saved));
    useAppStore.getState().loadProject(reloaded);
    assert.deepEqual(
      useAppStore.getState().storymap?.chapters.map((c) => c.id),
      ["chapter-1", "chapter-2"],
    );
    // A project that ships a story opens straight into the presentation.
    assert.equal(useAppStore.getState().ui.storymapPresenting, true);
  });

  it("opens a story-less project without presenting", () => {
    // Start with a presentation active to prove load clears it.
    useAppStore.getState().setStorymapPresenting(true);
    const empty = parseProject(serializeProject(createEmptyProject("Plain")));
    useAppStore.getState().loadProject(empty);
    assert.equal(useAppStore.getState().ui.storymapPresenting, false);
  });

  it("does not present a story that has no chapters", () => {
    useAppStore.getState().setStorymapPresenting(true);
    // A settings-only story survives normalization as a non-null storymap with
    // an empty chapters array, distinct from "no storymap at all".
    const withEmptyStory = parseProject(
      serializeProject({
        ...createEmptyProject("Settings-only story"),
        storymap: { ...DEFAULT_STORY_MAP, title: "No chapters" },
      }),
    );
    assert.ok(withEmptyStory.storymap);
    assert.equal(withEmptyStory.storymap?.chapters.length, 0);
    useAppStore.getState().loadProject(withEmptyStory);
    assert.equal(useAppStore.getState().ui.storymapPresenting, false);
  });

  it("honors the presenting:false override for a story project", () => {
    const store = useAppStore.getState();
    store.addStoryChapter(chapter() as never);
    const storyProject = parseProject(
      serializeProject(
        projectFromStore({
          projectName: useAppStore.getState().projectName,
          mapView: useAppStore.getState().mapView,
          basemapStyleUrl: useAppStore.getState().basemapStyleUrl,
          basemapVisible: useAppStore.getState().basemapVisible,
          basemapOpacity: useAppStore.getState().basemapOpacity,
          layers: useAppStore.getState().layers,
          preferences: useAppStore.getState().preferences,
          plugins: useAppStore.getState().projectPlugins,
          storymap: useAppStore.getState().storymap,
          metadata: useAppStore.getState().metadata,
        }),
      ),
    );
    // A caller opening the story for authoring can opt out of auto-presenting.
    useAppStore.getState().loadProject(storyProject, null, { presenting: false });
    assert.equal(useAppStore.getState().ui.storymapPresenting, false);
  });

  it("provides a sample story that survives normalization", () => {
    const sample = createSampleStoryMap();
    assert.equal(sample.chapters.length, 5);

    // Loading it as a project must keep every chapter (valid ids + centers).
    const reloaded = parseProject(
      serializeProject({
        ...createEmptyProject("Sample"),
        storymap: sample,
      }),
    );
    assert.equal(reloaded.storymap?.chapters.length, 5);
    assert.equal(reloaded.storymap?.chapters[0].id, "sample-san-francisco");
  });

  it("moves and removes chapters", () => {
    const store = useAppStore.getState();
    store.addStoryChapter(chapter({ id: "a" }) as never);
    store.addStoryChapter(chapter({ id: "b" }) as never);
    store.addStoryChapter(chapter({ id: "c" }) as never);

    useAppStore.getState().moveStoryChapter("c", 0);
    assert.deepEqual(
      useAppStore.getState().storymap?.chapters.map((c) => c.id),
      ["c", "a", "b"],
    );

    useAppStore.getState().removeStoryChapter("a");
    assert.deepEqual(
      useAppStore.getState().storymap?.chapters.map((c) => c.id),
      ["c", "b"],
    );
  });
});

describe("story map import/export", () => {
  it("round-trips a story map through JSON", () => {
    const sample = createSampleStoryMap();
    const restored = parseStoryMapJson(serializeStoryMapJson(sample));
    assert.equal(restored.title, sample.title);
    assert.equal(restored.chapters.length, 5);
    assert.deepEqual(
      restored.chapters.map((c) => c.id),
      sample.chapters.map((c) => c.id),
    );
  });

  it("accepts a project-shaped JSON object on import", () => {
    const sample = createSampleStoryMap();
    const restored = parseStoryMapJson(JSON.stringify({ storymap: sample }));
    assert.equal(restored.chapters.length, 5);
  });

  it("round-trips chapters through CSV and preserves base settings", () => {
    const sample = createSampleStoryMap();
    const csv = serializeStoryMapCsv(sample);
    // Import with different base settings; CSV carries only chapters.
    const base = { ...sample, title: "Kept Title", chapters: [] };
    const restored = parseStoryMapCsv(csv, base);
    assert.equal(restored.title, "Kept Title");
    assert.equal(restored.chapters.length, 5);
    assert.deepEqual(restored.chapters[0].location.center, sample.chapters[0].location.center);
  });

  it("imports hand-authored CSV with reordered columns and missing ids", () => {
    const csv = [
      "title,lat,lng,description,zoom",
      "Paris,48.8566,2.3522,The City of Light,11",
      '"Tokyo",35.6895,139.6917,"Mixes, modern and old",10',
    ].join("\n");
    const restored = parseStoryMapCsv(csv, null);
    assert.equal(restored.chapters.length, 2);
    assert.equal(restored.chapters[0].title, "Paris");
    assert.deepEqual(restored.chapters[0].location.center, [2.3522, 48.8566]);
    // Quoted field with a comma is preserved.
    assert.equal(restored.chapters[1].description, "Mixes, modern and old");
    // Missing ids are generated.
    assert.ok(restored.chapters[0].id);
    assert.notEqual(restored.chapters[0].id, restored.chapters[1].id);
  });

  it("grows and shrinks the secondary panes when the grid resizes", () => {
    const store = useAppStore.getState();
    assert.equal(store.secondaryMapViews.length, 0);

    store.setMapGrid(2, 2);
    // A 2x2 grid keeps three secondary panes (pane 0 is the primary map).
    assert.equal(useAppStore.getState().secondaryMapViews.length, 3);
    assert.deepEqual(useAppStore.getState().mapLayout, {
      rows: 2,
      cols: 2,
      syncView: true,
    });

    useAppStore.getState().setMapGrid(1, 2);
    assert.equal(useAppStore.getState().secondaryMapViews.length, 1);

    useAppStore.getState().setMapGrid(1, 1);
    assert.equal(useAppStore.getState().secondaryMapViews.length, 0);
  });

  it("clamps grid dimensions into the supported range", () => {
    useAppStore.getState().setMapGrid(99, 0);
    const { mapLayout } = useAppStore.getState();
    assert.equal(mapLayout.rows, 4);
    assert.equal(mapLayout.cols, 1);
  });

  it("toggles synchronized views", () => {
    useAppStore.getState().setSyncView(false);
    assert.equal(useAppStore.getState().mapLayout.syncView, false);
    useAppStore.getState().setSyncView(true);
    assert.equal(useAppStore.getState().mapLayout.syncView, true);
  });

  it("patches a secondary pane's camera and per-layer visibility by id", () => {
    useAppStore.getState().setMapGrid(1, 2);
    const paneId = useAppStore.getState().secondaryMapViews[0].id;

    useAppStore.getState().setSecondaryMapView(paneId, { zoom: 9, center: [5, 6] });
    useAppStore.getState().setSecondaryLayerVisibility(paneId, "layer-a", false);
    useAppStore.getState().setSecondaryLayerVisibility(paneId, "layer-b", true);

    const pane = useAppStore.getState().secondaryMapViews.find((p) => p.id === paneId);
    assert.equal(pane?.view.zoom, 9);
    assert.deepEqual(pane?.view.center, [5, 6]);
    assert.deepEqual(pane?.layerVisibility, {
      "layer-a": false,
      "layer-b": true,
    });
  });

  it("sets the primary and secondary pane labels", () => {
    useAppStore.getState().setMapGrid(1, 2);
    const paneId = useAppStore.getState().secondaryMapViews[0].id;

    useAppStore.getState().setPrimaryMapLabel("Before");
    useAppStore.getState().setSecondaryMapLabel(paneId, "After");

    assert.equal(useAppStore.getState().primaryMapLabel, "Before");
    assert.equal(useAppStore.getState().secondaryMapViews[0].label, "After");
  });

  it("removes a secondary pane and collapses the grid", () => {
    useAppStore.getState().setMapGrid(2, 2);
    const target = useAppStore.getState().secondaryMapViews[1].id;

    useAppStore.getState().removeSecondaryMapView(target);

    const state = useAppStore.getState();
    assert.equal(state.secondaryMapViews.length, 2);
    assert.ok(!state.secondaryMapViews.some((p) => p.id === target));
    // Three panes total now (primary + 2 secondary); the grid shrank to fit.
    assert.equal(state.mapLayout.rows * state.mapLayout.cols, 3);
  });
});

describe("annotation layer persistence", () => {
  // The Annotations plugin stores decoration as a tagged in-memory GeoJSON
  // layer (a text marker, an arrow shaft line, and its filled arrowhead). It
  // has no source URL, so the embedded geojson is the only copy and must survive
  // the on-disk round-trip, along with the `annotation` sourceKind and the
  // forced `simpleStyleEnabled` that makes per-feature stroke/fill render.
  it("round-trips annotation features, sourceKind, and simpleStyleEnabled", () => {
    const project = projectFromStore({
      projectName: "Annotations",
      mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
      basemapStyleUrl: DEFAULT_BASEMAP,
      basemapVisible: true,
      basemapOpacity: 1,
      layers: [
        geojsonLayer({
          id: "annotation-layer",
          name: "Annotations",
          metadata: { sourceKind: "annotation" },
          sourcePath: "annotations://layer",
          style: { ...DEFAULT_LAYER_STYLE, simpleStyleEnabled: true },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { __annotation: "text", shape: "text_marker", text: "Study Area" },
                geometry: { type: "Point", coordinates: [1, 2] },
              },
              {
                type: "Feature",
                properties: {
                  __annotation: "line",
                  annotationId: "a1",
                  stroke: "#ef4444",
                  "stroke-width": 3,
                },
                geometry: {
                  type: "LineString",
                  coordinates: [
                    [0, 0],
                    [1, 1],
                  ],
                },
              },
              {
                type: "Feature",
                properties: {
                  __annotation: "arrowhead",
                  annotationId: "a1",
                  fill: "#ef4444",
                  "fill-opacity": 1,
                },
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [1, 1],
                      [0.9, 1.1],
                      [1.1, 0.9],
                      [1, 1],
                    ],
                  ],
                },
              },
            ],
          },
        }),
      ],
      preferences: createEmptyProject().preferences,
      metadata: {},
    });

    // The source-less annotation layer keeps its embedded geojson on save.
    assert.equal(project.layers[0].geojson?.features.length, 3);

    const reopened = parseProject(serializeProject(project));
    assert.equal(reopened.layers[0].geojson?.features.length, 3);
    assert.equal(reopened.layers[0].metadata.sourceKind, "annotation");
    assert.equal(reopened.styles["annotation-layer"]?.simpleStyleEnabled, true);
    // The arrow shaft and its head stay grouped so they delete together.
    const head = reopened.layers[0].geojson?.features.find(
      (feature) => feature.properties?.__annotation === "arrowhead",
    );
    assert.equal(head?.properties?.annotationId, "a1");
  });
});

describe("primary mapView normalization", () => {
  it("clamps an out-of-range primary camera on parse", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Camera",
        mapView: {
          center: ["x", 200],
          zoom: -1,
          bearing: -90,
          pitch: 200,
        },
      }),
    );
    // Invalid lon falls back to the default camera longitude; lat clamps to 90.
    assert.deepEqual(project.mapView.center, [-100, 90]);
    assert.equal(project.mapView.zoom, 0);
    assert.equal(project.mapView.pitch, 85);
    assert.equal(project.mapView.bearing, 270);
  });

  it("normalizes an out-of-range camera through applyProjectToStore", () => {
    const applied = applyProjectToStore({
      ...createEmptyProject("Camera"),
      mapView: {
        center: ["x", 200] as unknown as [number, number],
        zoom: -1,
        bearing: -90,
        pitch: 200,
      },
    });
    assert.deepEqual(applied.mapView.center, [-100, 90]);
    assert.equal(applied.mapView.zoom, 0);
    assert.equal(applied.mapView.pitch, 85);
    assert.equal(applied.mapView.bearing, 270);
  });
});

describe("normalizeModelGraph", () => {
  it("supplies an empty edge list when the key is missing entirely", () => {
    // A hand-edited file without `edges` used to reach the canvas as
    // `edges: undefined`, and the renderer's `graph.edges.map(...)` then threw
    // out of render — past the importer's try/catch — into the error boundary,
    // instead of showing the friendly "not a model" message.
    const graph = normalizeModelGraph({
      nodes: [{ id: "a", kind: "input", x: 10, y: 20, layerId: "roads" }],
    });
    assert.deepEqual(graph?.edges, []);
    assert.equal(graph?.nodes.length, 1);
  });

  it("drops edges that do not connect two surviving nodes", () => {
    const graph = normalizeModelGraph({
      nodes: [
        { id: "a", kind: "input", x: 0, y: 0 },
        { id: "b", kind: "output", x: 0, y: 0 },
        { id: "", kind: "tool", x: 0, y: 0 },
      ],
      edges: [
        { id: "e1", from: "a", fromPort: "out", to: "b", toPort: "in" },
        { id: "e2", from: "a", fromPort: "out", to: "ghost", toPort: "in" },
        { id: "e3", from: "a", fromPort: "out", to: "a", toPort: "in" },
      ],
    });
    assert.deepEqual(
      graph?.edges.map((edge) => edge.id),
      ["e1"],
    );
  });

  it("rejects a node with an unknown kind rather than passing it to the runner", () => {
    const graph = normalizeModelGraph({
      nodes: [
        { id: "a", kind: "wat", x: 0, y: 0 },
        { id: "b", kind: "output", x: 0, y: 0 },
      ],
      edges: [],
    });
    assert.deepEqual(
      graph?.nodes.map((node) => node.id),
      ["b"],
    );
  });

  it("returns null for a value carrying no usable nodes", () => {
    assert.equal(normalizeModelGraph(null), null);
    assert.equal(normalizeModelGraph({ nodes: [] }), null);
    assert.equal(normalizeModelGraph({ nodes: "nope" }), null);
  });

  it("coerces a non-finite coordinate instead of laying the node out at NaN", () => {
    const graph = normalizeModelGraph({
      nodes: [{ id: "a", kind: "input", x: "left", y: Number.NaN }],
    });
    assert.deepEqual([graph?.nodes[0].x, graph?.nodes[0].y], [0, 0]);
  });
});

describe("print layout persistence", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Layout Project" });
  });

  it("omits an untouched composer so the saved file is unchanged by this feature", () => {
    const project = projectFromStore({
      ...useAppStore.getState(),
      metadata: {},
    });
    assert.equal(project.printLayout, undefined);
  });

  it("saves the composer settings once they differ from the defaults", () => {
    useAppStore.getState().setPrintLayout({
      ...createDefaultPrintLayout(),
      title: "Filière dentaire par régions",
      paperSize: "a3",
      orientation: "portrait",
    });
    const saved = parseProject(
      serializeProject(projectFromStore({ ...useAppStore.getState(), metadata: {} })),
    );
    assert.equal(saved.printLayout?.title, "Filière dentaire par régions");
    assert.equal(saved.printLayout?.paperSize, "a3");
    assert.equal(saved.printLayout?.orientation, "portrait");
  });

  it("restores the saved composer settings when the project is loaded", () => {
    const project = {
      ...createEmptyProject("Saved layout"),
      printLayout: {
        ...createDefaultPrintLayout(),
        title: "Saved title",
        orientation: "portrait" as const,
        showNorthArrow: false,
      },
    };
    useAppStore.getState().loadProject(project);
    const restored = useAppStore.getState().printLayout;
    assert.equal(restored.title, "Saved title");
    assert.equal(restored.orientation, "portrait");
    assert.equal(restored.showNorthArrow, false);
  });

  it("resets to the defaults for a project saved without a layout", () => {
    useAppStore.getState().setPrintLayout({
      ...createDefaultPrintLayout(),
      title: "Previous project",
      paperSize: "a3",
    });
    // The bug behind discussion #1992: opening another project must not leave
    // the previous project's composer settings in place.
    useAppStore.getState().loadProject(createEmptyProject("Next"));
    assert.deepEqual(useAppStore.getState().printLayout, createDefaultPrintLayout());

    useAppStore.getState().setPrintLayout({
      ...createDefaultPrintLayout(),
      title: "Previous project",
    });
    useAppStore.getState().newProject({ name: "Fresh" });
    assert.deepEqual(useAppStore.getState().printLayout, createDefaultPrintLayout());
  });

  it("clears composer blocks that name a layer the loaded project does not carry", () => {
    const layer = geojsonLayer({ id: "kept" });
    const applied = applyProjectToStore({
      ...createEmptyProject("Orphans"),
      layers: [layer],
      printLayout: {
        ...createDefaultPrintLayout(),
        showDataTable: true,
        tableLayerId: "deleted",
        showDataChart: true,
        chartLayerId: "kept",
      },
    });
    assert.equal(applied.printLayout.tableLayerId, "");
    assert.equal(applied.printLayout.showDataTable, false);
    assert.equal(applied.printLayout.chartLayerId, "kept");
  });

  it("clears a composer block when its layer is deleted from the open project", () => {
    const store = useAppStore.getState();
    const kept = store.addGeoJsonLayer("Kept", { type: "FeatureCollection", features: [] });
    const doomed = useAppStore
      .getState()
      .addGeoJsonLayer("Doomed", { type: "FeatureCollection", features: [] });
    useAppStore.getState().setPrintLayout({
      ...createDefaultPrintLayout(),
      showDataTable: true,
      tableLayerId: doomed,
      showDataChart: true,
      chartLayerId: kept,
    });

    useAppStore.getState().removeLayer(doomed);

    // Otherwise a save taken before the composer is next opened would write a
    // block pointing at a layer the file no longer carries.
    const after = useAppStore.getState().printLayout;
    assert.equal(after.tableLayerId, "");
    assert.equal(after.showDataTable, false);
    assert.equal(after.chartLayerId, kept);
    assert.equal(after.showDataChart, true);
  });

  it("ignores a write that changes nothing, so opening the composer is not an edit", () => {
    assert.equal(useAppStore.getState().isDirty, false);
    // The dialog replays its seeded values into the store on mount.
    useAppStore.getState().setPrintLayout(createDefaultPrintLayout());
    assert.equal(useAppStore.getState().isDirty, false);

    useAppStore.getState().setPrintLayout({ ...createDefaultPrintLayout(), title: "Edited" });
    assert.equal(useAppStore.getState().isDirty, true);
  });
});
