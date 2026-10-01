import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  extractLayerStyleEntries,
  findLayerStyleEntry,
  LAYER_STYLES_FILE_TYPE,
  layerStylePatchFromEntries,
  normalizeLayerStyleEntries,
  parseLayerStylesFile,
  serializeLayerStylesFile,
  useAppStore,
  type GeoLibreLayer,
  type LayerStyleFileEntry,
} from "@geolibre/core";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { RASTER_SOURCE_KIND } from "../packages/plugins/src/plugins/raster-layer-sync";

function vectorLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "vec",
    name: "Roads",
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

function rasterLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "ras",
    name: "Elevation",
    type: "cog",
    source: { type: "raster" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      sourceKind: RASTER_SOURCE_KIND,
      rasterState: { mode: "single", bands: [1], colormap: "viridis", rescale: [[0, 100]] },
    },
    ...patch,
  };
}

function vectorEntry(layerName: string, fillColor: string): LayerStyleFileEntry {
  return { layerName, kind: "vector", style: { ...DEFAULT_LAYER_STYLE, fillColor } };
}

describe("layer styles file round trip", () => {
  it("exports stylable layers and skips the rest", () => {
    const entries = extractLayerStyleEntries([
      vectorLayer({ style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" } }),
      rasterLayer(),
      vectorLayer({ id: "tiles", name: "Basemap", type: "xyz" }),
    ]);
    assert.deepEqual(
      entries.map((entry) => [entry.layerName, entry.kind]),
      [
        ["Roads", "vector"],
        ["Elevation", "raster"],
      ],
    );
    const parsed = parseLayerStylesFile(serializeLayerStylesFile(entries));
    assert.equal(parsed[0].kind === "vector" && parsed[0].style.fillColor, "#ff0000");
    assert.equal(parsed[1].kind === "raster" && parsed[1].rasterState?.colormap, "viridis");
  });

  it("rejects files that are not layer styles files", () => {
    assert.throws(() => parseLayerStylesFile("not json"), /invalid JSON/);
    assert.throws(() => parseLayerStylesFile('{"type":"other"}'), /Not a valid/);
    assert.throws(
      () => parseLayerStylesFile(JSON.stringify({ type: LAYER_STYLES_FILE_TYPE, version: 99 })),
      /Unsupported/,
    );
    assert.throws(
      () =>
        parseLayerStylesFile(JSON.stringify({ type: LAYER_STYLES_FILE_TYPE, version: 1, styles: [] })),
      /no usable styles/,
    );
  });

  it("drops unusable entries and sanitizes vector styles", () => {
    const entries = normalizeLayerStyleEntries([
      { layerName: "", kind: "vector", style: {} },
      { layerName: "Lakes", kind: "mystery" },
      { layerName: "Lakes", kind: "vector", style: { fillColor: "#00f", bogus: 1, opacity: "x" } },
    ]);
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.ok(entry.kind === "vector");
    assert.equal(entry.style.fillColor, "#00f");
    assert.equal(entry.style.strokeColor, DEFAULT_LAYER_STYLE.strokeColor);
    assert.equal("bogus" in entry.style, false);
  });
});

describe("matching styles to layers by name", () => {
  it("prefers an exact name, then ignores case and surrounding whitespace", () => {
    const entries = [vectorEntry(" roads ", "#111111"), vectorEntry("Roads", "#222222")];
    assert.equal(findLayerStyleEntry(entries, "Roads")?.layerName, "Roads");
    assert.equal(findLayerStyleEntry(entries, "ROADS")?.layerName, " roads ");
    assert.equal(findLayerStyleEntry(entries, "Rivers"), undefined);
  });

  it("only applies an entry of the layer's style family", () => {
    const entries: LayerStyleFileEntry[] = [
      { layerName: "Roads", kind: "raster", rasterState: { colormap: "magma" } },
    ];
    assert.equal(layerStylePatchFromEntries(vectorLayer(), entries), null);
    entries.push(vectorEntry("Roads", "#abcdef"));
    assert.equal(layerStylePatchFromEntries(vectorLayer(), entries)?.style?.fillColor, "#abcdef");
  });

  it("keeps a raster's band selection and layer opacity", () => {
    const patch = layerStylePatchFromEntries(rasterLayer({ opacity: 0.4 }), [
      {
        layerName: "Elevation",
        kind: "raster",
        rasterState: { mode: "rgb", bands: [3, 2, 1], colormap: "terrain" },
      },
    ]);
    const state = patch?.metadata?.rasterState as Record<string, unknown>;
    assert.equal(state.colormap, "terrain");
    assert.equal(state.mode, "single");
    assert.deepEqual(state.bands, [1]);
    assert.equal(patch && "opacity" in patch, false);
  });
});

describe("applyLayerStyleEntries", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Styles" });
  });

  it("restyles matching layers in one update and reports them", () => {
    const store = useAppStore.getState();
    store.addLayer(vectorLayer({ id: "a", name: "Roads" }));
    store.addLayer(vectorLayer({ id: "b", name: "Rivers" }));
    store.addLayer(vectorLayer({ id: "c", name: "roads" }));
    const applied = useAppStore
      .getState()
      .applyLayerStyleEntries([vectorEntry("Roads", "#123456")], ["a", "b"]);
    assert.deepEqual(applied, ["a"]);
    const byId = new Map(useAppStore.getState().layers.map((layer) => [layer.id, layer]));
    assert.equal(byId.get("a")?.style.fillColor, "#123456");
    assert.equal(byId.get("b")?.style.fillColor, DEFAULT_LAYER_STYLE.fillColor);
    // Outside the requested ids, so untouched despite matching the name.
    assert.equal(byId.get("c")?.style.fillColor, DEFAULT_LAYER_STYLE.fillColor);
    assert.equal(useAppStore.getState().isDirty, true);
  });

  it("leaves the store alone when nothing matches", () => {
    useAppStore.getState().addLayer(vectorLayer({ id: "a", name: "Roads" }));
    useAppStore.getState().markSaved();
    const before = useAppStore.getState().layers;
    assert.deepEqual(useAppStore.getState().applyLayerStyleEntries([vectorEntry("X", "#000")]), []);
    assert.equal(useAppStore.getState().layers, before);
    assert.equal(useAppStore.getState().isDirty, false);
  });
});

describe("startup layer styles setting", () => {
  it("keeps a usable file and drops an unusable one", () => {
    const kept = normalizeDesktopSettings({
      startup: {
        layerStyles: {
          fileName: "styles.json",
          path: "/tmp/styles.json",
          entries: [vectorEntry("Roads", "#ff00ff")],
        },
      },
    }).startup.layerStyles;
    assert.equal(kept?.fileName, "styles.json");
    assert.equal(kept?.entries.length, 1);
    assert.equal(
      normalizeDesktopSettings({ startup: { layerStyles: { fileName: "x", entries: [] } } }).startup
        .layerStyles,
      null,
    );
  });
});
