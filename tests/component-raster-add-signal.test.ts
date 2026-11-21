import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geojsonLayer } from "./helpers/layer-fixtures";

const { addRasterToMap, setNonTiledRasterHandler } =
  await import("../packages/plugins/src/plugins/maplibre-raster");

/** The raster control the first test mounts; module state, reused by later adds. */
let mounted: {
  addRaster: (...args: unknown[]) => Promise<string>;
  getRaster: (id: string) => unknown;
  removeRaster: (id: string) => void;
  _emit: (type: string, extra?: { layerId?: string }) => void;
} | null = null;

/**
 * Mounts the raster control through an add whose signal is aborted while the
 * control mounts (the project is replaced). The control is module state, so
 * later adds reuse it.
 */
async function mountAbortedAdd(): Promise<void> {
  const controller = new AbortController();
  const app = {
    getMapRenderer: () => "maplibre",
    getMapboxMap: () => null,
    getMap: () => null,
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
}

describe("addRasterToMap", () => {
  it("adds nothing once its signal is aborted while the control mounts", async () => {
    await mountAbortedAdd();
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
    // Mounted here too, so a test selected on its own does not depend on the
    // first one having run.
    if (!mounted) await mountAbortedAdd();
    assert.ok(mounted, "the raster control is mounted");
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

  /**
   * Fires the control's "error" event for a striped GeoTIFF with id `layerId`
   * and returns the layer ids the non-tiled conversion handler was offered.
   */
  async function offerConversion(layerId: string): Promise<string[]> {
    if (!mounted) await mountAbortedAdd();
    assert.ok(mounted, "the raster control is mounted");
    const control = mounted;
    const offered: string[] = [];
    const getRaster = control.getRaster;
    control.getRaster = (id) => ({
      id,
      name: "striped.tif",
      error: new Error("GeoTIFF is not tiled"),
      source: { kind: "url", url: "https://example.com/striped.tif" },
    });
    setNonTiledRasterHandler(({ layerId: offeredId }) => void offered.push(offeredId));
    try {
      control._emit("error", { layerId });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return offered;
    } finally {
      control.getRaster = getRaster;
      setNonTiledRasterHandler(null);
    }
  }

  it("offers to convert a striped GeoTIFF in the open project", async () => {
    useAppStore.setState({
      // Only the id matters to the check: the store holds the raster.
      layers: [geojsonLayer({ id: "striped", name: "striped.tif" })],
    });
    try {
      assert.deepEqual(await offerConversion("striped"), ["striped"]);
    } finally {
      useAppStore.setState({ layers: [] });
    }
  });

  it("does not convert a striped GeoTIFF left behind by a replaced project", async () => {
    // The raster's project was replaced before its error arrived, so the store
    // (now the replacement project) no longer holds it; the restore has not
    // pruned it from the control yet.
    assert.deepEqual(await offerConversion("striped"), []);
  });
});
