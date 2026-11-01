import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import {
  LayerControlHost,
  type LayerControlHostAdapter,
  layerControlReorderMove,
  orderLayerStates,
} from "../packages/map/src/layer-control-host";
import { geojsonLayer } from "./helpers/layer-fixtures";

// The on-map layer control reports a reorder only as the new panel order (top
// to bottom). layerControlReorderMove finds the one layer that moved and the
// store index it lands at, for the store's moveLayer (the store lists the
// top-most layer last).
const panel = ["top", "g1", "s1", "s2", "g2", "bottom"];

describe("layerControlReorderMove", () => {
  it("returns null when nothing moved", () => {
    assert.equal(layerControlReorderMove(panel, [...panel]), null);
  });

  it("finds the moved layer and its store index", () => {
    // g2 dragged to just under g1, above s1/s2.
    assert.deepEqual(layerControlReorderMove(panel, ["top", "g1", "g2", "s1", "s2", "bottom"]), {
      layerId: "g2",
      storeIndex: 3,
    });
  });

  it("handles a move to the top and to the bottom", () => {
    assert.deepEqual(layerControlReorderMove(panel, ["bottom", "top", "g1", "s1", "s2", "g2"]), {
      layerId: "bottom",
      storeIndex: 5,
    });
    assert.deepEqual(layerControlReorderMove(panel, ["g1", "s1", "s2", "g2", "bottom", "top"]), {
      layerId: "top",
      storeIndex: 0,
    });
  });

  it("resolves an adjacent swap to the same final order either way", () => {
    const move = layerControlReorderMove(panel, ["g1", "top", "s1", "s2", "g2", "bottom"]);
    assert.ok(move);
    const store = [...panel].reverse().filter((id) => id !== move.layerId);
    store.splice(move.storeIndex, 0, move.layerId);
    assert.deepEqual(store.reverse(), ["g1", "top", "s1", "s2", "g2", "bottom"]);
  });

  it("returns null when the orders differ by more than one move", () => {
    assert.equal(layerControlReorderMove(panel, ["bottom", "g2", "s2", "s1", "g1", "top"]), null);
  });

  it("returns null when the layer sets differ", () => {
    assert.equal(layerControlReorderMove(panel, panel.slice(1)), null);
  });
});

// A refused move must not leave the control's layerStates in the move's
// order: the control sorts layers with no native layer on the map (e.g.
// hidden plugin layers) by that record's key order.
describe("orderLayerStates", () => {
  it("restores the panel order, Background first", () => {
    const refused = { Background: 0, g1: 1, top: 2, s1: 3, g2: 4 };
    assert.deepEqual(Object.keys(orderLayerStates(refused, ["top", "g1", "s1", "g2"])), [
      "Background",
      "top",
      "g1",
      "s1",
      "g2",
    ]);
  });

  it("keeps entries the panel order does not list, after the listed ones", () => {
    const states = { extra: "x", b: "b", a: "a" };
    const ordered = orderLayerStates(states, ["a", "b", "missing"]);
    assert.deepEqual(Object.keys(ordered), ["a", "b", "extra"]);
    assert.equal(ordered.extra, "x");
  });
});

interface MountedControlWithReorder {
  onAdd: (map: unknown) => HTMLElement;
  onRemove?: (map: unknown) => void;
  onLayerReorder?: (ids: string[]) => void;
  state?: {
    collapsed?: boolean;
    layerStates?: Record<string, { visible: boolean; opacity: number; name: string }>;
  };
  buildLayerItems?: () => void;
}

describe("LayerControlHost reorder integration with three GeoJSON layers (#3297)", () => {
  it("applies drag reorder of three GeoJSON layers into the store", () => {
    const { window } = parseHTML(
      '<div id="map"><div class="maplibregl-ctrl-top-right"></div></div>',
    );
    const globals = globalThis as { document?: unknown; window?: unknown };
    const previous = { document: globals.document, window: globals.window };
    globals.document = window.document;
    globals.window = window;

    let host: LayerControlHost | null = null;
    try {
      const container = window.document.getElementById("map")!;
      // Three GeoJSON layers: layer-1, layer-2, layer-3 (bottom-to-top in store).
      // In panel order (top-most first), this is: layer-3, layer-2, layer-1.
      const initialLayers = [
        geojsonLayer({ id: "layer-1", name: "Layer 1", visible: true }),
        geojsonLayer({ id: "layer-2", name: "Layer 2", visible: true }),
        geojsonLayer({ id: "layer-3", name: "Layer 3", visible: true }),
      ];
      useAppStore.setState({
        layers: initialLayers,
        layerGroups: [],
      });

      const map = {
        getLayer: () => undefined,
        getStyle: () => ({ version: 8, sources: {}, layers: [] }),
        getSource: () => undefined,
        getContainer: () => container,
        getLayoutProperty: () => undefined,
        getPaintProperty: () => undefined,
        on: () => {},
        off: () => {},
      };

      let controlInstance: MountedControlWithReorder | null = null;

      const adapter: LayerControlHostAdapter = {
        getMap: () => map,
        addControl: (ctrl) => {
          controlInstance = ctrl as unknown as MountedControlWithReorder;
          container.firstElementChild!.appendChild(ctrl.onAdd(map as never));
        },
        removeControl: (ctrl) => {
          ctrl.onRemove?.(map as never);
        },
        getLayers: () => useAppStore.getState().layers,
        getNativeLayerIds: () => [],
        getCandidateNativeLayerIds: () => [],
        getSourceIds: () => [],
        excludedLayerIds: [],
        getBasemapStyleUrl: () => null,
        getBasemapLayerIds: () => [],
        getBasemapState: () => ({ visible: true, opacity: 1 }),
      };

      host = new LayerControlHost(adapter);
      assert.equal(host.add("top-right"), true);
      assert.ok(controlInstance);
      const mounted = controlInstance as MountedControlWithReorder;

      // Verify initial panel order in the store: layer-3, layer-2, layer-1
      const initialPanelOrder = useAppStore
        .getState()
        .layers.map((l) => l.id)
        .reverse();
      assert.deepEqual(initialPanelOrder, ["layer-3", "layer-2", "layer-1"]);

      // Next panel order is ["layer-2", "layer-3", "layer-1"] (moving layer-2 above layer-3 / layer-3 below layer-2)
      mounted.onLayerReorder?.(["layer-2", "layer-3", "layer-1"]);

      const updatedPanelOrder = useAppStore
        .getState()
        .layers.map((l) => l.id)
        .reverse();
      assert.deepEqual(updatedPanelOrder, ["layer-2", "layer-3", "layer-1"]);
      assert.deepEqual(
        useAppStore.getState().layers.map((l) => l.id),
        ["layer-1", "layer-3", "layer-2"],
      );

      // Next panel order is ["layer-1", "layer-2", "layer-3"] (moving layer-1 to top)
      mounted.onLayerReorder?.(["layer-1", "layer-2", "layer-3"]);

      const finalPanelOrder = useAppStore
        .getState()
        .layers.map((l) => l.id)
        .reverse();
      assert.deepEqual(finalPanelOrder, ["layer-1", "layer-2", "layer-3"]);
      assert.deepEqual(
        useAppStore.getState().layers.map((l) => l.id),
        ["layer-3", "layer-2", "layer-1"],
      );
    } finally {
      host?.destroy();
      globals.document = previous.document;
      globals.window = previous.window;
    }
  });

  it("rejects reorders violating group contiguity and restores order", () => {
    const { window } = parseHTML(
      '<div id="map"><div class="maplibregl-ctrl-top-right"></div></div>',
    );
    const globals = globalThis as { document?: unknown; window?: unknown };
    const previous = { document: globals.document, window: globals.window };
    globals.document = window.document;
    globals.window = window;

    let host: LayerControlHost | null = null;
    try {
      const container = window.document.getElementById("map")!;
      // g1 and g2 in group "grp"; u is ungrouped.
      const initialLayers = [
        geojsonLayer({ id: "u", name: "U", visible: true }),
        geojsonLayer({ id: "g1", name: "G1", groupId: "grp", visible: true }),
        geojsonLayer({ id: "g2", name: "G2", groupId: "grp", visible: true }),
      ];
      useAppStore.setState({
        layers: initialLayers,
        layerGroups: [{ id: "grp", name: "Group", collapsed: false, visible: true, opacity: 1 }],
      });

      const map = {
        getLayer: () => undefined,
        getStyle: () => ({ version: 8, sources: {}, layers: [] }),
        getSource: () => undefined,
        getContainer: () => container,
        getLayoutProperty: () => undefined,
        getPaintProperty: () => undefined,
        on: () => {},
        off: () => {},
      };

      let controlInstance: MountedControlWithReorder | null = null;

      const adapter: LayerControlHostAdapter = {
        getMap: () => map,
        addControl: (ctrl) => {
          controlInstance = ctrl as unknown as MountedControlWithReorder;
          container.firstElementChild!.appendChild(ctrl.onAdd(map as never));
        },
        removeControl: (ctrl) => {
          ctrl.onRemove?.(map as never);
        },
        getLayers: () => useAppStore.getState().layers,
        getNativeLayerIds: () => [],
        getCandidateNativeLayerIds: () => [],
        getSourceIds: () => [],
        excludedLayerIds: [],
        getBasemapStyleUrl: () => null,
        getBasemapLayerIds: () => [],
        getBasemapState: () => ({ visible: true, opacity: 1 }),
      };

      host = new LayerControlHost(adapter);
      assert.equal(host.add("top-right"), true);
      assert.ok(controlInstance);
      const mounted = controlInstance as MountedControlWithReorder;

      // Panel order (reverse of store): ["g2", "g1", "u"]
      const currentOrder = useAppStore
        .getState()
        .layers.map((l) => l.id)
        .reverse();
      assert.deepEqual(currentOrder, ["g2", "g1", "u"]);

      // Set up the control's internal layerStates reflecting the rejected reorder attempt
      // (as would occur during a drag or context-menu reorder before validation).
      let buildLayerItemsCalled = false;
      mounted.state = {
        ...mounted.state,
        layerStates: {
          Background: { visible: true, opacity: 1, name: "Background" },
          g2: { visible: true, opacity: 1, name: "G2" },
          u: { visible: true, opacity: 1, name: "U" },
          g1: { visible: true, opacity: 1, name: "G1" },
        },
      };
      const originalBuildLayerItems = mounted.buildLayerItems?.bind(mounted);
      mounted.buildLayerItems = () => {
        buildLayerItemsCalled = true;
        originalBuildLayerItems?.();
      };

      // Attempt to split the group by inserting u between g2 and g1: ["g2", "u", "g1"]
      mounted.onLayerReorder?.(["g2", "u", "g1"]);

      // Move should be rejected: store layers must remain unchanged
      assert.deepEqual(
        useAppStore
          .getState()
          .layers.map((l) => l.id)
          .reverse(),
        ["g2", "g1", "u"],
      );

      // Control state order must be restored to previous panel order (Background first)
      assert.deepEqual(Object.keys(mounted.state?.layerStates ?? {}), [
        "Background",
        "g2",
        "g1",
        "u",
      ]);
      assert.equal(buildLayerItemsCalled, true);
    } finally {
      host?.destroy();
      globals.document = previous.document;
      globals.window = previous.window;
    }
  });
});
