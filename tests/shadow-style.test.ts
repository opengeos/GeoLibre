import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LayerSpecification } from "maplibre-gl";
import { createShadowStyle } from "../packages/map/src/shadow-style";

function setup() {
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  const self = { facade: true };
  const style = createShadowStyle({
    fire: (type, data) => events.push({ type, data }),
    self: () => self,
  });
  return { style, events, self };
}

const raster = (id: string, source: string): LayerSpecification => ({
  id,
  type: "raster",
  source,
});

describe("shadow style", () => {
  it("records sources and layers and reads them back as MapLibre does", () => {
    const { style, self } = setup();
    assert.equal(style.addSource("wms", { type: "raster", tiles: ["https://x/{z}"] }), self);
    style.addLayer(raster("a", "wms"));
    style.addLayer(raster("b", "wms"), "a");
    assert.deepEqual(style.getLayersOrder(), ["b", "a"]);
    assert.deepEqual(style.getSource("wms")?.tiles, ["https://x/{z}"]);
    assert.deepEqual(style.getStyle().sources.wms, { type: "raster", tiles: ["https://x/{z}"] });
    assert.deepEqual(
      style.getStyle().layers.map((layer) => layer.id),
      ["b", "a"],
    );
    style.moveLayer("b");
    assert.deepEqual(style.getLayersOrder(), ["a", "b"]);
    assert.equal(style.getLayer("missing"), undefined);
  });

  it("reports MapLibre's errors as events instead of throwing", () => {
    const { style, events } = setup();
    style.addSource("s", { type: "raster", tiles: [] });
    style.addSource("s", { type: "raster", tiles: [] });
    style.addLayer(raster("l", "nope"));
    style.addLayer(raster("l", "s"));
    style.addLayer(raster("l", "s"));
    style.removeSource("s");
    style.setPaintProperty("missing", "raster-opacity", 1);
    const errors = events.filter((event) => event.type === "error");
    assert.equal(errors.length, 5);
    assert.ok(style.getSource("s"), "a source in use is kept");
    style.removeLayer("l");
    style.removeSource("s");
    assert.equal(style.getSource("s"), undefined);
  });

  it("edits paint, layout and filter, and deletes a property set to null", () => {
    const { style } = setup();
    style.addSource("s", { type: "raster", tiles: [] });
    style.addLayer(raster("l", "s"));
    style.setPaintProperty("l", "raster-opacity", 0.4);
    style.setLayoutProperty("l", "visibility", "none");
    style.setFilter("l", ["==", "a", 1]);
    style.setLayerZoomRange("l", 3, 9);
    assert.deepEqual([style.getLayer("l")?.minzoom, style.getLayer("l")?.maxzoom], [3, 9]);
    assert.equal(style.getPaintProperty("l", "raster-opacity"), 0.4);
    assert.equal(style.getLayoutProperty("l", "visibility"), "none");
    assert.deepEqual(style.getFilter("l"), ["==", "a", 1]);
    style.setLayoutProperty("l", "visibility", null);
    style.setFilter("l", null);
    assert.equal(style.getLayoutProperty("l", "visibility"), undefined);
    assert.equal(style.getFilter("l"), undefined);
  });

  it("registers an inline layer source under the layer id", () => {
    const { style } = setup();
    style.addLayer({
      id: "inline",
      type: "circle",
      source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    });
    assert.equal(style.getSource("inline")?.type, "geojson");
    assert.equal((style.getLayer("inline") as { source: string }).source, "inline");
  });

  it("updates a source through its mutators", () => {
    const { style } = setup();
    style.addSource("g", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    const data = { type: "FeatureCollection", features: [{ type: "Feature" }] };
    style.getSource("g")?.setData(data);
    assert.deepEqual(style.getSource("g")?.data, data);
    assert.deepEqual(style.getSource("g")?.serialize(), { type: "geojson", data });
  });

  it("hands out copies, so callers cannot edit the recorded style", () => {
    const { style } = setup();
    style.addSource("s", { type: "raster", tiles: ["a"] });
    style.addLayer({ ...raster("l", "s"), paint: { "raster-opacity": 1 } });
    (style.getLayer("l") as { paint: Record<string, number> }).paint["raster-opacity"] = 0;
    style.getStyle().layers.pop();
    assert.equal(style.getPaintProperty("l", "raster-opacity"), 1);
    assert.deepEqual(style.getLayersOrder(), ["l"]);
  });

  it("fires one styledata per burst of edits, after the calls return", async () => {
    const { style, events } = setup();
    style.addSource("s", { type: "raster", tiles: [] });
    style.addLayer(raster("a", "s"));
    style.addLayer(raster("b", "s"));
    assert.equal(events.length, 0, "nothing fires synchronously");
    await Promise.resolve();
    assert.equal(events.filter((event) => event.type === "styledata").length, 1);
    assert.deepEqual(
      events.filter((event) => event.type === "sourcedata").map((event) => event.data?.sourceId),
      ["s"],
    );
  });
});
