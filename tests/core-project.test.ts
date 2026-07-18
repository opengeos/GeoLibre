import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  DEFAULT_STORY_MAP,
  createEmptyProject,
  createSampleStoryMap,
  parseProject,
  parseStoryMapCsv,
  parseStoryMapJson,
  projectFromStore,
  serializeProject,
  serializeStoryMapCsv,
  serializeStoryMapJson,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";

function geojsonLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-a",
    name: "Layer A",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

describe("project parsing", () => {
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
