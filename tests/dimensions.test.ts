import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { IControl } from "maplibre-gl";
import type { Feature } from "geojson";
import { useAppStore, DEFAULT_LAYER_STYLE } from "@geolibre/core";
import {
  DIMENSIONS_SOURCE_KIND,
  flattenFeatureVertices,
  formatAngle,
  formatDistance,
  maplibreDimensionsPlugin,
  metersToUnit,
  parseAssociativeDimension,
  resolveTiePosition,
  setDimensionLabels,
  spliceRebuiltDimensionGroups,
} from "../packages/plugins/src/plugins/maplibre-dimensions";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import type { GeoLibreLayer } from "../packages/core/src/types";

describe("dimension units", () => {
  it("converts meters into every supported unit", () => {
    assert.equal(metersToUnit(1000, "km"), 1);
    assert.equal(Math.round(metersToUnit(1609.344, "mi")), 1);
    assert.equal(Math.round(metersToUnit(0.3048 * 10, "ft")), 10);
  });

  it("formats a distance with its unit suffix", () => {
    assert.equal(formatDistance(1000, "m", 0), "1000 m");
    assert.equal(formatDistance(1000, "km", 2), "1.00 km");
  });

  it("formats an angle with a degree suffix", () => {
    assert.equal(formatAngle(90), "90.0°");
    assert.equal(formatAngle(45.567, 2), "45.57°");
  });
});

describe("dimension vertex flattening", () => {
  it("flattens every geometry type into a position list", () => {
    const point: Feature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: {},
    };
    const line: Feature = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
      },
      properties: {},
    };
    const polygon: Feature = {
      type: "Feature",
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
      properties: {},
    };
    assert.deepEqual(flattenFeatureVertices(point), [[1, 2]]);
    assert.equal(flattenFeatureVertices(line).length, 3);
    assert.equal(flattenFeatureVertices(polygon).length, 4);
  });

  it("returns an empty list for a feature with no geometry", () => {
    const empty: Feature = {
      type: "Feature",
      geometry: null as never,
      properties: {},
    };
    assert.deepEqual(flattenFeatureVertices(empty), []);
  });
});

function makeLayer(overrides: Partial<GeoLibreLayer>): GeoLibreLayer {
  return {
    id: "layer",
    name: "Layer",
    type: "geojson",
    source: {},
    visible: true,
    opacity: 1,
    style: {} as GeoLibreLayer["style"],
    metadata: {},
    ...overrides,
  };
}

describe("resolveTiePosition", () => {
  it("resolves a vertex tie to the feature's current vertex position", () => {
    const layer = makeLayer({
      id: "vector-1",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "f1",
            geometry: {
              type: "LineString",
              coordinates: [
                [0, 0],
                [3, 4],
              ],
            },
            properties: {},
          },
        ],
      },
    });
    const position = resolveTiePosition(
      { layerId: "vector-1", featureId: "f1", featureIndex: 0, vertexIndex: 1 },
      [layer],
    );
    assert.deepEqual(position, [3, 4]);
  });

  it("returns null when the tied layer no longer exists", () => {
    const position = resolveTiePosition(
      { layerId: "gone", featureId: null, featureIndex: 0, vertexIndex: 0 },
      [],
    );
    assert.equal(position, null);
  });

  it("returns null when the tied vertex index is out of range", () => {
    const layer = makeLayer({
      id: "vector-1",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [0, 0] },
            properties: {},
          },
        ],
      },
    });
    const position = resolveTiePosition(
      { layerId: "vector-1", featureId: null, featureIndex: 0, vertexIndex: 5 },
      [layer],
    );
    assert.equal(position, null);
  });
});

describe("parseAssociativeDimension", () => {
  const validTie = { layerId: "vector-1", featureId: null, featureIndex: 0, vertexIndex: 0 };

  it("accepts a well-formed linear record with at least one tie", () => {
    const parsed = parseAssociativeDimension({
      __dimension: "linear",
      ties: [validTie, null],
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed?.kind, "linear");
    assert.equal(parsed?.points.length, 2);
  });

  it("rejects an angular record with only one tie and one point (mismatched count)", () => {
    // Regression: a dimension layer loaded from a saved project or external
    // GeoJSON could claim __dimension: "angular" (which needs 3 points) while
    // only carrying 1 tie/point. Without validating the count against `kind`,
    // recomputeAssociativeDimensions would pass `undefined` coordinates into
    // buildAngularDimensionFeatures.
    const parsed = parseAssociativeDimension({
      __dimension: "angular",
      ties: [validTie],
      points: [[0, 0]],
    });
    assert.equal(parsed, null);
  });

  it("rejects a record with a null or malformed point entry", () => {
    const parsed = parseAssociativeDimension({
      __dimension: "linear",
      ties: [validTie, null],
      points: [null, [1, 1]],
    });
    assert.equal(parsed, null);
  });

  it("rejects a record whose ties are not an array", () => {
    const parsed = parseAssociativeDimension({
      __dimension: "linear",
      ties: "not-an-array",
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    assert.equal(parsed, null);
  });

  it("rejects a record with no non-null ties (nothing to recompute)", () => {
    const parsed = parseAssociativeDimension({
      __dimension: "linear",
      ties: [null, null],
      points: [
        [0, 0],
        [1, 1],
      ],
    });
    assert.equal(parsed, null);
  });

  it("rejects a record with an unrecognized __dimension kind", () => {
    const parsed = parseAssociativeDimension({
      __dimension: "unknown",
      ties: [validTie],
      points: [[0, 0]],
    });
    assert.equal(parsed, null);
  });
});

describe("spliceRebuiltDimensionGroups", () => {
  function dimFeature(dimensionId: string, part = "label"): Feature {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { dimensionId, __dimensionPart: part },
    };
  }

  it("replaces a rebuilt group in place instead of moving it to the end", () => {
    // Regression: recomputeAssociativeDimensions used to append rebuilt
    // groups to the end of the feature array, which broke
    // deleteLastDimension's assumption that array position reflects
    // creation order. Creation order here is A, B, C; only A is recomputed
    // (e.g. its tied vertex moved elsewhere) — A must stay first.
    const features = [dimFeature("A"), dimFeature("B"), dimFeature("C")];
    const rebuiltA = dimFeature("A");
    const next = spliceRebuiltDimensionGroups(features, new Map([["A", [rebuiltA]]]));

    const order = next.map((f) => (f.properties as Record<string, unknown>).dimensionId);
    assert.deepEqual(order, ["A", "B", "C"]);
    assert.equal(next[0], rebuiltA);
  });

  it("replaces every original part of a multi-feature group at the first part's position", () => {
    const features = [
      dimFeature("A", "extension"),
      dimFeature("A", "line"),
      dimFeature("B", "label"),
    ];
    const rebuiltA = [
      dimFeature("A", "extension"),
      dimFeature("A", "line"),
      dimFeature("A", "label"),
    ];
    const next = spliceRebuiltDimensionGroups(features, new Map([["A", rebuiltA]]));

    assert.deepEqual(
      next.map((f) => (f.properties as Record<string, unknown>).dimensionId),
      ["A", "A", "A", "B"],
    );
  });

  it("leaves features unchanged when no group was rebuilt", () => {
    const features = [dimFeature("A"), dimFeature("B")];
    const next = spliceRebuiltDimensionGroups(features, new Map());
    assert.deepEqual(next, features);
  });
});

describe("dimension toolbar", () => {
  let restoreGlobals: () => void;
  let control: IControl | null;
  let app: GeoLibreAppAPI;

  beforeEach(() => {
    const { document, window } = parseHTML("<html><body></body></html>");
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { document, window });
    restoreGlobals = () => {
      Object.assign(globalThis, {
        document: previousDocument,
        window: previousWindow,
      });
    };

    control = null;
    app = {
      addMapControl: (nextControl) => {
        control = nextControl;
        return true;
      },
      removeMapControl: (removedControl) => removedControl.onRemove(),
      getMap: () => null,
    } as GeoLibreAppAPI;

    setDimensionLabels({
      collapse: "Collapse toolbar",
      expand: "Expand toolbar",
      snap: "Snap to vertices",
    });
    maplibreDimensionsPlugin.activate(app);
  });

  afterEach(() => {
    maplibreDimensionsPlugin.deactivate(app);
    restoreGlobals();
  });

  it("renders exactly two tools (Linear, Angular), both enabled", () => {
    assert.ok(control);
    const container = control.onAdd(null as never);
    const tools = container.querySelectorAll<HTMLButtonElement>(".geolibre-dimensions-tool");
    assert.equal(tools.length, 2);
    for (const tool of tools) assert.equal(tool.disabled, false);
  });

  it("renders a Snap toggle button the user can turn on and off", () => {
    assert.ok(control);
    const container = control.onAdd(null as never);
    const snap = container.querySelector<HTMLButtonElement>(".geolibre-dimensions-snap");
    assert.ok(snap);
    assert.equal(snap.getAttribute("aria-label"), "Snap to vertices");
    // On by default.
    assert.equal(snap.getAttribute("aria-pressed"), "true");
    assert.ok(snap.classList.contains("is-active"));

    snap.click();
    assert.equal(snap.getAttribute("aria-pressed"), "false");
    assert.ok(!snap.classList.contains("is-active"));

    snap.click();
    assert.equal(snap.getAttribute("aria-pressed"), "true");
  });

  it("folds to one accessible button and expands again", () => {
    assert.ok(control);
    const container = control.onAdd(null as never);
    const toggle = container.querySelector<HTMLButtonElement>(".geolibre-dimensions-collapse");
    const tools = container.querySelector<HTMLElement>(".geolibre-dimensions-tools");
    assert.ok(toggle);
    assert.ok(tools);
    assert.equal(toggle.getAttribute("aria-label"), "Collapse toolbar");
    assert.equal(tools.hidden, false);

    toggle.click();
    assert.equal(tools.hidden, true);
    assert.equal(toggle.getAttribute("aria-label"), "Expand toolbar");

    toggle.click();
    assert.equal(tools.hidden, false);
  });
});

describe("clear all dimensions confirmation", () => {
  let restoreGlobals: () => void;
  let control: IControl | null;
  let app: GeoLibreAppAPI;

  function seedDimensionLayer(dimensionIds: string[]): void {
    useAppStore.getState().addLayer({
      id: "test-dimension-layer",
      name: "Dimensions",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE, simpleStyleEnabled: true },
      metadata: { sourceKind: DIMENSIONS_SOURCE_KIND },
      geojson: {
        type: "FeatureCollection",
        features: dimensionIds.map((dimensionId) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { dimensionId },
        })),
      },
    });
  }

  function findActionButton(container: HTMLElement, label: string): HTMLButtonElement {
    const buttons = [
      ...container.querySelectorAll<HTMLButtonElement>(".geolibre-dimensions-action"),
    ];
    const match = buttons.find((button) => button.getAttribute("aria-label") === label);
    assert.ok(match, `no action button labeled "${label}"`);
    return match as HTMLButtonElement;
  }

  beforeEach(() => {
    const { document, window } = parseHTML("<html><body></body></html>");
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    Object.assign(globalThis, { document, window });
    restoreGlobals = () => {
      Object.assign(globalThis, { document: previousDocument, window: previousWindow });
    };

    useAppStore.setState({ layers: [] });
    control = null;
    app = {
      addMapControl: (nextControl) => {
        control = nextControl;
        return true;
      },
      removeMapControl: (removedControl) => removedControl.onRemove(),
      getMap: () => null,
    } as GeoLibreAppAPI;

    setDimensionLabels({
      clearAll: "Clear all dimensions",
      confirmClearAll: (count) =>
        count === 1
          ? "Delete this dimension? This cannot be undone."
          : `Delete all ${count} dimensions in this layer? This cannot be undone.`,
    });
    maplibreDimensionsPlugin.activate(app);
  });

  afterEach(() => {
    maplibreDimensionsPlugin.deactivate(app);
    useAppStore.setState({ layers: [] });
    restoreGlobals();
  });

  it("keeps the layer when the user cancels the confirmation", () => {
    seedDimensionLayer(["A", "B"]);
    assert.ok(control);
    const container = control!.onAdd(null as never);
    const clearAll = findActionButton(container, "Clear all dimensions");

    const originalConfirm = globalThis.window.confirm;
    let promptedMessage = "";
    globalThis.window.confirm = (message?: string) => {
      promptedMessage = message ?? "";
      return false;
    };
    try {
      clearAll.click();
    } finally {
      globalThis.window.confirm = originalConfirm;
    }

    assert.match(promptedMessage, /Delete all 2 dimensions/);
    assert.ok(useAppStore.getState().layers.some((layer) => layer.id === "test-dimension-layer"));
  });

  it("removes the layer when the user confirms", () => {
    seedDimensionLayer(["A"]);
    assert.ok(control);
    const container = control!.onAdd(null as never);
    const clearAll = findActionButton(container, "Clear all dimensions");

    const originalConfirm = globalThis.window.confirm;
    let promptedMessage = "";
    globalThis.window.confirm = (message?: string) => {
      promptedMessage = message ?? "";
      return true;
    };
    try {
      clearAll.click();
    } finally {
      globalThis.window.confirm = originalConfirm;
    }

    assert.match(promptedMessage, /Delete this dimension\?/);
    assert.ok(!useAppStore.getState().layers.some((layer) => layer.id === "test-dimension-layer"));
  });

  it("does not prompt for an already-empty dimension layer", () => {
    seedDimensionLayer([]);
    assert.ok(control);
    const container = control!.onAdd(null as never);
    const clearAll = findActionButton(container, "Clear all dimensions");

    const originalConfirm = globalThis.window.confirm;
    let confirmCalled = false;
    globalThis.window.confirm = () => {
      confirmCalled = true;
      return false;
    };
    try {
      clearAll.click();
    } finally {
      globalThis.window.confirm = originalConfirm;
    }

    assert.equal(confirmCalled, false);
    assert.ok(!useAppStore.getState().layers.some((layer) => layer.id === "test-dimension-layer"));
  });
});
