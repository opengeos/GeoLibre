import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Geometry } from "geojson";
import {
  applyProjectToStore,
  BLANK_BASEMAP,
  PLANETARY_BASEMAPS,
  createEmptyProject,
  parseProject,
  projectFromStore,
  serializeProject,
  useAppStore,
} from "@geolibre/core";
import { compileMapboxLayer, styleUsesUnsupportedSource } from "../packages/map/src/mapbox-layers";
import { proxyWmsTiles } from "../packages/map/src/wms-proxy";
import { resolveTextFontFromStyleLayers } from "../packages/map/src/text-font";
import { MAPBOX_CAPABILITIES, redactMapboxError } from "../packages/map/src/mapbox-engine";
import { MAPLIBRE_CAPABILITIES } from "../packages/map/src/map-engine";
import { CESIUM_CAPABILITIES } from "../packages/map/src/cesium-engine";
import { MAPBOX_BASEMAP_STYLES } from "../packages/map/src/mapbox-style";
import { isPluginEngineSupported } from "../packages/plugins/src/types";
import { maplibreLayerControlPlugin } from "../packages/plugins/src/plugins/layer-control";
import { maplibreDeckGlVizPlugin } from "../packages/plugins/src/plugins/maplibre-deckgl-viz";
import { geojsonLayer } from "./helpers/layer-fixtures";

describe("Mapbox project and plugin boundaries", () => {
  it("round trips the primary renderer independently of the grid", () => {
    const project = createEmptyProject();
    project.primaryRenderer = "mapbox";
    const reopened = parseProject(serializeProject(project));
    assert.equal(reopened.primaryRenderer, "mapbox");
    assert.equal(applyProjectToStore(reopened).primaryRenderer, "mapbox");
    useAppStore.getState().newProject();
    useAppStore.getState().setPrimaryRenderer("mapbox");
    assert.equal(projectFromStore(useAppStore.getState()).primaryRenderer, "mapbox");
  });
  it("round trips Mapbox secondary panes", () => {
    const project = createEmptyProject();
    project.mapLayout = { rows: 1, cols: 2, syncView: true };
    project.secondaryMapViews = [
      { id: "mapbox-pane", view: project.mapView, viewKind: "mapbox", layerVisibility: {} },
    ];
    assert.equal(parseProject(serializeProject(project)).secondaryMapViews?.[0].viewKind, "mapbox");
  });
  it("does not activate MapLibre plugins or expose a fake MapLibre map", () => {
    assert.equal(isPluginEngineSupported({}, "mapbox"), false);
    assert.equal(isPluginEngineSupported({ engines: ["maplibre", "cesium"] }, "mapbox"), false);
    assert.equal(isPluginEngineSupported({ engines: ["mapbox"] }, "mapbox"), true);
    assert.equal(MAPBOX_CAPABILITIES.nativeMapInstance, false);
    assert.equal(MAPBOX_CAPABILITIES.customLayers, false);
  });
  it("hosts the shared deck.gl overlay and keeps the Deck.gl Layer plugin active", () => {
    // `@deck.gl/mapbox` targets mapbox-gl natively, so the Add Data → Deck.gl
    // Layer / 3D Model builders gate on this rather than on customLayers.
    assert.equal(MAPBOX_CAPABILITIES.deckOverlay, true);
    assert.equal(MAPLIBRE_CAPABILITIES.deckOverlay, true);
    assert.equal(CESIUM_CAPABILITIES.deckOverlay, false);
    // The plugin manager deactivates plugins that omit the new engine on a
    // renderer swap; the overlay plugin must survive MapLibre ↔ Mapbox.
    assert.equal(isPluginEngineSupported(maplibreDeckGlVizPlugin, "mapbox"), true);
    assert.equal(isPluginEngineSupported(maplibreDeckGlVizPlugin, "maplibre"), true);
    assert.equal(isPluginEngineSupported(maplibreDeckGlVizPlugin, "cesium"), false);
  });
  it("keeps the Layer Control plugin active on Mapbox", () => {
    // The plugin manager deactivates plugins that do not declare the new
    // engine on a renderer swap, and this plugin's deactivate removes the
    // control — so without the declaration the Mapbox map lost its layer
    // control and the Plugins menu entry.
    assert.equal(isPluginEngineSupported(maplibreLayerControlPlugin, "mapbox"), true);
    assert.equal(isPluginEngineSupported(maplibreLayerControlPlugin, "maplibre"), true);
    assert.equal(isPluginEngineSupported(maplibreLayerControlPlugin, "cesium"), false);
  });
  it("redacts credentials from engine errors", () => {
    const result = redactMapboxError(
      "Failed https://api.mapbox.com/style?access_token=pk.private.value&x=1 sk.other.secret",
    );
    assert.ok(!result.includes("private"));
    assert.ok(!result.includes("secret"));
    assert.ok(result.includes("?x=1"));
  });
});

describe("Mapbox native layer compilation", () => {
  it("preserves GeoJSON, opacity and all filter sources while removing MapLibre paint extensions", () => {
    const layer = geojsonLayer({ id: "states" });
    layer.opacity = 0.5;
    layer.filterExpression = ["==", ["get", "name"], "California"];
    layer.timeFilter = [">", ["get", "year"], 2020];
    layer.embedFilter = ["==", ["get", "visible"], true];
    const plan = compileMapboxLayer(layer);
    assert.equal(plan.source.type, "geojson");
    if (plan.source.type === "geojson") assert.equal(plan.source.data, layer.geojson);
    for (const spec of plan.layers) {
      assert.ok(!Object.keys(spec.paint ?? {}).some((key) => key.endsWith("-layer-opacity")));
      assert.match(JSON.stringify(spec), /California/);
      assert.match(JSON.stringify(spec), /year/);
      assert.match(JSON.stringify(spec), /visible/);
    }
    const fill = plan.layers.find((s) => s.type === "fill");
    assert.ok(fill);
    assert.equal(fill.paint?.["fill-opacity"], layer.style.fillOpacity * 0.5);
  });
  it("routes Multi* geometries to the same layers as their singular kinds", () => {
    const plan = compileMapboxLayer(geojsonLayer({ id: "multi" }));
    const filterOf = (type: string) =>
      JSON.stringify(plan.layers.find((s) => s.type === type)?.filter);
    assert.match(filterOf("fill"), /"Polygon","MultiPolygon"/);
    assert.match(filterOf("circle"), /"Point","MultiPoint"/);
    // The line layer draws everything except points, so it must exclude
    // MultiPoint too, or a MultiPoint renders as a line instead of circles.
    assert.match(filterOf("line"), /"Point","MultiPoint"\],false,true/);
  });
  it("adds only the geometry layers inline GeoJSON can draw, like MapLibre's layer-sync", () => {
    const withGeometries = (id: string, ...geometries: Geometry[]) =>
      geojsonLayer({
        id,
        geojson: {
          type: "FeatureCollection",
          features: geometries.map((geometry) => ({ type: "Feature", properties: {}, geometry })),
        },
      });
    const polygon: Geometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    };
    const line: Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    };
    const point: Geometry = { type: "Point", coordinates: [0, 0] };
    const types = (layer: ReturnType<typeof geojsonLayer>) =>
      compileMapboxLayer(layer).layers.map((s) => s.type);
    // A polygon keeps its outline; no circle layer that could never match (#2431).
    assert.deepEqual(types(withGeometries("polygons", polygon)), ["fill", "line"]);
    assert.deepEqual(types(withGeometries("lines", line)), ["line"]);
    assert.deepEqual(types(withGeometries("points", point)), ["circle"]);
    assert.deepEqual(types(withGeometries("mixed", point, polygon)), ["fill", "line", "circle"]);
    const collection = withGeometries("collection", {
      type: "GeometryCollection",
      geometries: [point, line],
    });
    assert.deepEqual(types(collection), ["line", "circle"]);
    const nested = withGeometries("nested", {
      type: "GeometryCollection",
      geometries: [{ type: "GeometryCollection", geometries: [polygon] }],
    });
    assert.deepEqual(types(nested), ["fill", "line"]);
    // An empty editable layer keeps every kind, so the first drawn feature has
    // a layer to land on.
    assert.deepEqual(types(geojsonLayer({ id: "empty" })), ["fill", "line", "circle"]);
    // A table without coordinates never draws, so it gets no geometry layers,
    // as on MapLibre.
    const table = geojsonLayer({
      id: "table",
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: { name: "a" }, geometry: null }],
      },
    });
    assert.deepEqual(types(table), []);
  });
  it("labels with the basemap's font when the engine supplies one", () => {
    const layer = geojsonLayer({ id: "fonts" });
    layer.style = {
      ...layer.style,
      labels: { ...layer.style.labels, enabled: true, field: "name" },
    };
    const font = (plan: ReturnType<typeof compileMapboxLayer>) =>
      plan.layers.find((s) => s.type === "symbol")?.layout?.["text-font"];
    assert.deepEqual(font(compileMapboxLayer(layer)), ["Open Sans Regular"]);
    assert.deepEqual(font(compileMapboxLayer(layer, { textFont: ["Noto Sans Regular"] })), [
      "Noto Sans Regular",
    ]);
    // The resolver reads the first text symbol layer, unwrapping the literal
    // form, and ignores icon-only and data-driven fonts.
    assert.deepEqual(
      resolveTextFontFromStyleLayers(
        [
          { type: "symbol", layout: { "icon-image": "x", "text-font": ["Icon Font"] } },
          { type: "symbol", layout: { "text-field": "{n}", "text-font": ["get", "font"] } },
          { type: "symbol", layout: { "text-field": "{n}", "text-font": ["literal", ["A", "B"]] } },
        ],
        ["Fallback"],
      ),
      ["A", "B"],
    );
    assert.deepEqual(resolveTextFontFromStyleLayers([], ["Fallback"]), ["Fallback"]);
  });
  it("keeps the geometry when a label expression is not valid JSON", () => {
    const layer = geojsonLayer({ id: "labels" });
    layer.style = {
      ...layer.style,
      labels: { ...layer.style.labels, enabled: true, field: "name", expression: "{not json" },
    };
    const plan = compileMapboxLayer(layer);
    const labels = plan.layers.find((s) => s.type === "symbol");
    assert.ok(labels);
    assert.deepEqual(labels.layout?.["text-field"], [
      "to-string",
      ["coalesce", ["get", "name"], ""],
    ]);
    assert.equal(plan.layers.length, 4);
  });
  it("flags inline styles whose sources need a MapLibre-only protocol", () => {
    assert.equal(
      styleUsesUnsupportedSource({
        sources: { protomaps: { url: "pmtiles://offline-basemap" } },
      }),
      true,
    );
    assert.equal(
      styleUsesUnsupportedSource({
        sources: {
          osm: { tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"] },
          inline: { url: "data:application/json,{}" },
        },
      }),
      false,
    );
    assert.equal(
      styleUsesUnsupportedSource({
        sources: { g: { type: "geojson", data: "custom://a.geojson" } },
      }),
      true,
    );
    assert.equal(styleUsesUnsupportedSource({}), false);
  });
  it("routes WMS tiles through the dev-server proxy like the MapLibre path", () => {
    const tiles = ["https://example.gov/wms?bbox={bbox-epsg-3857}&x=1"];
    assert.deepEqual(proxyWmsTiles("wms", tiles, false), tiles);
    assert.deepEqual(proxyWmsTiles("xyz", tiles, true), tiles);
    const [proxied] = proxyWmsTiles("wms", tiles, true);
    assert.ok(proxied.startsWith("/__geolibre_wms_proxy?url=https%3A%2F%2Fexample.gov"));
    // The bbox placeholder must survive encoding so the map still fills it in.
    assert.ok(proxied.includes("{bbox-epsg-3857}"));
  });
  it("uses Mapbox's native GeoJSON path even for plugin-owned in-memory vector data", () => {
    const layer = geojsonLayer({ id: "external" });
    layer.metadata = { sourceKind: "maplibre-gl-vector", nativeLayerIds: ["old-native-id"] };
    assert.equal(compileMapboxLayer(layer).source.type, "geojson");
  });
  it("preserves HTTP raster bounds, zoom limits, attribution and TMS scheme", () => {
    const layer = {
      ...geojsonLayer({ id: "tiles" }),
      geojson: undefined,
      type: "xyz" as const,
      source: {
        tiles: ["https://example.com/{z}/{x}/{y}.png"],
        scheme: "tms",
        tileSize: 512,
        minzoom: 2,
        maxzoom: 12,
        bounds: [-10, -10, 10, 10],
        attribution: "Test tiles",
      },
    };
    assert.deepEqual(compileMapboxLayer(layer).source, { ...layer.source, type: "raster" });
  });
  it("rejects custom protocols rather than silently displaying an empty layer", () => {
    const layer = {
      ...geojsonLayer({ id: "cog" }),
      geojson: undefined,
      type: "raster" as const,
      source: { tiles: ["geolibre-cog://sample/{z}/{x}/{y}"] },
    };
    assert.throws(() => compileMapboxLayer(layer), /custom tile protocols/);
  });
  it("creates each source-layer in vector tiles", () => {
    const layer = {
      ...geojsonLayer({ id: "vector" }),
      geojson: undefined,
      type: "vector-tiles" as const,
      source: { url: "mapbox://mapbox.mapbox-streets-v8", sourceLayers: ["water", "road"] },
    };
    const plan = compileMapboxLayer(layer);
    assert.equal(plan.layers.length, 6);
    assert.equal(new Set(plan.layers.map((s) => s.id)).size, 6);
    assert.equal(
      plan.layers.filter((s) => "source-layer" in s && s["source-layer"] === "water").length,
      3,
    );
  });
});

describe("Mapbox-specific basemap preference", () => {
  it("offers the maintained Mapbox basemap catalog with stable unique choices", () => {
    assert.deepEqual(
      MAPBOX_BASEMAP_STYLES.slice(0, 2).map((style) => style.styleUrl),
      ["mapbox://styles/mapbox/standard", "mapbox://styles/mapbox/standard-satellite"],
    );
    assert.equal(
      new Set(MAPBOX_BASEMAP_STYLES.map((style) => style.id)).size,
      MAPBOX_BASEMAP_STYLES.length,
    );
    for (const style of MAPBOX_BASEMAP_STYLES) {
      assert.match(style.styleUrl, /^mapbox:\/\/styles\/mapbox\/[a-z0-9-]+$/);
    }
  });

  it("defaults new projects to Mapbox Standard while retaining the shared basemap", () => {
    const project = createEmptyProject();
    assert.equal(project.preferences.map.mapboxStyleUrl, "mapbox://styles/mapbox/standard");
    assert.notEqual(project.basemapStyleUrl, project.preferences.map.mapboxStyleUrl);
    // createEmptyProject hands back the shared default preferences object, so
    // copy before clearing rather than mutating the global default.
    project.preferences = {
      ...project.preferences,
      map: { ...project.preferences.map, mapboxStyleUrl: undefined },
    };
    project.basemapStyleUrl = BLANK_BASEMAP;
    const reopened = parseProject(serializeProject(project));
    assert.equal(reopened.preferences.map.mapboxStyleUrl, undefined);
    assert.equal(reopened.basemapStyleUrl, BLANK_BASEMAP);
  });
  it("persists the override without changing the other engines' shared basemap", () => {
    const project = createEmptyProject();
    const shared = project.basemapStyleUrl;
    project.primaryRenderer = "mapbox";
    project.preferences = {
      ...project.preferences,
      map: { ...project.preferences.map, mapboxStyleUrl: "mapbox://styles/mapbox/standard" },
    };
    const reopened = parseProject(serializeProject(project));
    assert.equal(reopened.basemapStyleUrl, shared);
    assert.equal(reopened.preferences.map.mapboxStyleUrl, "mapbox://styles/mapbox/standard");
  });
});

describe("Mapbox background picker", () => {
  const satellite = "mapbox://styles/mapbox/satellite-v9";
  const selectSatellite = () => {
    const state = useAppStore.getState();
    state.setPreferences({
      ...state.preferences,
      map: { ...state.preferences.map, mapboxStyleUrl: satellite },
    });
  };
  it("lets a background selection replace the active Mapbox override", () => {
    useAppStore.getState().newProject();
    useAppStore.getState().setPrimaryRenderer("mapbox");
    selectSatellite();
    useAppStore.getState().setBasemapStyleUrl(BLANK_BASEMAP);
    assert.equal(useAppStore.getState().basemapStyleUrl, BLANK_BASEMAP);
    assert.equal(useAppStore.getState().preferences.map.mapboxStyleUrl, undefined);
  });
  it("also replaces the override for planetary basemaps and returning to Earth", () => {
    useAppStore.getState().newProject();
    useAppStore.getState().setPrimaryRenderer("mapbox");
    selectSatellite();
    const planetary = PLANETARY_BASEMAPS[0];
    useAppStore.getState().applyPlanetaryBasemap(planetary);
    assert.equal(useAppStore.getState().preferences.map.mapboxStyleUrl, undefined);
    assert.equal(useAppStore.getState().preferences.map.ellipsoidId, planetary.ellipsoidId);
    selectSatellite();
    useAppStore.getState().restoreEarthBasemap(BLANK_BASEMAP);
    assert.equal(useAppStore.getState().preferences.map.mapboxStyleUrl, undefined);
  });
  it("preserves a Mapbox override when changing the background in MapLibre", () => {
    useAppStore.getState().newProject();
    useAppStore.getState().setPrimaryRenderer("maplibre");
    selectSatellite();
    useAppStore.getState().setBasemapStyleUrl(BLANK_BASEMAP);
    assert.equal(useAppStore.getState().preferences.map.mapboxStyleUrl, satellite);
  });
});
