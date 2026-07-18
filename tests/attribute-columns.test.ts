import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  addColumn,
  deleteColumn,
  getColumnSettings,
  hiddenColumns,
  moveColumn,
  orderColumns,
  renameColumn,
  showAllColumns,
  toggleColumnHidden,
  visibleColumns,
} from "../apps/geolibre-desktop/src/lib/attribute-columns";

function fc(features: FeatureCollection["features"]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  return {
    id: "layer-1",
    name: "Test",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson: fc([
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { name: "A", pop: 10, area: 5 },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [1, 1] },
        properties: { name: "B", pop: 20, area: 8 },
      },
    ]),
    ...patch,
  };
}

const DISCOVERED = ["name", "pop", "area"];

describe("column ordering and visibility", () => {
  it("orders by settings.order then appends newly discovered keys", () => {
    const settings = { order: ["pop", "name"] };
    assert.deepEqual(orderColumns(DISCOVERED, settings), ["pop", "name", "area"]);
  });

  it("drops stale keys from order that no longer exist", () => {
    const settings = { order: ["gone", "area", "name"] };
    assert.deepEqual(orderColumns(DISCOVERED, settings), ["area", "name", "pop"]);
  });

  it("filters hidden columns out of the visible list", () => {
    const settings = { hidden: ["pop"] };
    assert.deepEqual(visibleColumns(DISCOVERED, settings), ["name", "area"]);
    assert.deepEqual(hiddenColumns(DISCOVERED, settings), ["pop"]);
  });
});

describe("addColumn (destructive)", () => {
  it("seeds a null default into every feature for an empty text default", () => {
    const layer = makeLayer();
    const patch = addColumn(layer, DISCOVERED, "label", "text", "");
    assert.ok(patch);
    const props = patch.geojson!.features.map((f) => f.properties);
    assert.deepEqual(props[0], { name: "A", pop: 10, area: 5, label: null });
    assert.deepEqual(props[1], { name: "B", pop: 20, area: 8, label: null });
  });

  it("appends the new key last so it is discovered at the end", () => {
    const layer = makeLayer();
    const patch = addColumn(layer, DISCOVERED, "label", "text", "x");
    const keys = Object.keys(patch!.geojson!.features[0].properties ?? {});
    assert.deepEqual(keys, ["name", "pop", "area", "label"]);
  });

  it("coerces a numeric default to a number", () => {
    const layer = makeLayer();
    const patch = addColumn(layer, DISCOVERED, "score", "number", "42");
    assert.equal(patch!.geojson!.features[0].properties!.score, 42);
  });

  it("coerces a boolean default", () => {
    const layer = makeLayer();
    const patch = addColumn(layer, DISCOVERED, "flag", "boolean", "true");
    assert.equal(patch!.geojson!.features[0].properties!.flag, true);
    const off = addColumn(layer, DISCOVERED, "flag", "boolean", "false");
    assert.equal(off!.geojson!.features[0].properties!.flag, false);
  });

  it("keeps a non-numeric default for a number field as null", () => {
    const layer = makeLayer();
    const patch = addColumn(layer, DISCOVERED, "score", "number", "abc");
    assert.equal(patch!.geojson!.features[0].properties!.score, null);
  });

  it("appends the new key to an existing explicit order", () => {
    const layer = makeLayer({
      metadata: { columnSettings: { order: ["pop", "name", "area"] } },
    });
    const patch = addColumn(layer, DISCOVERED, "label", "text", "");
    const settings = (patch?.metadata as Record<string, unknown>).columnSettings as {
      order: string[];
    };
    assert.deepEqual(settings.order, ["pop", "name", "area", "label"]);
  });

  it("leaves order unset when none existed, relying on discovery order", () => {
    const layer = makeLayer();
    const patch = addColumn(layer, DISCOVERED, "label", "text", "");
    assert.equal((patch?.metadata as Record<string, unknown>).columnSettings, undefined);
  });

  it("is a no-op for empty or colliding names", () => {
    const layer = makeLayer();
    assert.equal(addColumn(layer, DISCOVERED, "  ", "text", ""), null);
    assert.equal(addColumn(layer, DISCOVERED, "pop", "text", ""), null);
  });

  it("is a no-op on a layer with no features (field would never appear)", () => {
    const layer = makeLayer({ geojson: fc([]) });
    assert.equal(addColumn(layer, [], "label", "text", "x"), null);
  });

  it("seeds the new key for a feature whose properties are null", () => {
    const layer = makeLayer({
      geojson: fc([
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: null,
        },
      ]),
    });
    const patch = addColumn(layer, [], "label", "text", "x");
    assert.deepEqual(patch!.geojson!.features[0].properties, { label: "x" });
  });
});

describe("renameColumn (destructive)", () => {
  it("renames the key in every feature, preserving position and other keys", () => {
    const layer = makeLayer();
    const patch = renameColumn(layer, DISCOVERED, "pop", "Population");
    assert.ok(patch);
    const props = patch.geojson!.features.map((f) => f.properties);
    assert.deepEqual(props[0], { name: "A", Population: 10, area: 5 });
    assert.deepEqual(props[1], { name: "B", Population: 20, area: 8 });
  });

  it("rewrites a matching style field reference", () => {
    const layer = makeLayer({
      style: { ...DEFAULT_LAYER_STYLE, vectorStyleProperty: "pop" },
    });
    const patch = renameColumn(layer, DISCOVERED, "pop", "Population");
    assert.equal(patch?.style?.vectorStyleProperty, "Population");
  });

  it("renames the key inside persisted column settings", () => {
    const layer = makeLayer({
      metadata: { columnSettings: { hidden: ["pop"], order: ["pop", "name"] } },
    });
    const patch = renameColumn(layer, DISCOVERED, "pop", "Population");
    const settings = (patch?.metadata as Record<string, unknown>).columnSettings as {
      hidden: string[];
      order: string[];
    };
    assert.deepEqual(settings.hidden, ["Population"]);
    assert.deepEqual(settings.order, ["Population", "name"]);
  });

  it("rewrites every style field that references the renamed column", () => {
    const layer = makeLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        vectorStyleProperty: "pop",
        extrusionHeightProperty: "pop",
      },
    });
    const patch = renameColumn(layer, DISCOVERED, "pop", "Population");
    assert.equal(patch?.style?.vectorStyleProperty, "Population");
    assert.equal(patch?.style?.extrusionHeightProperty, "Population");
  });

  it("is a no-op for empty, unchanged, colliding, or absent names", () => {
    const layer = makeLayer();
    assert.equal(renameColumn(layer, DISCOVERED, "pop", "  "), null);
    assert.equal(renameColumn(layer, DISCOVERED, "pop", "pop"), null);
    assert.equal(renameColumn(layer, DISCOVERED, "pop", "area"), null);
    // oldKey not among the discovered columns: nothing to rename.
    assert.equal(renameColumn(layer, DISCOVERED, "missing", "New"), null);
  });
});

describe("deleteColumn (destructive)", () => {
  it("removes the key from every feature", () => {
    const layer = makeLayer();
    const patch = deleteColumn(layer, "pop");
    assert.ok(patch);
    for (const feature of patch.geojson!.features) {
      assert.ok(!("pop" in (feature.properties ?? {})));
    }
    assert.deepEqual(Object.keys(patch.geojson!.features[0].properties ?? {}), ["name", "area"]);
  });

  it("clears every style field that referenced the deleted column", () => {
    const layer = makeLayer({
      style: {
        ...DEFAULT_LAYER_STYLE,
        extrusionHeightProperty: "pop",
        vectorStyleProperty: "pop",
      },
    });
    const patch = deleteColumn(layer, "pop");
    assert.equal(patch?.style?.extrusionHeightProperty, "");
    assert.equal(patch?.style?.vectorStyleProperty, "");
  });

  it("drops the key from column settings", () => {
    const layer = makeLayer({
      metadata: { columnSettings: { order: ["pop", "name", "area"] } },
    });
    const patch = deleteColumn(layer, "pop");
    const settings = (patch?.metadata as Record<string, unknown>).columnSettings as {
      order: string[];
    };
    assert.deepEqual(settings.order, ["name", "area"]);
  });

  it("is a no-op for a key absent from every feature", () => {
    assert.equal(deleteColumn(makeLayer(), "missing"), null);
  });
});

describe("visibility toggles", () => {
  it("hides then shows a column, clearing empty settings", () => {
    const layer = makeLayer();
    const hide = toggleColumnHidden(layer, "pop");
    assert.deepEqual(
      (
        (hide.metadata as Record<string, unknown>).columnSettings as {
          hidden: string[];
        }
      ).hidden,
      ["pop"],
    );

    const hiddenLayer = makeLayer({ metadata: hide.metadata });
    const show = toggleColumnHidden(hiddenLayer, "pop");
    // Settings became empty, so the key is dropped entirely.
    assert.equal((show.metadata as Record<string, unknown>).columnSettings, undefined);
  });

  it("showAllColumns clears the hidden list", () => {
    const layer = makeLayer({
      metadata: { columnSettings: { hidden: ["pop", "area"] } },
    });
    const patch = showAllColumns(layer);
    assert.equal((patch.metadata as Record<string, unknown>).columnSettings, undefined);
  });
});

describe("moveColumn", () => {
  it("moves a column left among visible columns", () => {
    const layer = makeLayer();
    const patch = moveColumn(layer, DISCOVERED, "pop", "left");
    const order = (
      (patch?.metadata as Record<string, unknown>).columnSettings as {
        order: string[];
      }
    ).order;
    assert.deepEqual(order, ["pop", "name", "area"]);
  });

  it("moves a column right among visible columns", () => {
    const layer = makeLayer();
    const patch = moveColumn(layer, DISCOVERED, "name", "right");
    const order = (
      (patch?.metadata as Record<string, unknown>).columnSettings as {
        order: string[];
      }
    ).order;
    assert.deepEqual(order, ["pop", "name", "area"]);
  });

  it("is a no-op at the edges", () => {
    const layer = makeLayer();
    assert.equal(moveColumn(layer, DISCOVERED, "name", "left"), null);
    assert.equal(moveColumn(layer, DISCOVERED, "area", "right"), null);
  });

  it("skips over hidden neighbors when swapping order", () => {
    const layer = makeLayer({
      metadata: { columnSettings: { hidden: ["pop"] } },
    });
    // Visible order is [name, area]; moving area left swaps it past hidden pop.
    const patch = moveColumn(layer, DISCOVERED, "area", "left");
    const order = (
      (patch?.metadata as Record<string, unknown>).columnSettings as {
        order: string[];
      }
    ).order;
    assert.deepEqual(order, ["area", "pop", "name"]);
  });
});

describe("getColumnSettings", () => {
  it("returns empty settings for missing or malformed metadata", () => {
    assert.deepEqual(getColumnSettings(undefined), {});
    assert.deepEqual(getColumnSettings(makeLayer({ metadata: {} })), {});
    assert.deepEqual(
      getColumnSettings(makeLayer({ metadata: { columnSettings: { hidden: "nope" } } })),
      { hidden: undefined, order: undefined },
    );
  });
});
