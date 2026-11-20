import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { addRasterToMap } = await import("../packages/plugins/src/plugins/maplibre-raster");

/** The raster control the first test mounts; module state, reused by later adds. */
let mounted: {
  addRaster: (...args: unknown[]) => Promise<string>;
  getRaster: (id: string) => unknown;
  removeRaster: (id: string) => void;
} | null = null;

describe("addRasterToMap", () => {
  it("adds nothing once its signal is aborted while the control mounts", async () => {
    const controller = new AbortController();
    const app = {
      getMapRenderer: () => "maplibre",
      getMapboxMap: () => null,
      getMap: () => null,
      // The project is replaced while the raster control is still mounting.
      addMapControl: (control: NonNullable<typeof mounted>) => {
        mounted = control;
        controller.abort(new DOMException("replaced", "AbortError"));
        return true;
      },
    };
    const file = new File([new Uint8Array(8)], "dem.tif");
    await assert.rejects(
      addRasterToMap(app as never, file, { signal: controller.signal, zoomTo: false }),
      { name: "AbortError" },
    );
    assert.deepEqual(useAppStore.getState().layers, []);
  });

  /**
   * Starts an add whose header read settles (fails, or succeeds with
   * `succeed`) after `interrupt` runs, and returns the raster ids its clean-up
   * removed.
   */
  async function failAfter(
    interrupt: (controller: AbortController) => void,
    succeed = false,
  ): Promise<string[]> {
    assert.ok(mounted, "the first test mounted the control");
    const control = mounted;
    const pending = Promise.withResolvers<string>();
    const removed: string[] = [];
    const originals = {
      addRaster: control.addRaster,
      getRaster: control.getRaster,
      removeRaster: control.removeRaster,
    };
    control.addRaster = () => pending.promise;
    control.getRaster = (id) => ({ id, error: new Error("fetch failed") });
    control.removeRaster = (id) => void removed.push(id);
    try {
      const controller = new AbortController();
      const app = {
        getMapRenderer: () => "maplibre",
        getMapboxMap: () => null,
        getMap: () => null,
      };
      const adding = addRasterToMap(app as never, new File([new Uint8Array(8)], "dem.tif"), {
        id: "shared-raster",
        signal: controller.signal,
        zoomTo: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      interrupt(controller);
      if (succeed) pending.resolve("shared-raster");
      else pending.reject(new Error("fetch failed"));
      await assert.rejects(adding);
      return removed;
    } finally {
      Object.assign(control, originals);
    }
  }

  it("leaves a cancelled add's failure clean-up to the project switch", async () => {
    // Another project, which may hold its own "shared-raster", replaces this
    // one while the header is read; then the read fails.
    const removed = await failAfter((controller) => {
      useAppStore.setState((state) => ({ projectLoadCount: state.projectLoadCount + 1 }));
      controller.abort(new DOMException("replaced", "AbortError"));
    });
    assert.deepEqual(removed, []);
  });

  it("still removes its failed raster when cancelled without a project switch", async () => {
    // An unmounted caller aborts; the project, and this failed raster, remain.
    const removed = await failAfter((controller) =>
      controller.abort(new DOMException("unmounted", "AbortError")),
    );
    assert.deepEqual(removed, ["shared-raster"]);
  });

  it("removes a raster whose header loaded after the add was cancelled", async () => {
    // The user cancels while the header is read; the read then succeeds. The
    // add rejects, so the raster it put in the control must not stay.
    const removed = await failAfter(
      (controller) => controller.abort(new DOMException("cancelled", "AbortError")),
      true,
    );
    assert.deepEqual(removed, ["shared-raster"]);
  });

  it("leaves a raster loaded after a project switch to that project's restore", async () => {
    const removed = await failAfter((controller) => {
      useAppStore.setState((state) => ({ projectLoadCount: state.projectLoadCount + 1 }));
      controller.abort(new DOMException("replaced", "AbortError"));
    }, true);
    assert.deepEqual(removed, []);
  });
});
