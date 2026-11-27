import { act, cleanup, i18n, render, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { useTranslation } from "react-i18next";
import { createEmptyProject } from "@geolibre/core";
import {
  addedRasters,
  conversions,
  harnessInfo,
  heldRasterAdds,
  overviewlessHandler,
  rasterAdds,
  rasterHandler,
  resetCogHarness,
  setHoldRasterAdds,
} from "./helpers/cog-conversion-harness";

const { useRasterFileHandlers } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useRasterFileHandlers");
const { clearNotifications, useNotificationStore } =
  await import("../apps/geolibre-desktop/src/lib/notify");

const mapControllerRef = { current: null };
const originalConfirm = window.confirm;
beforeEach(() => {
  window.confirm = () => true;
});
function RasterHost() {
  const { t } = useTranslation();
  useRasterFileHandlers(mapControllerRef, t);
  return null;
}

async function startConversion() {
  assert.ok(rasterHandler);
  const dismiss = mock.fn();
  const run = rasterHandler({
    layerId: "striped",
    name: "striped.tif",
    bytesAreRemote: false,
    readBytes: async () => Uint8Array.of(0x49, 0x49, 42, 0),
    dismiss,
  });
  await waitFor(() => assert.equal(conversions.length, 1));
  return { run, dismiss };
}

afterEach(async () => {
  cleanup();
  clearNotifications();
  resetCogHarness();
  mock.restoreAll();
  window.confirm = originalConfirm;
  await act(() => i18n.changeLanguage("en"));
});

describe("COG convert-and-load lifecycle", () => {
  it("keeps converting when the UI language changes", async () => {
    render(createElement(RasterHost));
    const { run, dismiss } = await startConversion();
    assert.equal(conversions[0].options.transferInput, true);

    await act(() => i18n.changeLanguage("zh"));
    assert.equal(conversions[0].options.signal?.aborted, false);
    assert.equal(useNotificationStore.getState().notifications.length, 1);

    conversions[0].result.resolve(Uint8Array.of(1));
    await run;
    assert.equal(addedRasters, 1);
    assert.equal(dismiss.mock.callCount(), 1);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });

  it("aborts on unmount without replacing the source raster", async () => {
    const host = render(createElement(RasterHost));
    const { run, dismiss } = await startConversion();

    host.unmount();
    await run;
    assert.equal(conversions[0].options.signal?.aborted, true);
    assert.equal(addedRasters, 0);
    assert.equal(dismiss.mock.callCount(), 0);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
    assert.equal(rasterHandler, null);
  });

  it("cancels when another project opens, adding nothing to it", async () => {
    render(createElement(RasterHost));
    const { run, dismiss } = await startConversion();

    act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
    await run;
    assert.equal(conversions[0].options.signal?.aborted, true);
    assert.equal(addedRasters, 0);
    assert.equal(dismiss.mock.callCount(), 0);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });

  it("does not dismiss anything once another project opens during the final add", async () => {
    setHoldRasterAdds(true);
    render(createElement(RasterHost));
    const { run, dismiss } = await startConversion();
    conversions[0].result.resolve(Uint8Array.of(1));
    await waitFor(() => assert.equal(heldRasterAdds.length, 1));
    // The add was handed the conversion's signal, which the switch aborts.
    act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
    assert.equal(rasterAdds[0].signal?.aborted, true);
    // The add itself finishes anyway (it was past its own check).
    heldRasterAdds[0].resolve();
    await run;
    assert.equal(dismiss.mock.callCount(), 0);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });

  it("keeps converting through a collaboration refresh of the open project", async () => {
    render(createElement(RasterHost));
    const { run } = await startConversion();

    act(() =>
      useAppStore.setState((state) => ({ projectGeneration: state.projectGeneration + 1 })),
    );
    conversions[0].result.resolve(Uint8Array.of(1));
    await run;
    assert.equal(addedRasters, 1);
  });

  it("cancels from the notification and preserves the original layer", async () => {
    render(createElement(RasterHost));
    const { run, dismiss } = await startConversion();

    useNotificationStore.getState().notifications[0].action?.onClick();
    await run;
    assert.equal(conversions[0].options.signal?.aborted, true);
    assert.equal(addedRasters, 0);
    assert.equal(dismiss.mock.callCount(), 0);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });
});

describe("overview-less raster notice", () => {
  function notifyOverviewless(overrides: { bytesAreRemote?: boolean; width?: number } = {}) {
    assert.ok(overviewlessHandler);
    // The notice follows its layer, so the layer has to be in the project.
    if (!useAppStore.getState().layers.some((layer) => layer.id === "naip")) {
      act(() =>
        useAppStore.setState((state) => ({
          layers: [
            ...state.layers,
            // Only the id matters to the notice; the cast skips unrelated fields.
            { id: "naip", name: "naip.tif", type: "raster", visible: true, opacity: 1 } as never,
          ],
        })),
      );
    }
    const dismiss = mock.fn();
    overviewlessHandler({
      layerId: "naip",
      name: "naip.tif",
      bytesAreRemote: overrides.bytesAreRemote ?? false,
      readBytes: async () => Uint8Array.of(0x49, 0x49, 42, 0),
      dismiss,
      width: overrides.width ?? 3000,
      height: 3000,
      bands: 3,
    });
    return { dismiss };
  }

  it("offers a conversion that replaces the layer without another prompt", async () => {
    window.confirm = () => {
      throw new Error("the notice's button is the consent; no confirm expected");
    };
    render(createElement(RasterHost));
    const { dismiss } = notifyOverviewless();
    const [notice] = useNotificationStore.getState().notifications;
    assert.equal(notice.kind, "warning");
    assert.match(notice.message, /naip\.tif.*no overviews/);
    assert.ok(notice.action);

    notice.action.onClick();
    await waitFor(() => assert.equal(conversions.length, 1));
    conversions[0].result.resolve(Uint8Array.of(1));
    await waitFor(() => assert.equal(dismiss.mock.callCount(), 1));
    assert.equal(addedRasters, 1);
  });

  it("points at GDAL instead when the browser cannot convert it", () => {
    render(createElement(RasterHost));
    // 40000 x 3000 x 3 bands = 360M samples, past the in-browser cap.
    notifyOverviewless({ width: 40000 });
    const [tooLarge] = useNotificationStore.getState().notifications;
    assert.equal(tooLarge.action, undefined);
    assert.match(tooLarge.description ?? "", /gdaladdo/);

    clearNotifications();
    notifyOverviewless({ bytesAreRemote: true });
    const [remote] = useNotificationStore.getState().notifications;
    assert.equal(remote.action, undefined);
  });

  it("withdraws the notice when its layer leaves the project", () => {
    render(createElement(RasterHost));
    notifyOverviewless();
    assert.equal(useNotificationStore.getState().notifications.length, 1);
    act(() =>
      useAppStore.setState((state) => ({
        layers: state.layers.filter((layer) => layer.id !== "naip"),
      })),
    );
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });

  it("withdraws the notice when another project opens", () => {
    render(createElement(RasterHost));
    notifyOverviewless();
    act(() => useAppStore.getState().loadProject({ ...createEmptyProject(), name: "Opened" }));
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });

  it("still warns about memory for a large raster, and keeps the layer if declined", async () => {
    const prompts: string[] = [];
    window.confirm = (message?: string) => {
      prompts.push(String(message));
      return false;
    };
    harnessInfo.width = 8000;
    harnessInfo.height = 8000;
    render(createElement(RasterHost));
    const { dismiss } = notifyOverviewless();
    useNotificationStore.getState().notifications[0].action?.onClick();
    await waitFor(() => assert.equal(prompts.length, 1));
    assert.match(prompts[0], /8000×8000/);
    assert.equal(conversions.length, 0);
    assert.equal(dismiss.mock.callCount(), 0);
  });

  it("unregisters on unmount and withdraws its notice", () => {
    const host = render(createElement(RasterHost));
    notifyOverviewless();
    host.unmount();
    assert.equal(overviewlessHandler, null);
    assert.equal(useNotificationStore.getState().notifications.length, 0);
  });
});
