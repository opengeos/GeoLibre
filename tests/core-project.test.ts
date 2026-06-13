import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  createEmptyProject,
  parseProject,
  projectFromStore,
  serializeProject,
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

    assert.deepEqual(project.layers[0].source.tiles, [
      "https://tiles.example.com/{z}/{x}/{y}.png",
    ]);
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
