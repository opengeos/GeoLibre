import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BLANK_BASEMAP, DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import {
  ARCGIS_HEIGHT_FIELD,
  ARCGIS_ID_FIELD,
  ARCGIS_LABEL_FIELD,
  ARCGIS_SYMBOL_FIELD,
  compileArcgisLayer,
  cssToArcgisColor,
  featurePassesFilters,
  filterToSql,
  geometryContainsPoint,
  isArcgisPluginLayer,
  isMarkerPlaceholder,
  isArcgisSupportedLayer,
  scaleToZoom,
  webTileTemplate,
  wmsLayerFromTemplate,
  zoomRangeToScales,
  zoomToScale,
} from "../packages/map/src/arcgis-layers";
import { planArcgisBasemap } from "../packages/map/src/arcgis-basemap";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The compiler is pure: it never touches the SDK, so these tests exercise the
// translation from store layers to the plain plans the engine instantiates —
// which layer kinds have a translation, how the per-feature symbology is baked
// into the features, and how templates and colours are rewritten.

const mixed = geojsonLayer({
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "poly",
        properties: { kind: "park", name: "Green" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: { kind: "road", name: "Main" },
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [2, 2],
          ],
        },
      },
      {
        type: "Feature",
        properties: { kind: "stop", name: "A" },
        geometry: {
          type: "MultiPoint",
          coordinates: [
            [3, 3],
            [4, 4],
          ],
        },
      },
    ],
  },
});

describe("ArcGIS scale and colour conversions", () => {
  it("round-trips MapLibre zooms through the SDK's scale denominators", () => {
    assert.ok(Math.abs(zoomToScale(0) - 591657527.591555) < 1e-3);
    assert.ok(Math.abs(scaleToZoom(zoomToScale(12.5)) - 12.5) < 1e-9);
    // 0 lifts a bound; only a restricted range produces a scale.
    assert.deepEqual(zoomRangeToScales(0, 24), { minScale: 0, maxScale: 0 });
    const scales = zoomRangeToScales(5, 15);
    assert.ok(scales.minScale > scales.maxScale && scales.maxScale > 0);
  });
  it("parses the colour forms the style engine and the Style panel produce", () => {
    assert.deepEqual(cssToArcgisColor("#ff0000"), [255, 0, 0, 1]);
    assert.deepEqual(cssToArcgisColor("#f00", 0.5), [255, 0, 0, 0.5]);
    assert.deepEqual(cssToArcgisColor("#00ff0080"), [0, 255, 0, 128 / 255]);
    assert.deepEqual(cssToArcgisColor("rgba(1, 2, 3, 0.25)", 0.5), [1, 2, 3, 0.125]);
    assert.deepEqual(cssToArcgisColor("rgb(10,20,30)"), [10, 20, 30, 1]);
    assert.deepEqual(cssToArcgisColor("nonsense", 0.3), [0, 0, 0, 0.3]);
  });
});

describe("ArcGIS tile and WMS templates", () => {
  it("rewrites {z}/{x}/{y} into the SDK's placeholders and expands subdomains", () => {
    assert.deepEqual(webTileTemplate("https://t.example/{z}/{x}/{y}.png"), {
      urlTemplate: "https://t.example/{level}/{col}/{row}.png",
    });
    assert.deepEqual(webTileTemplate("https://{s}.t.example/{z}/{x}/{y}.png"), {
      urlTemplate: "https://{subDomain}.t.example/{level}/{col}/{row}.png",
      subDomains: ["a", "b", "c"],
    });
    assert.deepEqual(webTileTemplate("https://{a-d}.t.example/{z}/{x}/{y}.png").subDomains, [
      "a",
      "b",
      "c",
      "d",
    ]);
  });
  it("rejects placeholders the SDK cannot express", () => {
    assert.throws(() => webTileTemplate("https://t.example/{z}/{x}/{-y}.png"), /not supported/);
    assert.throws(() => webTileTemplate("https://t.example/{quadkey}.png"), /not supported/);
    assert.throws(() => webTileTemplate("https://t.example/tile.png"), /no \{z\}/);
  });
  it("splits a GetMap template into the SDK's WMS description", () => {
    const wms = wmsLayerFromTemplate(
      "https://wms.example/ows?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=a,b&STYLES=&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}&TIME=2024-01-01",
    );
    assert.equal(wms.url, "https://wms.example/ows");
    assert.deepEqual(wms.sublayers, [{ name: "a" }, { name: "b" }]);
    assert.equal(wms.version, "1.3.0");
    assert.equal(wms.imageFormat, "image/png");
    assert.equal(wms.imageTransparency, true);
    assert.deepEqual(wms.customParameters, { TIME: "2024-01-01" });
    assert.throws(() => wmsLayerFromTemplate("https://wms.example/ows?SERVICE=WMS"), /no layers/);
  });
});

describe("ArcGIS GeoJSON compilation", () => {
  it("splits mixed geometry into one part per SDK geometry kind, exploding multipoints", () => {
    const plan = compileArcgisLayer(mixed);
    assert.equal(plan.kind, "geojson");
    if (plan.kind !== "geojson") return;
    assert.deepEqual(
      plan.parts.map((p) => p.geometryType),
      ["polygon", "polyline", "point"],
    );
    const points = plan.parts[2].features!.features;
    assert.equal(points.length, 2);
    // Both exploded points keep the feature's identity (its index, lacking an id).
    assert.ok(points.every((f) => f.properties?.[ARCGIS_ID_FIELD] === "2"));
    assert.equal(plan.parts[0].features!.features[0].properties?.[ARCGIS_ID_FIELD], "poly");
    // A single symbol per part collapses to a simple renderer.
    assert.equal(plan.parts[0].renderer.type, "simple");
    assert.equal(plan.opacity, 1);
    assert.equal(plan.visible, true);
    assert.equal(plan.zoomDependent, false);
  });
  it("bakes data-driven colours into a unique-value renderer over the symbol key", () => {
    const layer = geojsonLayer({
      ...mixed,
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleMode: "categorized",
        vectorStyleProperty: "kind",
        vectorStyleStops: [
          { value: "park", color: "#00ff00" },
          { value: "stop", color: "#ff0000" },
        ],
      },
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { kind: "park" },
            geometry: { type: "Point", coordinates: [0, 0] },
          },
          {
            type: "Feature",
            properties: { kind: "stop" },
            geometry: { type: "Point", coordinates: [1, 1] },
          },
          {
            type: "Feature",
            properties: { kind: "stop" },
            geometry: { type: "Point", coordinates: [2, 2] },
          },
        ],
      },
    });
    const plan = compileArcgisLayer(layer);
    if (plan.kind !== "geojson") throw new Error("expected geojson");
    const [part] = plan.parts;
    assert.equal(part.renderer.type, "unique-value");
    if (part.renderer.type !== "unique-value") return;
    assert.equal(part.renderer.field, ARCGIS_SYMBOL_FIELD);
    assert.equal(part.renderer.uniqueValueInfos.length, 2);
    const colors = part.renderer.uniqueValueInfos.map((info) =>
      (info.symbol.color as number[]).slice(0, 3).join(","),
    );
    assert.deepEqual(colors.sort(), ["0,255,0", "255,0,0"]);
    // Every feature's key names one of the renderer's symbols.
    const keys = new Set(part.renderer.uniqueValueInfos.map((info) => info.value));
    assert.ok(
      part.features!.features.every((f) => keys.has(String(f.properties?.[ARCGIS_SYMBOL_FIELD]))),
    );
  });
  it("evaluates label text per feature and emits an Arcade label class", () => {
    const layer = geojsonLayer({
      ...mixed,
      style: {
        ...DEFAULT_LAYER_STYLE,
        labels: {
          ...DEFAULT_LAYER_STYLE.labels,
          enabled: true,
          field: "name",
          transform: "uppercase",
        },
      },
    });
    const plan = compileArcgisLayer(layer);
    if (plan.kind !== "geojson") throw new Error("expected geojson");
    assert.equal(plan.parts[0].features!.features[0].properties?.[ARCGIS_LABEL_FIELD], "GREEN");
    const labeling = plan.parts[0].labelingInfo!;
    assert.equal(labeling[0].labelExpressionInfo.expression, `$feature.${ARCGIS_LABEL_FIELD}`);
    assert.equal(labeling[0].labelPlacement, "always-horizontal");
    // The default anchor is "center"; a bottom anchor puts the text above.
    assert.equal(plan.parts[2].labelingInfo![0].labelPlacement, "center-center");
    const anchored = compileArcgisLayer({
      ...layer,
      style: { ...layer.style, labels: { ...layer.style.labels, anchor: "bottom" } },
    });
    if (anchored.kind === "geojson")
      assert.equal(anchored.parts[2].labelingInfo![0].labelPlacement, "above-center");
    assert.equal(labeling[0].symbol.type, "text");
  });
  it("applies the layer's filters before handing features to the SDK", () => {
    const layer = geojsonLayer({
      ...mixed,
      embedFilter: ["==", ["get", "kind"], "road"],
    });
    const plan = compileArcgisLayer(layer);
    if (plan.kind !== "geojson") throw new Error("expected geojson");
    assert.deepEqual(
      plan.parts.map((p) => p.geometryType),
      ["polyline"],
    );
  });
  it("flags zoom-dependent symbology so the engine recompiles on zoom", () => {
    const layer = geojsonLayer({
      ...mixed,
      style: { ...DEFAULT_LAYER_STYLE, strokeWidthUnit: "meters", strokeWidth: 50 },
    });
    assert.equal(compileArcgisLayer(layer).zoomDependent, true);
  });
  it("stands in a marker placeholder for Style-panel markers and uses KML icons directly", () => {
    const points = geojsonLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        markerEnabled: true,
        markerShape: "star",
        markerColor: "#ff0000",
      },
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
          {
            type: "Feature",
            properties: { __geolibre_kml_icon_url: "https://example.com/pin.png" },
            geometry: { type: "Point", coordinates: [1, 1] },
          },
        ],
      },
    });
    const plan = compileArcgisLayer(points);
    if (plan.kind !== "geojson") throw new Error("expected geojson");
    const [part] = plan.parts;
    assert.ok(part.markerStyle, "marker style travels with the part");
    if (part.renderer.type !== "unique-value") throw new Error("expected two symbols");
    const [marker, icon] = part.renderer.uniqueValueInfos.map((info) => info.symbol);
    assert.ok(isMarkerPlaceholder(marker));
    assert.equal((marker as { color: string }).color, "#ff0000");
    assert.equal((marker as { fallback: { type: string } }).fallback.type, "simple-marker");
    assert.equal(icon.type, "picture-marker");
    assert.equal(icon.url, "https://example.com/pin.png");
    // Without markers the point symbol is the plain circle.
    const plain = compileArcgisLayer(mixed);
    if (plain.kind === "geojson") assert.equal(plain.parts[2].markerStyle, undefined);
  });
  it("tests geometry against a point for the synchronous identify", () => {
    const square: import("geojson").Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    };
    assert.equal(geometryContainsPoint(square, [1, 1], 0), true);
    assert.equal(geometryContainsPoint(square, [3, 1], 0), false);
    const donut: import("geojson").Geometry = {
      type: "Polygon",
      coordinates: [
        square.coordinates[0],
        [
          [0.5, 0.5],
          [1.5, 0.5],
          [1.5, 1.5],
          [0.5, 1.5],
          [0.5, 0.5],
        ],
      ],
    };
    assert.equal(geometryContainsPoint(donut, [1, 1], 0), false);
    const line: import("geojson").Geometry = {
      type: "LineString",
      coordinates: [
        [0, 0],
        [10, 0],
      ],
    };
    assert.equal(geometryContainsPoint(line, [5, 0.05], 0.1), true);
    assert.equal(geometryContainsPoint(line, [5, 0.5], 0.1), false);
    assert.equal(
      geometryContainsPoint(
        {
          type: "MultiPoint",
          coordinates: [
            [3, 3],
            [4, 4],
          ],
        },
        [4.01, 4],
        0.05,
      ),
      true,
    );
    assert.equal(featurePassesFilters(mixed, mixed.geojson!.features[0], 10), true);
    assert.equal(
      featurePassesFilters(
        { ...mixed, embedFilter: ["==", ["get", "kind"], "road"] },
        mixed.geojson!.features[0],
        10,
      ),
      false,
    );
  });
  it("probes support without processing features", () => {
    const plan = compileArcgisLayer(mixed, { probe: true });
    assert.equal(plan.kind, "geojson");
    if (plan.kind === "geojson") assert.equal(plan.parts.length, 0);
    assert.equal(isArcgisSupportedLayer(mixed), true);
  });
  it("draws a remote GeoJSON URL flat through the SDK's own fetch", () => {
    const layer = geojsonLayer({
      geojson: undefined,
      source: { type: "geojson", url: "https://example.com/data.geojson" },
    });
    const plan = compileArcgisLayer(layer);
    if (plan.kind !== "geojson") throw new Error("expected geojson");
    assert.equal(plan.parts.length, 3);
    assert.ok(plan.parts.every((p) => p.url === "https://example.com/data.geojson" && !p.features));
    assert.equal(plan.zoomDependent, false);
    const metres = compileArcgisLayer({
      ...layer,
      style: { ...DEFAULT_LAYER_STYLE, strokeWidthUnit: "meters", strokeWidth: 50 },
    });
    assert.equal(metres.zoomDependent, true);
  });
});

describe("ArcGIS raster, service and media compilation", () => {
  it("compiles XYZ tiles into a WebTileLayer plan with copyright and bounds", () => {
    const layer: GeoLibreLayer = {
      ...geojsonLayer({ geojson: undefined }),
      type: "xyz",
      source: {
        type: "raster",
        tiles: ["https://tiles.example/{z}/{x}/{y}.png"],
        attribution: "© Tiles",
        bounds: [-10, -5, 10, 5],
      },
      style: { ...DEFAULT_LAYER_STYLE, minZoom: 3, maxZoom: 18 },
      opacity: 0.5,
    };
    const plan = compileArcgisLayer(layer);
    assert.equal(plan.kind, "web-tile");
    if (plan.kind !== "web-tile") return;
    assert.equal(plan.urlTemplate, "https://tiles.example/{level}/{col}/{row}.png");
    assert.equal(plan.copyright, "© Tiles");
    assert.deepEqual(plan.bounds, [-10, -5, 10, 5]);
    assert.equal(plan.opacity, 0.5);
    assert.ok(plan.minScale > 0 && plan.maxScale > 0);
  });
  it("compiles a WMS record into a WMSLayer plan outside the dev server", () => {
    const layer: GeoLibreLayer = {
      ...geojsonLayer({ geojson: undefined }),
      type: "wms",
      source: {
        type: "raster",
        tiles: [
          "https://wms.example/ows?SERVICE=WMS&REQUEST=GetMap&LAYERS=roads&FORMAT=image/png&BBOX={bbox-epsg-3857}",
        ],
      },
    };
    const plan = compileArcgisLayer(layer);
    assert.equal(plan.kind, "wms");
    if (plan.kind === "wms") assert.deepEqual(plan.sublayers, [{ name: "roads" }]);
  });
  it("turns vector tiles into a Mapbox style document without symbol layers", () => {
    const layer: GeoLibreLayer = {
      ...geojsonLayer({ geojson: undefined }),
      type: "vector-tiles",
      source: {
        type: "vector",
        tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"],
        sourceLayers: ["water"],
      },
      style: {
        ...DEFAULT_LAYER_STYLE,
        labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name" },
      },
    };
    const plan = compileArcgisLayer(layer);
    assert.equal(plan.kind, "vector-tile");
    if (plan.kind !== "vector-tile") return;
    const style = plan.style as { version: number; sources: object; layers: { type: string }[] };
    assert.equal(style.version, 8);
    assert.equal(Object.keys(style.sources).length, 1);
    assert.ok(style.layers.length >= 3);
    assert.ok(style.layers.every((l) => l.type !== "symbol"));
    // Opacity and visibility are native layer properties, so the style must
    // not change with them — otherwise every slider tick rebuilds the layer.
    const faded = compileArcgisLayer({ ...layer, opacity: 0.3, visible: false });
    if (faded.kind !== "vector-tile") return;
    assert.deepEqual(faded.style, plan.style);
    assert.equal(faded.opacity, 0.3);
    assert.equal(faded.visible, false);
  });
  it("names the SDK's service class for an ArcGIS service record", () => {
    const base = geojsonLayer({ geojson: undefined });
    const feature: GeoLibreLayer = {
      ...base,
      type: "arcgis",
      source: { type: "geojson", url: "https://host/arcgis/rest/services/X/FeatureServer/0" },
    };
    assert.equal(compileArcgisLayer(feature).kind, "feature-service");
    // Filters reach the service as SQL; one with no SQL form is reported.
    const filtered = compileArcgisLayer({
      ...feature,
      quickFilters: [
        { id: "a", field: "STATE", kind: "categorical", values: ["TN", "GA"] },
        { id: "b", field: "POP", kind: "range", min: 1000, max: null },
      ],
    } as GeoLibreLayer);
    if (filtered.kind !== "feature-service") throw new Error("expected feature-service");
    // The range quick filter guards its comparison with `["has", field]`.
    assert.equal(
      filtered.definitionExpression,
      "(STATE IN ('TN', 'GA')) AND ((POP IS NOT NULL) AND (POP >= 1000))",
    );
    assert.equal(filtered.filterUnsupported, undefined);
    const odd = compileArcgisLayer({
      ...feature,
      embedFilter: ["==", ["geometry-type"], "Point"],
    });
    if (odd.kind !== "feature-service") throw new Error("expected feature-service");
    assert.equal(odd.definitionExpression, undefined);
    assert.equal(odd.filterUnsupported, true);
    const image: GeoLibreLayer = {
      ...base,
      type: "arcgis",
      source: { type: "raster", url: "https://host/arcgis/rest/services/X/ImageServer" },
    };
    assert.equal(compileArcgisLayer(image).kind, "imagery");
    const tiled: GeoLibreLayer = {
      ...base,
      type: "arcgis",
      source: { type: "raster", url: "https://host/arcgis/rest/services/X/MapServer" },
      metadata: { arcgisTiled: true },
    };
    assert.equal(compileArcgisLayer(tiled).kind, "tile-service");
    const dynamic: GeoLibreLayer = { ...tiled, metadata: {} };
    assert.equal(compileArcgisLayer(dynamic).kind, "map-image");
  });
  it("georeferences an image overlay by the extent of its corners", () => {
    const layer: GeoLibreLayer = {
      ...geojsonLayer({ geojson: undefined }),
      type: "image",
      source: {
        type: "image",
        url: "https://example.com/a.png",
        coordinates: [
          [0, 2],
          [3, 2],
          [3, 0],
          [0, 0],
        ],
      },
    };
    const plan = compileArcgisLayer(layer);
    assert.equal(plan.kind, "media-image");
    if (plan.kind === "media-image") {
      assert.deepEqual(plan.extent, [0, 0, 3, 2]);
      assert.deepEqual(plan.corners, [
        [0, 2],
        [3, 2],
        [3, 0],
        [0, 0],
      ]);
    }
  });
  it("rejects archives, custom protocols and plugin-owned mirrors", () => {
    const base = geojsonLayer({ geojson: undefined });
    assert.throws(
      () =>
        compileArcgisLayer({ ...base, type: "pmtiles", source: { url: "https://x/a.pmtiles" } }),
      /not supported/,
    );
    assert.throws(
      () =>
        compileArcgisLayer({
          ...base,
          type: "xyz",
          source: { type: "raster", tiles: ["cog://https://x/a.tif/{z}/{x}/{y}"] },
        }),
      /not supported/,
    );
    const mirror: GeoLibreLayer = {
      ...base,
      type: "raster",
      source: { sourceId: "x" },
      metadata: { externalNativeLayer: true, nativeLayerIds: ["a"] },
    };
    assert.equal(isArcgisPluginLayer(mirror), true);
    assert.equal(isArcgisSupportedLayer(mirror), false);
    assert.equal(isArcgisSupportedLayer({ ...base, type: "mbtiles", source: {} }), false);
  });
});

describe("ArcGIS SQL filter translation", () => {
  it("translates comparisons, sets, null checks and boolean combinators", () => {
    assert.equal(filterToSql(["==", ["get", "a"], 1]), "a = 1");
    assert.equal(filterToSql(["!=", ["get", "a"], "x'y"]), "a <> 'x''y'");
    assert.equal(filterToSql([">=", ["to-number", ["get", "n"]], 5]), "n >= 5");
    assert.equal(filterToSql(["==", ["get", "a"], null]), "a IS NULL");
    assert.equal(filterToSql(["has", "a"]), "a IS NOT NULL");
    assert.equal(filterToSql(["in", ["get", "a"], ["literal", ["x", 2]]]), "a IN ('x', 2)");
    assert.equal(
      filterToSql(["any", ["==", ["get", "a"], 1], ["!", ["has", "b"]]]),
      "(a = 1) OR (NOT (b IS NOT NULL))",
    );
  });
  it("translates the quick text filter's three operators", () => {
    const hay = ["downcase", ["to-string", ["get", "name"]]];
    assert.equal(filterToSql(["==", hay, "ab"]), "UPPER(name) = 'AB'");
    assert.equal(
      filterToSql(["==", ["index-of", "a_b", hay], 0]),
      "UPPER(name) LIKE 'A\\_B%' ESCAPE '\\'",
    );
    assert.equal(
      filterToSql(["!=", ["index-of", "50%", hay], -1]),
      "UPPER(name) LIKE '%50\\%%' ESCAPE '\\'",
    );
  });
  it("refuses what SQL cannot express", () => {
    assert.equal(filterToSql(["==", ["geometry-type"], "Point"]), null);
    assert.equal(filterToSql(["<", ["get", "bad name"], 1]), null);
    assert.equal(filterToSql(["all", ["==", ["get", "a"], 1], ["within", {}]]), null);
    assert.equal(
      filterToSql(["==", ["slice", ["to-string", ["get", "d"]], 0, 10], "2024-01-01"]),
      null,
    );
  });
});

describe("ArcGIS basemap planning", () => {
  it("uses an Esri style only with an API key, else translates the shared basemap", () => {
    assert.deepEqual(planArcgisBasemap(undefined, "arcgis/streets", true), {
      kind: "esri-style",
      id: "arcgis/streets",
    });
    const keyless = planArcgisBasemap(undefined, "arcgis/streets", false);
    assert.equal(keyless.kind, "web-tile");
    // A malformed override never reaches the SDK.
    assert.notEqual(planArcgisBasemap(undefined, "https://evil/{z}", true).kind, "esri-style");
  });
  it("draws nothing for the Blank basemap and falls back to keyless streets otherwise", () => {
    assert.deepEqual(planArcgisBasemap(BLANK_BASEMAP, undefined, false), { kind: "none" });
    const plan = planArcgisBasemap(
      "https://tiles.openfreemap.org/styles/liberty",
      undefined,
      false,
    );
    assert.equal(plan.kind, "web-tile");
    if (plan.kind === "web-tile") {
      assert.ok(plan.urlTemplate.includes("{level}/{col}/{row}"));
      assert.ok(!/<[^>]+>/.test(plan.copyright));
    }
  });
});

describe("compileArcgisLayer extrusion", () => {
  const buildings = geojsonLayer({
    style: {
      ...DEFAULT_LAYER_STYLE,
      extrusionEnabled: true,
      extrusionColor: "#ff0000",
      extrusionOpacity: 0.5,
      extrusionHeightProperty: "levels",
      extrusionHeightScale: 3,
      extrusionBase: 2,
    },
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "a",
          properties: { levels: 4 },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
        {
          type: "Feature",
          id: "b",
          properties: { levels: "-1" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [2, 2],
                [3, 2],
                [3, 3],
                [2, 2],
              ],
            ],
          },
        },
      ],
    },
  });

  it("extrudes polygons by a size visual variable in a scene", () => {
    const plan = compileArcgisLayer(buildings, { scene: true });
    assert.equal(plan.kind, "geojson");
    if (plan.kind !== "geojson") return;
    const [part] = plan.parts;
    assert.equal(part.renderer.type, "simple");
    if (part.renderer.type !== "simple") return;
    assert.deepEqual(part.renderer.symbol, {
      type: "polygon-3d",
      symbolLayers: [{ type: "extrude", material: { color: [255, 0, 0, 0.5] } }],
    });
    assert.deepEqual(part.renderer.visualVariables, [
      { type: "size", field: ARCGIS_HEIGHT_FIELD, valueUnit: "meters" },
    ]);
    // Height is the property times the scale, never negative; the base is the
    // layer's vertical offset.
    assert.deepEqual(
      part.features?.features.map((f) => f.properties?.[ARCGIS_HEIGHT_FIELD]),
      [12, 0],
    );
    assert.deepEqual(part.elevationInfo, { mode: "relative-to-ground", offset: 2 });
  });

  it("colours and sizes by the advanced expressions", () => {
    const plan = compileArcgisLayer(
      {
        ...buildings,
        style: {
          ...buildings.style,
          extrusionAdvancedStyleEnabled: true,
          extrusionHeightExpression: '["*", ["to-number", ["get", "levels"]], 10]',
          extrusionColorExpression:
            '["case", [">", ["to-number", ["get", "levels"]], 0], "#00ff00", "#0000ff"]',
        },
      },
      { scene: true },
    );
    if (plan.kind !== "geojson") return assert.fail("expected a GeoJSON plan");
    const [part] = plan.parts;
    assert.equal(part.renderer.type, "unique-value");
    assert.deepEqual(
      part.features?.features.map((f) => f.properties?.[ARCGIS_HEIGHT_FIELD]),
      [120, 0],
    );
    if (part.renderer.type !== "unique-value") return;
    assert.deepEqual(
      part.renderer.uniqueValueInfos.map(
        (info) =>
          (info.symbol.symbolLayers as { material: { color: number[] } }[])[0].material.color,
      ),
      [
        [0, 255, 0, 0.5],
        [0, 0, 255, 0.5],
      ],
    );
  });

  it("keeps flat fills on a 2D map", () => {
    const plan = compileArcgisLayer(buildings);
    if (plan.kind !== "geojson") return assert.fail("expected a GeoJSON plan");
    const [part] = plan.parts;
    assert.equal(part.elevationInfo, undefined);
    assert.equal(part.renderer.visualVariables, undefined);
    if (part.renderer.type !== "simple") return assert.fail("expected a simple renderer");
    assert.equal(part.renderer.symbol.type, "simple-fill");
    assert.equal(part.features?.features[0].properties?.[ARCGIS_HEIGHT_FIELD], undefined);
  });
});
