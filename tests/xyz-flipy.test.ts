import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type * as maplibregl from "maplibre-gl";
import {
  DEFAULT_LAYER_STYLE,
  resolveLayerTileAddress,
  resolveTileAddress,
  type GeoLibreLayer,
} from "@geolibre/core";
import { resolveXyzTileUrlTemplate } from "../apps/geolibre-desktop/src/lib/xyz-url";
import { compileArcgisLayer } from "../packages/map/src/arcgis-layers";
import { compileMapboxLayer } from "../packages/map/src/gl-style-compiler";
import { syncLayer } from "../packages/map/src/layer-sync";
import { geojsonLayer } from "./helpers/layer-fixtures";

const NIGHT = "https://www.nightearth.com/nightmap/nightmap2012/{z}/{x}/{-y}.webp";

describe("resolveTileAddress", () => {
  it("flips {-y} without treating it as TMS, and cancels a TMS scheme", () => {
    assert.deepEqual(resolveTileAddress(["https://t/{z}/{x}/{y}.png"]), {
      tiles: ["https://t/{z}/{x}/{y}.png"],
      scheme: "xyz",
    });
    assert.deepEqual(resolveTileAddress(["https://t/{z}/{x}/{-y}.png"]), {
      tiles: ["https://t/{z}/{x}/{y}.png"],
      scheme: "tms",
    });
    assert.deepEqual(resolveTileAddress(["https://t/{z}/{x}/{y}.png"], "tms"), {
      tiles: ["https://t/{z}/{x}/{y}.png"],
      scheme: "tms",
    });
    assert.deepEqual(resolveTileAddress([NIGHT], "tms"), {
      tiles: ["https://www.nightearth.com/nightmap/nightmap2012/{z}/{x}/{y}.webp"],
      scheme: "xyz",
    });
    assert.throws(() => resolveTileAddress(["https://t/{z}/{x}/{y}/{-y}.png"]), /not both/);
    assert.throws(
      () => resolveTileAddress(["https://a/{z}/{x}/{y}.png", "https://b/{z}/{x}/{-y}.png"]),
      /not both/,
    );
    assert.deepEqual(
      resolveTileAddress(["https://a/{z}/{x}/{-y}.png", "https://b/{z}/{x}/{-y}.png"]),
      {
        tiles: ["https://a/{z}/{x}/{y}.png", "https://b/{z}/{x}/{y}.png"],
        scheme: "tms",
      },
    );
  });

  it("applies the row rule only to XYZ layers", () => {
    const tiles = [NIGHT];
    assert.deepEqual(resolveLayerTileAddress({ type: "xyz", source: { scheme: "tms" } }, tiles), {
      tiles: ["https://www.nightearth.com/nightmap/nightmap2012/{z}/{x}/{y}.webp"],
      scheme: "xyz",
    });
    assert.deepEqual(resolveLayerTileAddress({ type: "wms", source: { scheme: "tms" } }, tiles), {
      tiles,
      scheme: "tms",
    });
  });
});

function xyzLayer(source: GeoLibreLayer["source"]): GeoLibreLayer {
  return {
    ...geojsonLayer({ id: "night" }),
    geojson: undefined,
    type: "xyz",
    source: { type: "raster", tileSize: 256, ...source },
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  };
}

describe("XYZ layer renderers", () => {
  it("rejects a direct template that names both row tokens", async () => {
    await assert.rejects(resolveXyzTileUrlTemplate("https://t/{z}/{x}/{y}/{-y}.png"), /not both/);
  });

  it("skips a stored layer with both row tokens and still draws the next layer", () => {
    const sources = new Map<string, { tiles?: string[] }>();
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: { tiles?: string[] }) => sources.set(id, spec),
      getLayer: () => undefined,
      addLayer: () => undefined,
    } as unknown as maplibregl.Map;
    const bad = xyzLayer({ tiles: ["https://t/{z}/{x}/{y}/{-y}.png"] });
    bad.id = "bad";
    const good = xyzLayer({ tiles: ["https://ok/{z}/{x}/{y}.png"] });
    good.id = "good";
    syncLayer(map, bad);
    syncLayer(map, good);
    assert.equal(sources.size, 1);
    assert.equal(sources.get("source-good")?.tiles?.[0], "https://ok/{z}/{x}/{y}.png");
  });

  it("asks MapLibre for a TMS row when the template uses {-y}", () => {
    const sources = new Map<string, maplibregl.RasterSourceSpecification>();
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: maplibregl.RasterSourceSpecification) => sources.set(id, spec),
      getLayer: () => undefined,
      addLayer: () => undefined,
    } as unknown as maplibregl.Map;
    syncLayer(map, xyzLayer({ tiles: [NIGHT] }));
    const spec = [...sources.values()][0];
    assert.equal(spec?.scheme, "tms");
    assert.deepEqual(spec?.tiles, [
      "https://www.nightearth.com/nightmap/nightmap2012/{z}/{x}/{y}.webp",
    ]);
  });

  it("cancels TMS and {-y} down to an XYZ row for MapLibre, ArcGIS, and Mapbox", () => {
    const layer = xyzLayer({ tiles: [NIGHT], scheme: "tms" });
    const sources = new Map<string, maplibregl.RasterSourceSpecification>();
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: maplibregl.RasterSourceSpecification) => sources.set(id, spec),
      getLayer: () => undefined,
      addLayer: () => undefined,
    } as unknown as maplibregl.Map;
    syncLayer(map, layer);
    const spec = [...sources.values()][0];
    assert.equal(spec?.scheme, undefined);
    assert.equal(spec?.tiles?.[0].includes("{-y}"), false);
    assert.match(spec?.tiles?.[0] ?? "", /\{y\}/);

    const arcgis = compileArcgisLayer(layer);
    assert.equal(arcgis.kind, "web-tile");
    if (arcgis.kind === "web-tile") assert.match(arcgis.urlTemplate, /\{row\}/);

    const mapbox = compileMapboxLayer(layer);
    assert.equal(mapbox.source.type, "raster");
    if (mapbox.source.type === "raster") {
      assert.equal(mapbox.source.scheme, undefined);
      assert.equal(mapbox.source.tiles?.[0].includes("{y}"), true);
      assert.equal(mapbox.source.tiles?.[0].includes("{-y}"), false);
    }
  });

  it("draws a bare {-y} template as TMS on ArcGIS and Mapbox", () => {
    const layer = xyzLayer({ tiles: [NIGHT] });
    const arcgis = compileArcgisLayer(layer);
    assert.equal(arcgis.kind, "template-tile");
    if (arcgis.kind === "template-tile") {
      assert.equal(arcgis.scheme, "tms");
      assert.equal(arcgis.templates[0].includes("{-y}"), false);
    }
    const mapbox = compileMapboxLayer(layer);
    if (mapbox.source.type === "raster") assert.equal(mapbox.source.scheme, "tms");
  });
});
