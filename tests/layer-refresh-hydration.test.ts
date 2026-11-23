import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { act, render, screen, useAppStore, waitFor } from "./helpers/dom";
import { geojsonLayer } from "./helpers/layer-fixtures";
import type { FeatureCollection } from "geojson";

const { useLayerRefresh } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/useLayerRefresh");

const LAYER_ID = "wfs-hydration";

function RefreshHost() {
  const layers = useAppStore((state) => state.layers);
  const refresh = useLayerRefresh({ layers, isCollapsed: true });
  return createElement(
    "output",
    { "data-testid": "refresh-status" },
    refresh.refreshStatuses[LAYER_ID]?.type ?? "idle",
  );
}

function collection(label: string): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { label },
        geometry: { type: "Point", coordinates: [11, 41] },
      },
    ],
  };
}

describe("WFS hydration lifecycle", () => {
  it("hydrates without a LayerPanel and retries a changed URL without accepting stale data", async () => {
    useAppStore.getState().newProject({ name: "Hidden-panel WFS" });
    const firstUrl = "https://example.test/wfs?service=WFS&request=GetFeature&typeNames=roads";
    const secondUrl = "https://example.test/wfs?service=WFS&request=GetFeature&typeNames=bridges";
    const layerId = LAYER_ID;
    useAppStore.getState().addLayer(
      geojsonLayer({
        id: layerId,
        name: "Reference WFS",
        source: { type: "geojson", url: firstUrl },
        metadata: { sourceKind: "wfs-getfeature" },
        geojson: undefined,
      }),
    );
    const pendingResponses: Array<(response: Response) => void> = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => pendingResponses.push(resolve))) as typeof fetch;

    render(createElement(RefreshHost));
    await waitFor(() => assert.equal(pendingResponses.length, 1));
    assert.equal(screen.getByTestId("refresh-status").textContent, "refreshing");

    const currentLayer = useAppStore.getState().layers.find((layer) => layer.id === layerId);
    assert.ok(currentLayer);
    act(() => {
      useAppStore.getState().updateLayer(layerId, {
        source: { ...currentLayer.source, url: secondUrl },
      });
    });
    await waitFor(() => assert.equal(pendingResponses.length, 2));

    await act(async () => {
      pendingResponses[1](
        new Response(JSON.stringify(collection("new URL")), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await waitFor(() => {
      assert.equal(
        useAppStore.getState().layers.find((layer) => layer.id === layerId)?.geojson?.features[0]
          ?.properties?.label,
        "new URL",
      );
    });

    await act(async () => {
      pendingResponses[0](
        new Response(JSON.stringify(collection("stale URL")), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    assert.equal(
      useAppStore.getState().layers.find((layer) => layer.id === layerId)?.geojson?.features[0]
        ?.properties?.label,
      "new URL",
    );
    assert.equal(screen.getByTestId("refresh-status").textContent, "success");

    act(() => useAppStore.getState().newProject({ name: "Next project" }));
    await waitFor(() => assert.equal(screen.getByTestId("refresh-status").textContent, "idle"));
  });
  it("ignores hydration responses from a replaced project with a reused layer id", async () => {
    const firstUrl = "https://example.test/first/wfs";
    const secondUrl = "https://example.test/second/wfs";
    const pendingResponses: Array<(response: Response) => void> = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => pendingResponses.push(resolve))) as typeof fetch;
    useAppStore.getState().newProject({ name: "Original project" });
    useAppStore.getState().addLayer(
      geojsonLayer({
        id: LAYER_ID,
        source: { type: "geojson", url: firstUrl },
        metadata: { sourceKind: "wfs-getfeature" },
        geojson: undefined,
      }),
    );
    render(createElement(RefreshHost));
    await waitFor(() => assert.equal(pendingResponses.length, 1));

    act(() => {
      useAppStore.getState().newProject({ name: "Replacement project" });
      useAppStore.getState().addLayer(
        geojsonLayer({
          id: LAYER_ID,
          source: { type: "geojson", url: secondUrl },
          metadata: { sourceKind: "wfs-getfeature" },
          geojson: undefined,
        }),
      );
    });
    await waitFor(() => assert.equal(pendingResponses.length, 2));

    await act(async () => {
      pendingResponses[0](
        new Response(JSON.stringify(collection("old project")), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    assert.equal(useAppStore.getState().layers[0]?.geojson, undefined);

    await act(async () => {
      pendingResponses[1](
        new Response(JSON.stringify(collection("new project")), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await waitFor(() => {
      assert.equal(
        useAppStore.getState().layers[0]?.geojson?.features[0]?.properties?.label,
        "new project",
      );
    });
  });
  it("refreshes an already-hydrated WFS layer when its URL changes", async () => {
    const firstUrl = "https://example.test/wfs?typeNames=roads";
    const secondUrl = "https://example.test/wfs?typeNames=bridges";
    const layerId = LAYER_ID;
    const pendingResponses: Array<(response: Response) => void> = [];
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => pendingResponses.push(resolve))) as typeof fetch;
    useAppStore.getState().newProject({ name: "Hydrated WFS URL change" });
    useAppStore.getState().addLayer(
      geojsonLayer({
        id: layerId,
        source: { type: "geojson", url: firstUrl },
        metadata: { sourceKind: "wfs-getfeature" },
        geojson: collection("first URL"),
      }),
    );

    render(createElement(RefreshHost));
    assert.equal(pendingResponses.length, 0, "first observation of hydrated data does not refetch");

    const currentLayer = useAppStore.getState().layers.find((layer) => layer.id === layerId);
    assert.ok(currentLayer);
    act(() => {
      useAppStore.getState().updateLayer(layerId, {
        source: { ...currentLayer.source, url: secondUrl },
      });
    });
    await waitFor(() => assert.equal(pendingResponses.length, 1));
    await act(async () => {
      pendingResponses[0](
        new Response(JSON.stringify(collection("second URL")), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await waitFor(() => {
      assert.equal(
        useAppStore.getState().layers[0]?.geojson?.features[0]?.properties?.label,
        "second URL",
      );
    });
  });
});
