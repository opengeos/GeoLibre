import { act, cleanup, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { createElement } from "react";
import { geojsonLayer } from "./helpers/layer-fixtures";

const { useLayerRefresh } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/useLayerRefresh");

function RefreshHost() {
  const layers = useAppStore((state) => state.layers);
  const refresh = useLayerRefresh({ layers, isCollapsed: true });
  return createElement(
    "button",
    { onClick: () => void refresh.handleRefreshLayer(layers[0]) },
    "Retry",
  );
}

afterEach(() => {
  cleanup();
  mock.restoreAll();
});

it("hydrates GCS through the refresh pipeline and supports manual retry after failure", async () => {
  let fail = true;
  const data = { type: "FeatureCollection", features: [] };
  const fetcher = mock.method(globalThis, "fetch", async (_url: RequestInfo | URL) =>
    fail ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(data),
  );
  const layer = geojsonLayer({ geojson: undefined, source: { url: " GS://bucket/data.json " } });
  useAppStore.setState({ layers: [layer] });
  render(createElement(RefreshHost));
  await waitFor(() =>
    assert.match(useAppStore.getState().layers[0].connection?.lastError ?? "", /503/),
  );
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(
    fetcher.mock.calls[0].arguments[0],
    "https://storage.googleapis.com/bucket/data.json",
  );
  act(() => useAppStore.getState().updateLayer(layer.id, { name: "Renamed" }));
  assert.equal(fetcher.mock.callCount(), 1);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => assert.deepEqual(useAppStore.getState().layers[0].geojson, data));
});

it("does not hydrate source kinds owned by other loaders", () => {
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json({}));
  useAppStore.setState({
    layers: [
      geojsonLayer({
        geojson: undefined,
        source: { url: "https://example.com/data.json" },
        metadata: { sourceKind: "other-loader" },
      }),
    ],
  });
  render(createElement(RefreshHost));
  assert.equal(fetcher.mock.callCount(), 0);
});

it("ignores stale responses after source replacement or removal", async () => {
  for (const remove of [false, true]) {
    let finish!: (response: Response) => void;
    mock.method(
      globalThis,
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const layer = geojsonLayer({
      geojson: undefined,
      source: { url: "https://example.com/old.json" },
    });
    useAppStore.setState({ layers: [layer] });
    render(createElement(RefreshHost));
    await waitFor(() => assert.ok(finish));
    const finishOld = finish;
    act(() => {
      if (remove) useAppStore.setState({ layers: [] });
      else
        useAppStore
          .getState()
          .updateLayer(layer.id, { source: { url: "https://example.com/new.json" } });
    });
    // Resolve the old request before the newer request settles.
    await act(async () => finishOld(Response.json({ type: "FeatureCollection", features: [] })));
    if (remove) assert.equal(useAppStore.getState().layers.length, 0);
    else assert.equal(useAppStore.getState().layers[0].geojson, undefined);
    cleanup();
    mock.restoreAll();
  }
});
