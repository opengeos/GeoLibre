import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyProjectToStore, createEmptyProject, parseProject, useAppStore } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";

const tile =
  "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/119/{z}/{y}/{x}";

function imagery(source: Record<string, unknown> = { tiles: [tile], url: tile, tileSize: 256 }) {
  return geojsonLayer({ type: "wmts", source });
}

describe("Wayback tile source zoom limits", () => {
  it("repairs the legacy 3D Tiles demo source on project load without mutating it", () => {
    const layer = imagery();
    const project = { ...createEmptyProject(), layers: [layer] };
    assert.equal(parseProject(JSON.stringify(project)).layers[0].source.maxzoom, 19);
    assert.equal(applyProjectToStore(project).layers[0].source.maxzoom, 19);
    assert.equal(layer.source.maxzoom, undefined);
  });

  it("defaults newly added Wayback imagery to its native maximum zoom", () => {
    const layer = imagery();
    useAppStore.getState().addLayer(layer);
    assert.equal(
      useAppStore.getState().layers.find(({ id }) => id === layer.id)?.source.maxzoom,
      19,
    );
    useAppStore.getState().removeLayer(layer.id);
  });

  it("repairs null and non-numeric limits in saved JSON", () => {
    for (const maxzoom of [null, "19"]) {
      const project = { ...createEmptyProject(), layers: [imagery({ tiles: [tile], maxzoom })] };
      assert.equal(parseProject(JSON.stringify(project)).layers[0].source.maxzoom, 19);
    }
  });

  it("ignores string minzoom as the renderers do", () => {
    const project = {
      ...createEmptyProject(),
      layers: [imagery({ tiles: [tile], minzoom: "20" })],
    };
    assert.equal(parseProject(JSON.stringify(project)).layers[0].source.maxzoom, 19);
  });

  it("preserves explicit limits and unrelated sources", () => {
    const sources = [
      { tiles: [tile], maxzoom: 17 },
      { tiles: [tile], maxzoom: 22 },
      { tiles: [tile], minzoom: 20 },
      { tiles: [42] },
      {},
      { tiles: ["https://example.com/{z}/{x}/{y}.png"] },
      { tiles: [tile.replace("arcgis.com/", "arcgis.com.example.org/")] },
      { tiles: [tile, "https://example.com/{z}/{x}/{y}.png"] },
      { url: "invalid URL" },
    ];
    for (const source of sources) {
      const project = { ...createEmptyProject(), layers: [imagery(source)] };
      assert.deepEqual(parseProject(JSON.stringify(project)).layers[0].source, source);
    }
  });

  it("recognizes URL-only Wayback templates and subdomains", () => {
    for (const url of [
      tile,
      tile.replace("wayback.", "wayback-a."),
      tile.replace("/MapServer/", "/WMTS/1.0.0/default028mm/MapServer/"),
    ]) {
      const project = { ...createEmptyProject(), layers: [imagery({ url })] };
      assert.equal(parseProject(JSON.stringify(project)).layers[0].source.maxzoom, 19);
    }
  });
});
