import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_BASEMAP,
  DEFAULT_LAYER_STYLE,
  createEmptyProject,
  createSampleStoryMap,
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
    assert.equal(project.storymap.insetPosition, "bottom-right");
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
              onChapterEnter: [
                { layerId: "a", opacity: 1, duration: -500 },
              ],
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

  it("omits an empty story map from a parsed project", () => {
    const project = parseProject(
      JSON.stringify({
        version: "0.1.0",
        name: "Story",
        mapView: { center: [0, 0], zoom: 2, bearing: 0, pitch: 0 },
        storymap: { title: "Empty", chapters: [] },
      }),
    );
    assert.equal(project.storymap, undefined);
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
