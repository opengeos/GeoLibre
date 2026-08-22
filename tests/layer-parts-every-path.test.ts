import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { syncLayer } from "../packages/map/src/layer-sync";

// An archive that is still one layer — the STAC panel's, an offline extract — paints each source
// layer in the colour the archive gave it. Which sync path does that depends on the layer's kind,
// and there are several, so each is pinned here.
type Painted = Record<string, { color?: string; visibility?: string }>;

// Whichever of these a layer kind paints with is the colour under test.
const colorKeys = ["fill-color", "fill-extrusion-color", "line-color", "circle-color"];

function mapStub(nativeIds: string[], sourceLayerOf: (id: string) => string | undefined) {
  const painted: Painted = {};
  const record = (id: string) => (painted[id] ??= {});
  return {
    painted,
    map: {
      getStyle: () => ({ layers: nativeIds.map((id) => ({ id, type: "fill" })) }),
      getLayer: (id: string) =>
        nativeIds.includes(id) ? { id, type: "fill", sourceLayer: sourceLayerOf(id) } : undefined,
      getSource: () => ({ id: "src" }),
      getPaintProperty: (id: string, key: string) =>
        colorKeys.includes(key) ? painted[id]?.color : undefined,
      getLayoutProperty: (id: string, key: string) =>
        key === "visibility" ? painted[id]?.visibility : undefined,
      getFilter: () => undefined,
      setFilter: () => {},
      addSource: () => {},
      addLayer: (spec: Record<string, unknown>) => {
        const id = String(spec.id);
        const paint = (spec.paint ?? {}) as Record<string, unknown>;
        const layout = (spec.layout ?? {}) as Record<string, unknown>;
        const color = colorKeys.map((key) => paint[key]).find((value) => value !== undefined);
        painted[id] = {
          color: color === undefined ? undefined : String(color),
          visibility: layout.visibility === undefined ? undefined : String(layout.visibility),
        };
      },
      removeLayer: () => {},
      removeSource: () => {},
      moveLayer: () => {},
      setLayoutProperty: (id: string, key: string, value: unknown) => {
        if (key === "visibility") record(id).visibility = String(value);
      },
      setPaintProperty: (id: string, key: string, value: unknown) => {
        if (colorKeys.includes(key)) record(id).color = String(value);
      },
      setLayerZoomRange: () => {},
    },
  };
}

const base = {
  id: "arch",
  name: "Archive",
  visible: true,
  opacity: 1,
  // Seeded from the first source layer's colour, as the control does when it adds an archive:
  // a layer whose colour has drifted from that is one the user restyled, and keeps its own.
  style: { ...DEFAULT_LAYER_STYLE, fillColor: "#ff0000" },
  metadata: { sourceLayerColors: { roads: "#ff0000", water: "#00ff00" } },
};

describe("an archive's assigned colours reach every kind of vector archive", () => {
  it("vector-tiles: paints each source layer in its own colour", () => {
    const layer = {
      ...base,
      type: "vector-tiles",
      source: {
        type: "vector",
        tiles: ["https://x/{z}/{x}/{y}.pbf"],
        sourceLayers: ["roads", "water"],
      },
      metadata: { sourceLayerColors: { roads: "#ff0000", water: "#00ff00" } },
    } as unknown as GeoLibreLayer;
    const { map, painted } = mapStub([], () => undefined);

    syncLayer(map as never, layer);

    const roads = Object.entries(painted).find(
      ([id]) => id.includes("roads") && id.includes("fill"),
    );
    const water = Object.entries(painted).find(
      ([id]) => id.includes("water") && id.includes("fill"),
    );
    assert.ok(roads, "a fill layer was created for roads");
    assert.equal(roads[1].color, "#ff0000", "roads takes the colour the archive gave it");
    assert.ok(water, "a fill layer was created for water");
    assert.equal(water[1].color, "#00ff00", "and water takes its own");
  });

  it("mbtiles: paints each source layer in its own colour", () => {
    const layer = {
      ...base,
      type: "mbtiles",
      source: {
        type: "vector",
        tiles: ["mbtiles://arch/{z}/{x}/{y}.pbf"],
        sourceLayers: ["roads", "water"],
      },
      metadata: {
        tileFormat: "pbf",
        sourceLayerColors: { roads: "#ff0000", water: "#00ff00" },
      },
    } as unknown as GeoLibreLayer;
    const { map, painted } = mapStub([], () => undefined);

    syncLayer(map as never, layer);

    const roads = Object.entries(painted).find(
      ([id]) => id.includes("roads") && id.includes("fill"),
    );
    const water = Object.entries(painted).find(
      ([id]) => id.includes("water") && id.includes("fill"),
    );
    assert.ok(roads, "a fill layer was created for roads");
    assert.equal(roads[1].color, "#ff0000");
    assert.ok(water, "a fill layer was created for water");
    assert.equal(water[1].color, "#00ff00");
  });
});

// The extrusion branch is a fourth paint call in the same loop, and takes the same part style as
// its three neighbours — but paints from `extrusionColor`, which the assignment does not touch.
describe("an extruded archive layer", () => {
  it("keeps the extrusion colour rather than taking the source layer's", () => {
    const layer = {
      ...base,
      type: "vector-tiles",
      source: {
        type: "vector",
        tiles: ["https://x/{z}/{x}/{y}.pbf"],
        sourceLayers: ["roads", "water"],
      },
      style: { ...base.style, extrusionEnabled: true },
      metadata: { sourceLayerColors: { roads: "#ff0000", water: "#00ff00" } },
    } as unknown as GeoLibreLayer;
    const { map, painted } = mapStub([], () => undefined);

    syncLayer(map as never, layer);

    const water = Object.entries(painted).find(
      ([id]) => id.includes("extrusion") && id.includes("water"),
    );
    assert.ok(water, "an extrusion layer was created for water");
    // A user who turned extrusion on chose this colour in the Style panel; the archive's palette,
    // which exists to tell flat parts apart, does not overrule it.
    assert.equal(water[1].color, DEFAULT_LAYER_STYLE.extrusionColor);
  });
});
