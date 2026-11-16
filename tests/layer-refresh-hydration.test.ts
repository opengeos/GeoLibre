import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { act, cleanup, render, screen, useAppStore, waitFor } from "./helpers/dom";
import { geojsonLayer } from "./helpers/layer-fixtures";
import { createEmptyProject } from "@geolibre/core";
import {
  normalizeDesktopSettings,
  useDesktopSettingsStore,
} from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import { withStartupLayers } from "../apps/geolibre-desktop/src/lib/startup-layers";
import type { FeatureCollection } from "geojson";

const { useLayerRefresh } =
  await import("../apps/geolibre-desktop/src/components/panels/layer-panel/useLayerRefresh");

const LAYER_ID = "wfs-hydration";

afterEach(() => mock.restoreAll());

it("bootstraps public sources while blocking private hosts and potentially signed S3 reads", async () => {
  for (const url of [
    "http://localhost/data.json",
    "http://localhost./data.json",
    "http://tiles.localhost/data.json",
    "http://127.2.3.4/data.json",
    "http://0.0.0.0/data.json",
    "http://10.0.0.1/data.json",
    "http://172.16.0.1/data.json",
    "http://192.168.0.1/data.json",
    "http://169.254.1.1/data.json",
    "http://[::]/data.json",
    "http://[::1]/data.json",
    "http://[fc00::1]/data.json",
    "http://[fdff::1]/data.json",
    "http://[fe80::1]/data.json",
    "http://[fe90::1]/data.json",
    "http://[fea0::1]/data.json",
    "http://[febf::1]/data.json",
    "http://[::ffff:192.168.0.1]/data.json",
    "s3://private-bucket/data.json",
    "s3a://private-bucket/data.json",
    "https://private-bucket.s3.amazonaws.com/data.json",
    "https://s3.amazonaws.com/private-bucket/data.json",
  ]) {
    useAppStore.getState().newProject({ name: url });
    useAppStore.getState().addLayer(
      geojsonLayer({
        id: LAYER_ID,
        source: { type: "geojson", url },
        geojson: undefined,
      }),
    );
    const fetcher = mock.method(globalThis, "fetch", async () =>
      Response.json(collection("blocked")),
    );
    await act(async () => {
      render(createElement(RefreshHost));
    });
    assert.equal(fetcher.mock.callCount(), 0, url);
    cleanup();
    mock.restoreAll();
  }

  for (const [url, metadata] of [
    ["https://example.test/data.json", {}],
    ["gs://public-bucket/data.json", {}],
    ["http://localhost/wfs", { sourceKind: "wfs-getfeature" }],
  ] as const) {
    useAppStore.getState().newProject({ name: url });
    useAppStore.getState().addLayer(
      geojsonLayer({
        id: LAYER_ID,
        source: { type: "geojson", url },
        metadata,
        geojson: undefined,
      }),
    );
    const fetcher = mock.method(globalThis, "fetch", async () =>
      Response.json(collection("allowed")),
    );
    render(createElement(RefreshHost));
    await waitFor(() =>
      assert.equal(useAppStore.getState().layers[0]?.geojson?.features.length, 1),
    );
    assert.equal(fetcher.mock.callCount(), 1, url);
    cleanup();
    mock.restoreAll();
  }
});

it("refreshes a hydrated non-WFS layer after its public URL changes", async () => {
  useAppStore.getState().newProject({ name: "Hydrated GeoJSON" });
  useAppStore.getState().addLayer(
    geojsonLayer({
      id: LAYER_ID,
      source: { type: "geojson", url: "https://example.test/first.json" },
      geojson: collection("first"),
    }),
  );
  const fetcher = mock.method(globalThis, "fetch", async () => Response.json(collection("second")));
  render(createElement(RefreshHost));
  assert.equal(fetcher.mock.callCount(), 0);
  act(() =>
    useAppStore.getState().updateLayer(LAYER_ID, {
      source: { type: "geojson", url: "https://example.test/second.json" },
    }),
  );
  await waitFor(() =>
    assert.equal(
      useAppStore.getState().layers[0]?.geojson?.features[0]?.properties?.label,
      "second",
    ),
  );
  assert.equal(fetcher.mock.callCount(), 1);
});

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
    mock.method(
      globalThis,
      "fetch",
      () => new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    );

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
    mock.method(
      globalThis,
      "fetch",
      () => new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    );
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
    mock.method(
      globalThis,
      "fetch",
      () => new Promise<Response>((resolve) => pendingResponses.push(resolve)),
    );
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

it("hydrates startup URL layers once, keeping the workspace clean and out of undo history", async () => {
  const bare = geojsonLayer({
    id: LAYER_ID,
    source: { type: "geojson", url: "https://example.test/startup.json" },
    geojson: undefined,
  });
  const settings = normalizeDesktopSettings({});
  const originalSettings = useDesktopSettingsStore.getState().desktopSettings;
  try {
    useDesktopSettingsStore.getState().setDesktopSettings({
      ...settings,
      startup: {
        ...settings.startup,
        layers: { fileName: "layers.json", path: "layers.json", layers: [bare], layerGroups: [] },
      },
    });
    useAppStore.getState().loadProject(withStartupLayers(createEmptyProject()), null);
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return Response.json(collection("startup"));
    });
    render(createElement(RefreshHost));
    await waitFor(() =>
      assert.equal(useAppStore.getState().layers[0]?.geojson?.features.length, 1),
    );
    assert.equal(calls, 1);
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  } finally {
    useDesktopSettingsStore.getState().setDesktopSettings(originalSettings);
  }
});
