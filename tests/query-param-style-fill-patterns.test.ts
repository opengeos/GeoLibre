import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, type LayerStyle } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildGeoLibreQueryStyle } from "../packages/map/src/query-param-style";
import { buildMapboxStyle } from "../packages/map/src/mapbox-style-export";
import { parseMapboxStyle } from "../packages/map/src/mapbox-style-import";
import { importStyleText } from "../packages/map/src/style-import";
import { mapboxStyleForDataLayer } from "../apps/geolibre-desktop/src/lib/data-url";

const data: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { secret: "not part of the style" },
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
  ],
};

function layer(style: Partial<LayerStyle>, name = "parks"): GeoLibreLayer {
  return {
    id: name,
    name,
    type: "geojson",
    source: { type: "geojson" },
    sourcePath: `https://example.com/data.zip#folder/${name}.geojson`,
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, ...style },
    metadata: {},
    geojson: data,
  };
}

function restore(style: unknown, base = DEFAULT_LAYER_STYLE) {
  const imported = importStyleText(JSON.stringify(style));
  if (!imported.ok) assert.fail(imported.reason);
  return imported.apply(base);
}

describe("GeoLibre URL fill patterns (#2923)", () => {
  for (const fillPattern of ["hatch", "cross-hatch", "horizontal", "vertical", "dots"] as const) {
    it(`round-trips ${fillPattern} and its color without embedding data`, () => {
      const exported = buildGeoLibreQueryStyle(
        layer({ fillPattern, fillPatternColor: "#00f900" }),
        data,
      );
      const imported = restore(exported.style);
      assert.equal(imported.fillPattern, fillPattern);
      assert.equal(imported.fillPatternColor, "#00f900");
      assert.deepEqual(exported.warnings, []);
      assert.deepEqual((exported.style.sources.parks as { data: unknown }).data, {
        type: "FeatureCollection",
        features: [],
      });
      assert.ok(!JSON.stringify(exported.style).includes("not part of the style"));
    });
  }

  for (const fillPatternSvg of [
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="2" fill="#00f900"/></svg>',
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E",
    "https://example.com/pattern.svg",
  ]) {
    it(`preserves custom SVG ${fillPatternSvg.slice(0, 25)}`, () => {
      const exported = buildGeoLibreQueryStyle(layer({ fillPattern: "svg", fillPatternSvg }), data);
      const imported = restore(exported.style);
      assert.equal(imported.fillPattern, "svg");
      assert.equal(imported.fillPatternSvg, fillPatternSvg);
    });
  }

  it("clears an existing pattern when importing an explicit flat fill", () => {
    const exported = buildGeoLibreQueryStyle(layer({ fillPattern: "none" }), data);
    assert.equal(
      restore(exported.style, { ...DEFAULT_LAYER_STYLE, fillPattern: "dots" }).fillPattern,
      "none",
    );
  });

  it("keeps different ZIP member patterns attached to their sources", () => {
    const parks = buildGeoLibreQueryStyle(
      layer({ fillPattern: "dots", fillPatternColor: "#00f900" }),
      data,
    ).style;
    const counties = buildGeoLibreQueryStyle(
      layer({ fillPattern: "hatch", fillPatternColor: "#ff0000" }, "counties"),
      data,
    ).style;
    const merged = {
      ...parks,
      sources: { ...parks.sources, ...counties.sources },
      layers: [...parks.layers, ...counties.layers],
    };
    for (const [name, pattern, color] of [
      ["parks.geojson", "dots", "#00f900"],
      ["counties.geojson", "hatch", "#ff0000"],
    ]) {
      const imported = restore(mapboxStyleForDataLayer(merged, name));
      assert.equal(imported.fillPattern, pattern);
      assert.equal(imported.fillPatternColor, color);
    }
  });

  it("reads metadata only from the representative visible fill", () => {
    const hidden = {
      id: "hidden",
      type: "fill",
      layout: { visibility: "none" },
      metadata: {
        "geolibre:fill-pattern": {
          version: 1,
          fillPattern: "dots",
          fillPatternColor: "#00f900",
          fillPatternSvg: "",
        },
      },
    };
    const visible = {
      id: "visible",
      type: "fill",
      metadata: {
        "geolibre:fill-pattern": {
          version: 1,
          fillPattern: "hatch",
          fillPatternColor: "#ff0000",
          fillPatternSvg: "",
        },
      },
    };
    assert.equal(restore({ layers: [hidden, visible] }).fillPattern, "hatch");
    assert.equal(restore({ layers: [hidden] }).fillPattern, "dots");
    assert.equal(
      parseMapboxStyle({ layers: [hidden, { type: "line" }] }).style.fillPattern,
      undefined,
    );
  });

  it("leaves legacy Mapbox styles and unrelated metadata alone", () => {
    for (const metadata of [undefined, { other: { fillPattern: "dots" } }]) {
      const imported = restore(
        { layers: [{ type: "fill", metadata }] },
        { ...DEFAULT_LAYER_STYLE, fillPattern: "hatch" },
      );
      assert.equal(imported.fillPattern, "hatch");
    }
  });

  it("ignores unsupported or malformed pattern metadata with a warning", () => {
    const valid = {
      version: 1,
      fillPattern: "dots",
      fillPatternColor: "#00f900",
      fillPatternSvg: "",
    };
    for (const value of [
      null,
      [],
      "dots",
      { ...valid, version: 2 },
      { ...valid, fillPattern: "unknown" },
      { ...valid, fillPatternColor: 42 },
      { ...valid, fillPatternSvg: {} },
    ]) {
      const parsed = parseMapboxStyle({
        layers: [{ type: "fill", metadata: { "geolibre:fill-pattern": value } }],
      });
      assert.equal(parsed.style.fillPattern, undefined);
      assert.ok(parsed.warnings.some((warning) => warning.includes("fill pattern")));
    }
  });

  it("does not import arbitrary style fields from pattern metadata", () => {
    const parsed = parseMapboxStyle({
      layers: [
        {
          type: "fill",
          metadata: {
            "geolibre:fill-pattern": {
              version: 1,
              fillPattern: "dots",
              fillPatternColor: "#00f900",
              fillPatternSvg: "",
              fillColor: "#ff0000",
              markerEnabled: true,
            },
          },
        },
      ],
    });
    assert.equal(parsed.style.fillPattern, "dots");
    assert.equal(parsed.style.fillColor, undefined);
    assert.equal(parsed.style.markerEnabled, undefined);
  });

  it("retains other export warnings and the standalone Mapbox pattern warning", () => {
    const source = layer({ fillPattern: "dots", markerEnabled: true });
    const mixed: FeatureCollection = {
      ...data,
      features: [
        ...data.features,
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [0, 0] } },
      ],
    };
    const standalone = buildMapboxStyle(source, mixed);
    const url = buildGeoLibreQueryStyle(source, mixed);
    assert.ok(standalone.warnings.some((warning) => warning.startsWith("Fill pattern")));
    assert.deepEqual(
      url.warnings,
      standalone.warnings.filter((warning) => !warning.startsWith("Fill pattern")),
    );
    assert.ok(url.warnings.length > 0);
  });
});
