import assert from "node:assert/strict";
import test from "node:test";
import { useAppStore } from "../packages/core/src/index";
import {
  initializeNativeCoordinateOpen,
  initialNativeCoordinateTarget,
  finishNativeCoordinateStartup,
} from "../apps/geolibre-desktop/src/lib/native-coordinate-open";

test("native link bridge captures cold launches and moves the live map without replacing layers", async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  let handler: (event: { payload: string[] }) => void = () => {};
  const commands: string[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      transformCallback(callback: typeof handler) {
        handler = callback;
        return 1;
      },
      async invoke(command: string) {
        commands.push(command);
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:deep-link|get_current") return ["geo:40.7128,-74.006?z=12"];
        throw new Error(command);
      },
    },
  };
  try {
    await initializeNativeCoordinateOpen();
    assert.deepEqual(commands, ["plugin:event|listen", "plugin:deep-link|get_current"]);
    assert.deepEqual(initialNativeCoordinateTarget(), { center: [-74.006, 40.7128], zoom: 12 });
    finishNativeCoordinateStartup();
    const { layers, projectGeneration } = useAppStore.getState();
    handler({ payload: ["geo:0,0?q=51.5,-0.12(London)&z=15"] });
    assert.deepEqual(useAppStore.getState().mapView.center, [-0.12, 51.5]);
    assert.equal(useAppStore.getState().mapView.zoom, 15);
    assert.equal(useAppStore.getState().layers, layers);
    assert.equal(useAppStore.getState().projectGeneration, projectGeneration);
    handler({ payload: ["geo:0,0?q=an+address"] });
    assert.deepEqual(useAppStore.getState().mapView.center, [-0.12, 51.5]);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
  }
});
