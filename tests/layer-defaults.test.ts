import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  LAYER_PALETTE,
  darkenHex,
  dominantGeometry,
  initialLayerStyle,
  isInitialLayerStyle,
  nextLayerPaletteColor,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/** A layer wearing a real palette assignment: the fill paired with its outline. */
function styled(id: string, fillColor: string): GeoLibreLayer {
  return {
    id,
    name: id,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE, fillColor, strokeColor: darkenHex(fillColor, 0.55) },
    metadata: {},
  };
}

/** A layer built straight from the schema defaults, as every add path that
 *  paints from no collection does — its fill happens to equal LAYER_PALETTE[0]. */
function schemaStyled(id: string, type: GeoLibreLayer["type"] = "geojson"): GeoLibreLayer {
  return {
    id,
    name: id,
    type,
    source: { type },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  };
}

function fc(types: string[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: types.map((type) => ({
      type: "Feature",
      geometry:
        type === "Point"
          ? { type: "Point", coordinates: [0, 0] }
          : type === "LineString"
            ? {
                type: "LineString",
                coordinates: [
                  [0, 0],
                  [1, 1],
                ],
              }
            : {
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
      properties: {},
    })),
  } as FeatureCollection;
}

describe("darkenHex", () => {
  it("darkens each channel toward black", () => {
    assert.equal(darkenHex("#ffffff", 0.5), "#808080");
    assert.equal(darkenHex("#3b82f6", 0.55), "#204887");
  });

  it("leaves a value it cannot parse untouched", () => {
    assert.equal(darkenHex("rgb(1,2,3)", 0.5), "rgb(1,2,3)");
    assert.equal(darkenHex("#abc", 0.5), "#abc");
  });
});

describe("nextLayerPaletteColor", () => {
  it("starts at the historical default so the first layer looks unchanged", () => {
    assert.equal(nextLayerPaletteColor([]), DEFAULT_LAYER_STYLE.fillColor);
    assert.equal(nextLayerPaletteColor([]), LAYER_PALETTE[0]);
  });

  it("skips colors already in use", () => {
    assert.equal(nextLayerPaletteColor([styled("a", LAYER_PALETTE[0])]), LAYER_PALETTE[1]);
    assert.equal(
      nextLayerPaletteColor([styled("a", LAYER_PALETTE[0]), styled("b", LAYER_PALETTE[1])]),
      LAYER_PALETTE[2],
    );
  });

  it("reuses a color freed by a deleted layer instead of drifting", () => {
    // b was removed; its color should come back rather than the cycle staying
    // permanently offset.
    const remaining = [styled("a", LAYER_PALETTE[0]), styled("c", LAYER_PALETTE[2])];
    assert.equal(nextLayerPaletteColor(remaining), LAYER_PALETTE[1]);
  });

  it("cycles by layer count once the whole palette is in use", () => {
    const all = LAYER_PALETTE.map((color, index) => styled(`l${index}`, color));
    assert.equal(nextLayerPaletteColor(all), LAYER_PALETTE[0]);
    // A ninth layer advances the cycle rather than pinning to one color.
    assert.equal(nextLayerPaletteColor([...all, styled("l8", LAYER_PALETTE[0])]), LAYER_PALETTE[1]);
  });

  it("ignores layers that never wore a palette assignment", () => {
    // A raster carries DEFAULT_LAYER_STYLE, whose fill equals LAYER_PALETTE[0]
    // without ever rendering it; the first vector layer should still get blue.
    assert.equal(nextLayerPaletteColor([schemaStyled("dem", "raster")]), LAYER_PALETTE[0]);
    // Same for a non-spatial attribute table (a delimited text file added with
    // no coordinate columns) — the fill matches, but the outline is the
    // schema's, not one derived from it, and nothing is drawn either way.
    assert.equal(nextLayerPaletteColor([schemaStyled("csv-table")]), LAYER_PALETTE[0]);
    // ...and neither shifts the fallback cycle.
    const all = LAYER_PALETTE.map((color, index) => styled(`l${index}`, color));
    assert.equal(
      nextLayerPaletteColor([schemaStyled("dem", "raster"), schemaStyled("csv-table"), ...all]),
      LAYER_PALETTE[0],
    );
  });

  it("matches a palette assignment whatever the hex casing", () => {
    const upper: GeoLibreLayer = {
      ...styled("a", LAYER_PALETTE[0]),
      style: {
        ...DEFAULT_LAYER_STYLE,
        fillColor: LAYER_PALETTE[0].toUpperCase(),
        strokeColor: darkenHex(LAYER_PALETTE[0], 0.55).toUpperCase(),
      },
    };
    assert.equal(nextLayerPaletteColor([upper]), LAYER_PALETTE[1]);
  });
});

describe("dominantGeometry", () => {
  it("classifies a clear majority", () => {
    assert.equal(dominantGeometry(fc(["Point", "Point", "Point"])), "point");
    assert.equal(dominantGeometry(fc(["LineString", "LineString"])), "line");
    assert.equal(dominantGeometry(fc(["Polygon", "Polygon", "Point"])), "polygon");
  });

  it("reports mixed when nothing holds a majority", () => {
    assert.equal(dominantGeometry(fc(["Point", "LineString"])), "mixed");
    assert.equal(dominantGeometry(fc([])), "mixed");
    assert.equal(dominantGeometry(undefined), "mixed");
  });

  it("counts geometries it does not understand against the majority", () => {
    // Two points among five features is not a point layer, even though points
    // are the only family the classifier recognizes here.
    const mixed: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        ...fc(["Point", "Point"]).features,
        ...Array.from({ length: 3 }, () => ({
          type: "Feature" as const,
          geometry: { type: "GeometryCollection" as const, geometries: [] },
          properties: {},
        })),
      ],
    } as FeatureCollection;
    assert.equal(dominantGeometry(mixed), "mixed");
  });
});

describe("initialLayerStyle", () => {
  it("gives a point layer solid, smaller symbols", () => {
    const style = initialLayerStyle({ geojson: fc(["Point", "Point"]) });
    assert.equal(style.circleRadius, 5);
    assert.equal(style.fillOpacity, 0.9);
  });

  it("gives a polygon layer a translucent fill so the basemap reads through", () => {
    const style = initialLayerStyle({ geojson: fc(["Polygon", "Polygon"]) });
    assert.equal(style.fillOpacity, 0.45);
    assert.equal(style.strokeWidth, 1.5);
  });

  it("puts the weight on a line layer's stroke", () => {
    assert.equal(initialLayerStyle({ geojson: fc(["LineString"]) }).strokeWidth, 2.5);
  });

  it("derives the outline from the assigned fill", () => {
    const style = initialLayerStyle({ layers: [styled("a", LAYER_PALETTE[0])] });
    assert.equal(style.fillColor, LAYER_PALETTE[1]);
    assert.equal(style.strokeColor, darkenHex(LAYER_PALETTE[1], 0.55));
  });

  it("fills every schema key so a layer style is never partial", () => {
    const style = initialLayerStyle();
    for (const key of Object.keys(DEFAULT_LAYER_STYLE)) {
      assert.ok(key in style, key);
    }
  });

  it("lets overrides win over the computed defaults", () => {
    const style = initialLayerStyle({
      geojson: fc(["Point"]),
      overrides: { fillOpacity: 0.1, fillColor: "#000000" },
    });
    assert.equal(style.fillOpacity, 0.1);
    assert.equal(style.fillColor, "#000000");
  });
});

describe("isInitialLayerStyle", () => {
  const points = fc(["Point", "Point"]);

  it("accepts what initialLayerStyle just produced", () => {
    assert.equal(isInitialLayerStyle(initialLayerStyle({ geojson: points }), points), true);
  });

  it("rejects a hand-picked fill, which the mode alone would not catch", () => {
    const style = { ...initialLayerStyle({ geojson: points }), fillColor: "#123456" };
    assert.equal(isInitialLayerStyle(style, points), false);
  });

  it("rejects an outline no longer derived from the fill", () => {
    const style = { ...initialLayerStyle({ geojson: points }), strokeColor: "#000000" };
    assert.equal(isInitialLayerStyle(style, points), false);
  });

  for (const patch of [
    { fillOpacity: 0.3 },
    { strokeWidth: 8 },
    { circleRadius: 20 },
    { simpleStyleEnabled: true },
    { vectorStyleMode: "categorized" as const },
    { pointRenderer: "heatmap" as const },
  ]) {
    const field = Object.keys(patch)[0];
    it(`rejects an edited ${field}`, () => {
      const style = { ...initialLayerStyle({ geojson: points }), ...patch };
      assert.equal(isInitialLayerStyle(style, points), false);
    });
  }

  it("accepts an uppercase-hex palette assignment, matching nextLayerPaletteColor", () => {
    const base = initialLayerStyle({ geojson: points });
    const style = {
      ...base,
      fillColor: base.fillColor.toUpperCase(),
      strokeColor: base.strokeColor.toUpperCase(),
    };
    assert.equal(isInitialLayerStyle(style, points), true);
  });

  it("rejects a legacy project style whose colors predate the palette pairing", () => {
    // fillColor happens to be palette[0], but the old outline is not derived
    // from it — restored styling, so no suggestions.
    const style = { ...DEFAULT_LAYER_STYLE, fillColor: "#3b82f6", strokeColor: "#1e40af" };
    assert.equal(isInitialLayerStyle(style, points), false);
  });
});

describe("addGeoJsonLayer", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  it("gives each added layer its own color", () => {
    useAppStore.getState().addGeoJsonLayer("a", fc(["Polygon"]));
    useAppStore.getState().addGeoJsonLayer("b", fc(["Polygon"]));
    useAppStore.getState().addGeoJsonLayer("c", fc(["Polygon"]));

    const colors = useAppStore.getState().layers.map((layer) => layer.style.fillColor);
    assert.equal(new Set(colors).size, 3, `expected distinct colors, got ${colors.join(", ")}`);
    assert.equal(colors[0], LAYER_PALETTE[0]);
  });

  it("sizes an added layer for its geometry", () => {
    useAppStore.getState().addGeoJsonLayer("points", fc(["Point", "Point"]));
    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.style.circleRadius, 5);
    assert.equal(layer.style.fillOpacity, 0.9);
  });
});
