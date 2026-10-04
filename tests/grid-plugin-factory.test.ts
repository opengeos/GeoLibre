import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import {
  DEFAULT_A5_GRID_SETTINGS,
  a5GridForBounds,
  getA5GridSettings,
  maplibreA5Plugin,
  normalizeA5GridSettings,
  setA5GridSettings,
} from "../packages/plugins/src/plugins/maplibre-a5";
import {
  DEFAULT_GEOHASH_GRID_SETTINGS,
  geohashGridForBounds,
  getGeohashGridSettings,
  maplibreGeohashPlugin,
  normalizeGeohashGridSettings,
  setGeohashGridSettings,
} from "../packages/plugins/src/plugins/maplibre-geohash";
import {
  DEFAULT_H3_GRID_SETTINGS,
  getH3GridSettings,
  h3GridForBounds,
  maplibreH3Plugin,
  normalizeH3GridSettings,
  setH3GridSettings,
} from "../packages/plugins/src/plugins/maplibre-h3";
import {
  DEFAULT_OLC_GRID_SETTINGS,
  getOlcGridSettings,
  maplibreOlcPlugin,
  normalizeOlcGridSettings,
  olcGridForBounds,
  setOlcGridSettings,
  type OlcCodeLength,
} from "../packages/plugins/src/plugins/maplibre-olc";
import {
  DEFAULT_S2_GRID_SETTINGS,
  getS2GridSettings,
  maplibreS2Plugin,
  normalizeS2GridSettings,
  s2GridForBounds,
  setS2GridSettings,
} from "../packages/plugins/src/plugins/maplibre-s2";
import {
  DEFAULT_TILECODE_GRID_SETTINGS,
  getTilecodeGridSettings,
  maplibreTilecodePlugin,
  normalizeTilecodeGridSettings,
  setTilecodeGridSettings,
  tilecodeGridForBounds,
} from "../packages/plugins/src/plugins/maplibre-tilecode";
import { snapToOption } from "../packages/plugins/src/plugins/grid-plugin-factory";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../packages/plugins/src/types";

// Every DGGS grid plugin is a configuration of createGridPlugin. These run the
// same scenario against each configuration so the shared skeleton (map ids,
// viewport fill, click-to-identify, persisted state) is pinned for all six.

type Settings = Record<string, unknown> & { resolution: number };

interface GridCase {
  name: string;
  plugin: GeoLibrePlugin;
  id: string;
  slug: string;
  idProperty: string;
  parentKey: "includeParent" | "includeParents";
  /** A resolution whose cells fit the small test bbox a few dozen times. */
  resolution: number;
  defaults: Settings;
  gridForBounds: (
    bounds: [number, number, number, number],
    resolution: number,
  ) => FeatureCollection<Polygon>;
  normalize: (value: unknown) => Settings;
  getSettings: () => Settings;
  setSettings: (patch: Record<string, unknown>) => void;
}

const asCase = (value: unknown): GridCase => value as GridCase;

const GRIDS: GridCase[] = [
  asCase({
    name: "S2",
    plugin: maplibreS2Plugin,
    id: "maplibre-s2-grid",
    slug: "s2",
    idProperty: "s2",
    parentKey: "includeParents",
    resolution: 10,
    defaults: DEFAULT_S2_GRID_SETTINGS,
    gridForBounds: s2GridForBounds,
    normalize: normalizeS2GridSettings,
    getSettings: getS2GridSettings,
    setSettings: setS2GridSettings,
  }),
  asCase({
    name: "H3",
    plugin: maplibreH3Plugin,
    id: "maplibre-h3-grid",
    slug: "h3",
    idProperty: "h3",
    parentKey: "includeParents",
    resolution: 5,
    defaults: DEFAULT_H3_GRID_SETTINGS,
    gridForBounds: h3GridForBounds,
    normalize: normalizeH3GridSettings,
    getSettings: getH3GridSettings,
    setSettings: setH3GridSettings,
  }),
  asCase({
    name: "A5",
    plugin: maplibreA5Plugin,
    id: "maplibre-a5-grid",
    slug: "a5",
    idProperty: "a5",
    parentKey: "includeParents",
    resolution: 8,
    defaults: DEFAULT_A5_GRID_SETTINGS,
    gridForBounds: a5GridForBounds,
    normalize: normalizeA5GridSettings,
    getSettings: getA5GridSettings,
    setSettings: setA5GridSettings,
  }),
  asCase({
    name: "OLC",
    plugin: maplibreOlcPlugin,
    id: "maplibre-olc",
    slug: "olc",
    idProperty: "olc",
    parentKey: "includeParent",
    resolution: 6,
    defaults: DEFAULT_OLC_GRID_SETTINGS,
    gridForBounds: (bounds: [number, number, number, number], resolution: number) =>
      olcGridForBounds(bounds, resolution as OlcCodeLength),
    normalize: normalizeOlcGridSettings,
    getSettings: getOlcGridSettings,
    setSettings: setOlcGridSettings,
  }),
  asCase({
    name: "Geohash",
    plugin: maplibreGeohashPlugin,
    id: "maplibre-geohash",
    slug: "geohash",
    idProperty: "geohash",
    parentKey: "includeParent",
    resolution: 4,
    defaults: DEFAULT_GEOHASH_GRID_SETTINGS,
    gridForBounds: geohashGridForBounds,
    normalize: normalizeGeohashGridSettings,
    getSettings: getGeohashGridSettings,
    setSettings: setGeohashGridSettings,
  }),
  asCase({
    name: "Tilecode",
    plugin: maplibreTilecodePlugin,
    id: "maplibre-tilecode",
    slug: "tilecode",
    idProperty: "tilecode",
    parentKey: "includeParent",
    resolution: 10,
    defaults: DEFAULT_TILECODE_GRID_SETTINGS,
    gridForBounds: tilecodeGridForBounds,
    normalize: normalizeTilecodeGridSettings,
    getSettings: getTilecodeGridSettings,
    setSettings: setTilecodeGridSettings,
  }),
];

/** A small viewport over northern Italy, away from the poles and the antimeridian. */
const BBOX: [number, number, number, number] = [10, 45, 10.5, 45.5];

type Listener = (event?: unknown) => void;
type FakeLayer = { id: string; type: string; layout?: Record<string, unknown> };

/** A recording fake of the Style Spec surface the grid plugins drive. */
function fakeMap() {
  const sources = new Map<string, { data?: unknown; setData: (data: unknown) => void }>();
  const layers = new Map<string, FakeLayer>();
  const listeners = new Map<string, Set<Listener>>();
  // The basemap's own symbol layers, which the grid borrows its label font from.
  const basemapLayers: FakeLayer[] = [];
  const map = {
    sources,
    layers,
    listeners,
    basemapLayers,
    fire: (event: string, payload?: unknown) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    on: (event: string, listener: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    off: (event: string, listener: Listener) => void listeners.get(event)?.delete(listener),
    once: (event: string, listener: Listener) => {
      const wrapped: Listener = (payload) => {
        listeners.get(event)?.delete(wrapped);
        listener(payload);
      };
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(wrapped);
    },
    getStyle: () => ({ layers: [...basemapLayers, ...layers.values()] }),
    getZoom: () => 9,
    getBounds: () => ({
      getWest: () => BBOX[0],
      getSouth: () => BBOX[1],
      getEast: () => BBOX[2],
      getNorth: () => BBOX[3],
    }),
    addSource: (id: string, spec: { data?: unknown }) => {
      const source = { ...spec, setData: (data: unknown) => void (source.data = data) };
      sources.set(id, source);
    },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => void sources.delete(id),
    addLayer: (spec: FakeLayer) =>
      void layers.set(spec.id, { ...spec, layout: { ...spec.layout } }),
    getLayer: (id: string) => layers.get(id),
    removeLayer: (id: string) => void layers.delete(id),
    setPaintProperty: () => {},
    setLayoutProperty: (id: string, name: string, value: unknown) => {
      const layer = layers.get(id);
      if (layer) layer.layout = { ...layer.layout, [name]: value };
    },
    setLayerZoomRange: () => {},
  };
  return map;
}

function hostFor(map: ReturnType<typeof fakeMap>) {
  const panels: string[] = [];
  const basemapListeners = new Set<(styleUrl: string) => void>();
  const host = {
    panels,
    /** Reports a basemap change the way the app's store subscription does. */
    changeBasemap: (styleUrl: string) => {
      for (const listener of [...basemapListeners]) listener(styleUrl);
    },
    getMap: () => map,
    getMapRenderer: () => "maplibre" as const,
    onBasemapChange: (listener: (styleUrl: string) => void) => {
      basemapListeners.add(listener);
      return () => void basemapListeners.delete(listener);
    },
    registerRightPanel: (panel: { id: string }) => {
      panels.push(panel.id);
      return () => {};
    },
    openRightPanel: () => true,
    closeRightPanel: () => {},
  };
  return host as unknown as GeoLibreAppAPI & typeof host;
}

function features(map: ReturnType<typeof fakeMap>, id: string): Feature<Polygon>[] {
  return (map.sources.get(id)?.data as FeatureCollection<Polygon> | undefined)?.features ?? [];
}

function ringBox(feature: Feature<Polygon>): [number, number, number, number] {
  const ring = feature.geometry.coordinates[0];
  const lons = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

for (const grid of GRIDS) {
  describe(`${grid.name} grid (createGridPlugin)`, () => {
    it("keeps its plugin id", () => {
      assert.equal(grid.plugin.id, grid.id);
      assert.deepEqual(grid.plugin.engines, ["maplibre", "mapbox", "arcgis"]);
    });

    it("fills a small bbox with unique cells at the requested resolution", () => {
      const result = grid.gridForBounds(BBOX, grid.resolution);
      assert.ok(result.features.length > 0, "cells in view");
      assert.ok(result.features.length < 2_000, `${result.features.length} cells`);
      const ids = result.features.map((feature) => feature.properties?.[grid.idProperty]);
      assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
      assert.equal(new Set(ids).size, ids.length, "no duplicate cells");
      assert.ok(
        result.features.every((feature) => feature.properties?.resolution === grid.resolution),
      );
    });

    it("emits closed polygon rings", () => {
      for (const feature of grid.gridForBounds(BBOX, grid.resolution).features) {
        assert.equal(feature.geometry.type, "Polygon");
        const ring = feature.geometry.coordinates[0];
        assert.ok(ring.length >= 4, "a ring has at least three distinct vertices");
        assert.deepEqual(ring.at(0), ring.at(-1), "the ring closes on its first vertex");
      }
    });

    it("draws the viewport, identifies a clicked cell and tears down", () => {
      const map = fakeMap();
      const host = hostFor(map);
      const prefix = `geolibre-${grid.slug}`;
      const parentSlug = grid.parentKey === "includeParents" ? "parents" : "parent";
      assert.notEqual(grid.plugin.activate(host), false);
      try {
        assert.deepEqual(host.panels, [`${prefix}-panel`]);
        assert.deepEqual(
          [...map.sources.keys()].sort(),
          [
            `${prefix}-grid-source`,
            `${prefix}-neighbors-source`,
            `${prefix}-${parentSlug}-source`,
            `${prefix}-selected-source`,
            ...(grid.slug === "h3" ? [`${prefix}-icosahedron-source`] : []),
          ].sort(),
        );
        assert.ok(features(map, `${prefix}-grid-source`).length > 0, "the viewport is filled");

        grid.setSettings({ includeNeighbors: true, [grid.parentKey]: true });
        map.fire("click", { lngLat: { lng: 10.25, lat: 45.25 } });
        const [selected] = features(map, `${prefix}-selected-source`);
        assert.ok(selected, "the click selects a cell");
        const [west, south, east, north] = ringBox(selected);
        assert.ok(west <= 10.25 && 10.25 <= east && south <= 45.25 && 45.25 <= north);
        const neighbors = features(map, `${prefix}-neighbors-source`);
        assert.ok(neighbors.length > 0, "neighbors are drawn");
        assert.ok(neighbors.every((feature) => feature.id !== selected.id));
        assert.equal(features(map, `${prefix}-${parentSlug}-source`).length, 1, "one parent");
      } finally {
        grid.plugin.deactivate(host);
        grid.plugin.applyProjectState?.(host, undefined);
      }
      assert.equal(map.sources.size, 0);
      assert.equal(map.layers.size, 0);
      assert.equal(map.listeners.get("moveend")?.size ?? 0, 0);
      assert.equal(map.listeners.get("click")?.size ?? 0, 0);
    });

    it("re-points surviving labels at the new basemap's font", () => {
      const map = fakeMap();
      const host = hostFor(map);
      const labelId = `geolibre-${grid.slug}-grid-label`;
      map.basemapLayers.push({
        id: "place-label",
        type: "symbol",
        layout: { "text-font": ["Montserrat Regular"] },
      });
      assert.notEqual(grid.plugin.activate(host), false);
      try {
        assert.deepEqual(map.layers.get(labelId)?.layout?.["text-font"], ["Montserrat Regular"]);
        // A host that keeps plugin layers across a style swap (the ArcGIS
        // shadow style) leaves the label layer in place while the basemap's
        // fonts change underneath it.
        map.basemapLayers.splice(0, 1, {
          id: "place-label",
          type: "symbol",
          layout: { "text-font": ["Noto Sans Regular"] },
        });
        host.changeBasemap("https://example.com/other-style.json");
        map.fire("idle");
        assert.deepEqual(map.layers.get(labelId)?.layout?.["text-font"], ["Noto Sans Regular"]);
      } finally {
        grid.plugin.deactivate(host);
        grid.plugin.applyProjectState?.(host, undefined);
      }
    });

    it("round-trips project state in the persisted key order", () => {
      const host = hostFor(fakeMap());
      assert.equal(grid.plugin.getProjectState?.(), undefined, "defaults persist nothing");
      try {
        grid.setSettings({
          autoResolution: false,
          resolution: grid.resolution,
          fillColor: "#ABCDEF",
          lineWidth: 2.5,
          showLabels: false,
          [grid.parentKey]: true,
        });
        const state = grid.plugin.getProjectState?.() as Settings;
        assert.deepEqual(Object.keys(state), Object.keys(grid.defaults));
        assert.equal(state.fillColor, "#abcdef");
        assert.equal(state.resolution, grid.resolution);
        assert.equal(state[grid.parentKey], true);
        // What a saved project carries is what normalization restores.
        const saved = JSON.parse(JSON.stringify(state));
        assert.deepEqual(grid.normalize(saved), state);

        assert.notEqual(grid.plugin.applyProjectState?.(host, undefined), false);
        assert.deepEqual(grid.getSettings(), grid.defaults);
        assert.equal(grid.plugin.getProjectState?.(), undefined);
        assert.notEqual(grid.plugin.applyProjectState?.(host, saved), false);
        assert.deepEqual(grid.getSettings(), state);
        assert.equal(
          grid.plugin.applyProjectState?.(host, saved),
          false,
          "re-applying the same state is a no-op",
        );
      } finally {
        grid.plugin.applyProjectState?.(host, undefined);
      }
    });

    it("normalizes junk to defaults", () => {
      assert.deepEqual(grid.normalize(undefined), grid.defaults);
      assert.deepEqual(
        grid.normalize({ fillColor: "red", fillOpacity: "x", autoResolution: 1 }),
        grid.defaults,
      );
    });
  });
}

describe("snapToOption", () => {
  it("snaps to the nearest option and keeps the first on a tie", () => {
    const options = [2, 4, 6, 8, 10, 11] as const;
    assert.equal(snapToOption(5, options, 2), 4);
    assert.equal(snapToOption(9, options, 2), 8);
    assert.equal(snapToOption(10.6, options, 2), 11);
    assert.equal(snapToOption(99, options, 2), 11);
    assert.equal(snapToOption("nope", options, 6), 6);
  });
});
