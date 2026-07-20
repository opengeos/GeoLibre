import assert from "node:assert/strict";
import test from "node:test";
import { mountInsetMap } from "../packages/map/src/InsetMapCanvas";
import type { MapEngine, MapMarkerHandle } from "../packages/map/src/engine/types";
import { createTestMapEngine } from "./engine-test-fakes";

function marker(onRemove: () => void): MapMarkerHandle {
  let lngLat: [number, number] = [0, 0];
  return {
    setLngLat: (next) => {
      lngLat = next;
    },
    getLngLat: () => lngLat,
    setDraggable: () => undefined,
    setRotation: () => undefined,
    on: () => () => undefined,
    remove: onRemove,
  };
}

test("inset maps use an engine lifecycle and release marker/navigation resources", async (context) => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ className: "" }) },
  });
  context.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });

  const backing = createTestMapEngine();
  let markerCreations = 0;
  let markerRemovals = 0;
  const engine: MapEngine = {
    ...backing,
    interactions: {
      ...backing.interactions,
      createMarker: () => {
        markerCreations += 1;
        return marker(() => {
          markerRemovals += 1;
        });
      },
    },
  };

  const session = await mountInsetMap(engine, {} as HTMLElement, {
    center: [8.55, 47.37],
    zoom: 1,
    basemapStyleUrl: "https://example.test/inset-style.json",
    marker: { lngLat: [8.55, 47.37], className: "inset-marker" },
  });

  assert.equal(backing.state.mounted, true);
  assert.equal(
    backing.operations.filter((entry) => entry === "controls.setBuiltInState").length,
    10,
  );
  assert.equal(markerCreations, 1);
  assert.deepEqual(backing.camera.readView().center, [8.55, 47.37]);

  session.update({ center: [7.45, 46.95] });
  assert.equal(markerRemovals, 1);
  assert.deepEqual(backing.camera.readView().center, [7.45, 46.95]);

  session.update({
    center: [7.45, 46.95],
    marker: { lngLat: [7.45, 46.95], className: "inset-marker" },
  });
  assert.equal(markerCreations, 2);

  session.destroy();
  assert.equal(markerRemovals, 2);
  assert.equal(backing.state.destroyed, true);
  assert.ok(backing.operations.includes("interactions.restoreNavigation"));
});
