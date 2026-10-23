import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import { createPluginLayerStyleActions } from "../apps/geolibre-desktop/src/lib/plugin-layer-style";
import { NULL_GEOMETRY } from "./helpers/null-geometry";

// A cut-down GeoServer `GetStyles` answer: a style categorized on one field,
// shaped like the Liguria land-cover SLD (geoservizi.regione.liguria.it, M5:L4).
const SLD = `<?xml version="1.0" encoding="UTF-8"?>
<sld:StyledLayerDescriptor xmlns:sld="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc" version="1.0.0">
  <sld:NamedLayer><sld:Name>M5:L4</sld:Name><sld:UserStyle><sld:FeatureTypeStyle>
    <sld:Rule>
      <sld:Title>1.1.1 = tessuto urbano continuo</sld:Title>
      <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>classe</ogc:PropertyName><ogc:Literal>1.1.1</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
      <sld:PolygonSymbolizer><sld:Fill><sld:CssParameter name="fill">#961E1E</sld:CssParameter></sld:Fill></sld:PolygonSymbolizer>
    </sld:Rule>
    <sld:Rule>
      <sld:Title>3.1.1 = boschi di latifoglie</sld:Title>
      <ogc:Filter><ogc:PropertyIsEqualTo><ogc:PropertyName>classe</ogc:PropertyName><ogc:Literal>3.1.1</ogc:Literal></ogc:PropertyIsEqualTo></ogc:Filter>
      <sld:PolygonSymbolizer><sld:Fill><sld:CssParameter name="fill">#50A01E</sld:CssParameter></sld:Fill></sld:PolygonSymbolizer>
    </sld:Rule>
  </sld:FeatureTypeStyle></sld:UserStyle></sld:NamedLayer>
</sld:StyledLayerDescriptor>`;

function addLayer(): string {
  return useAppStore.getState().addGeoJsonLayer("Land cover", {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { classe: "1.1.1" }, geometry: NULL_GEOMETRY }],
  });
}

function styleOf(layerId: string) {
  return useAppStore.getState().layers.find((layer) => layer.id === layerId)!.style;
}

describe("external plugin layer style API", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Plugin layer style" });
  });

  it("applies an SLD categorized style to a layer", () => {
    const layerId = addLayer();
    const result = createPluginLayerStyleActions().importLayerStyle(layerId, SLD);
    assert.deepEqual(result, { ok: true, warnings: [] });
    const style = styleOf(layerId);
    assert.equal(style.vectorStyleMode, "categorized");
    assert.equal(style.vectorStyleProperty, "classe");
    assert.deepEqual(
      style.vectorStyleStops.map(({ value, color }) => [value, color]),
      [
        ["1.1.1", "#961E1E"],
        ["3.1.1", "#50A01E"],
      ],
    );
  });

  it("merges over the current style instead of replacing it", () => {
    const layerId = addLayer();
    useAppStore.getState().setLayerStyle(layerId, { strokeWidth: 4 });
    createPluginLayerStyleActions().importLayerStyle(layerId, SLD);
    assert.equal(styleOf(layerId).strokeWidth, 4);
  });

  it("leaves the layer untouched when the text is not a style", () => {
    const layerId = addLayer();
    const before = styleOf(layerId);
    const result = createPluginLayerStyleActions().importLayerStyle(layerId, "not a style");
    assert.deepEqual(result, { ok: false, reason: "invalid", warnings: [] });
    assert.deepEqual(styleOf(layerId), before);
  });

  it("leaves a raster layer untouched, as the Layers panel import does", () => {
    const layerId = useAppStore.getState().addTileLayer("Orthophoto", {
      type: "wms",
      tiles: ["https://x.test/wms?BBOX={bbox-epsg-3857}"],
      url: "https://x.test/wms",
    });
    const before = styleOf(layerId);
    const result = createPluginLayerStyleActions().importLayerStyle(layerId, SLD);
    assert.deepEqual(result, { ok: false, reason: "unsupported-layer", warnings: [] });
    assert.deepEqual(styleOf(layerId), before);
  });

  it("throws for an unknown layer id", () => {
    assert.throws(
      () => createPluginLayerStyleActions().importLayerStyle("missing", SLD),
      /No layer with id "missing"/,
    );
  });
});
