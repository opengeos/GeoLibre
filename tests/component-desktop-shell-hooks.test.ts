import { act, i18n, mockFetch, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderHook } from "@testing-library/react";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  clearDiagnostics,
  getDiagnosticsSnapshot,
  installDiagnosticsCapture,
} from "../apps/geolibre-desktop/src/lib/diagnostics";
import { clearNotifications, useNotificationStore } from "../apps/geolibre-desktop/src/lib/notify";
import { useLineOfSightTool } from "../apps/geolibre-desktop/src/lib/line-of-sight-store";

const { identifyAllLabels, useIdentifyAllLabels } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useIdentifyAllLabels");
const { projectReadyGeneration, useProjectReadyMarkers } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useProjectReadyMarkers");
const { useMapDiagnosticEvents } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useMapDiagnosticEvents");
const { usePluginRegistryPrefetch } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/usePluginRegistryPrefetch");
const { useKnowledgeLineOfSightExclusivity } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useKnowledgeLineOfSightExclusivity");
const { useProjectUrlSettled } =
  await import("../apps/geolibre-desktop/src/hooks/desktop-shell/useProjectUrlSettled");

const t = i18n.t.bind(i18n);

afterEach(() => {
  clearNotifications();
  clearDiagnostics();
  window.history.replaceState(null, "", "/");
});

describe("identify-all labels", () => {
  it("translates the static strings and interpolates counts and indexes", () => {
    const labels = identifyAllLabels(t);
    assert.equal(labels.pixel, t("map.identifyAll.pixel"));
    assert.equal(labels.photo.close, t("map.identifyAll.photoClose"));
    assert.equal(labels.title(3), t("map.identifyAll.title", { count: 3 }));
    assert.equal(labels.pixelBand(2), t("map.identifyAll.pixelBand", { index: 2 }));
    assert.equal(labels.featureFallback(7), t("map.identifyAll.featureFallback", { index: 7 }));
    assert.notEqual(labels.resultCount(1), "map.identifyAll.resultCount");
  });

  it("keeps the same object across renders until the translator changes", () => {
    const { result, rerender } = renderHook(({ translate }) => useIdentifyAllLabels(translate), {
      initialProps: { translate: t },
    });
    const first = result.current;
    rerender({ translate: t });
    assert.equal(result.current, first);
    const other = ((key: string) => `x:${key}`) as unknown as typeof t;
    rerender({ translate: other });
    assert.notEqual(result.current, first);
    assert.equal(result.current.pixel, "x:map.identifyAll.pixel");
  });
});

describe("project ready markers", () => {
  const ready = {
    projectGeneration: 4,
    externalPluginsReady: true,
    pendingTrustCount: 0,
    restoredProjectGeneration: 4,
  };

  it("is ready only once plugins load, trust settles and this generation restored", () => {
    assert.equal(projectReadyGeneration(ready), "4");
    assert.equal(projectReadyGeneration({ ...ready, externalPluginsReady: false }), "");
    assert.equal(projectReadyGeneration({ ...ready, pendingTrustCount: 1 }), "");
    assert.equal(projectReadyGeneration({ ...ready, restoredProjectGeneration: 3 }), "");
    assert.equal(projectReadyGeneration({ ...ready, restoredProjectGeneration: null }), "");
  });

  it("publishes both generations on the root element and clears them on unmount", () => {
    const root = document.documentElement;
    const { rerender, unmount } = renderHook((state) => useProjectReadyMarkers(state), {
      initialProps: { ...ready, pendingTrustCount: 1 },
    });
    assert.equal(root.dataset.geolibreProjectGeneration, "4");
    assert.equal(root.dataset.geolibreProjectReadyGeneration, "");
    rerender(ready);
    assert.equal(root.dataset.geolibreProjectReadyGeneration, "4");
    rerender({ ...ready, projectGeneration: 5 });
    assert.equal(root.dataset.geolibreProjectGeneration, "5");
    assert.equal(root.dataset.geolibreProjectReadyGeneration, "");
    unmount();
    assert.equal(root.dataset.geolibreProjectGeneration, undefined);
    assert.equal(root.dataset.geolibreProjectReadyGeneration, undefined);
  });
});

describe("map diagnostic events", () => {
  const layers = [
    { id: "roads", name: "Roads", source: { type: "geojson" } },
    {
      id: "xyz",
      name: "Imagery",
      source: { tiles: ["https://tiles.example.com/v1/{z}/{x}/{y}.png"] },
    },
  ] as unknown as GeoLibreLayer[];
  const notifications = () => useNotificationStore.getState().notifications;

  it("records every event in Diagnostics but toasts a layer only once", () => {
    useAppStore.setState({ layers });
    const { result } = renderHook(() => useMapDiagnosticEvents(t));
    act(() => {
      result.current({ message: "boom", source: "cesium", layerId: "roads", status: 500 });
      result.current({ message: "again", source: "cesium", layerId: "roads", status: 500 });
      result.current({ message: "throttled", source: "cesium", layerId: "xyz", status: 429 });
    });
    // Diagnostics lists the newest record first.
    const records = getDiagnosticsSnapshot()
      .records.filter((r) => r.category === "map")
      .reverse();
    assert.deepEqual(
      records.map((r) => [r.message, r.level]),
      [
        ["boom", "error"],
        ["again", "error"],
        ["throttled", "warning"],
      ],
    );
    assert.deepEqual(
      notifications().map((n) => n.kind),
      ["error", "warning"],
    );
    assert.match(notifications()[0]!.message, /Roads/);
    // The error toast links the Diagnostics record it was written for.
    assert.equal(notifications()[0]!.diagnostic?.message, "boom");
  });

  it("follows tile responses only while mounted", async () => {
    useAppStore.setState({ layers });
    const realFetch = globalThis.fetch;
    mockFetch(async () => new Response("", { status: 403 }));
    const uninstall = installDiagnosticsCapture();
    try {
      const { unmount } = renderHook(() => useMapDiagnosticEvents(t));
      await fetch("https://tiles.example.com/v1/1/0/0.png");
      assert.equal(notifications().length, 1);
      assert.equal(notifications()[0]!.kind, "warning");
      unmount();
      clearNotifications();
      // A fresh mount has a fresh "already told" record, so silence here means
      // the unmounted hook's observer is gone.
      await fetch("https://tiles.example.com/v1/1/0/1.png");
      assert.equal(notifications().length, 0);
    } finally {
      uninstall();
      globalThis.fetch = realFetch;
    }
  });
});

describe("plugin registry prefetch", () => {
  it("fetches the registry when plugins can be installed and aborts on unmount", async () => {
    const signals: AbortSignal[] = [];
    mockFetch(async (_input, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => {});
    });
    const { unmount } = renderHook(() => usePluginRegistryPrefetch());
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.aborted, false);
    unmount();
    assert.equal(signals[0]!.aborted, true);
  });

  it("skips the fetch when the deployment disables plugin installation", () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return new Response("{}");
    });
    useAppStore.getState().setDeploymentCapabilities([]);
    renderHook(() => usePluginRegistryPrefetch());
    assert.equal(calls, 0);
  });

  it("swallows a failed fetch", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    renderHook(() => usePluginRegistryPrefetch());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("knowledge card and Line of Sight", () => {
  it("closes whichever was open first when the other opens", () => {
    const setPlace: Array<unknown> = [];
    const closeLineOfSight = useLineOfSightTool.getState().closeLineOfSight;
    let closed = 0;
    useLineOfSightTool.setState({
      request: 0,
      closeLineOfSight: () => {
        closed += 1;
      },
    });
    try {
      const { rerender } = renderHook(
        ({ place }) => useKnowledgeLineOfSightExclusivity(place, (next) => setPlace.push(next)),
        { initialProps: { place: null as { lat: number; lng: number } | null } },
      );
      assert.deepEqual(setPlace, []);
      assert.equal(closed, 0);
      act(() => useLineOfSightTool.setState({ request: 1 }));
      assert.deepEqual(setPlace, [null]);
      rerender({ place: { lat: 1, lng: 2 } });
      assert.equal(closed, 1);
    } finally {
      useLineOfSightTool.setState({ request: 0, closeLineOfSight });
    }
  });
});

describe("project URL settled", () => {
  it("is settled at once without a ?url= project", () => {
    const { result } = renderHook(() => useProjectUrlSettled(undefined));
    assert.equal(result.current, true);
  });

  it("waits for the ?url= project, then stays settled when the loader idles", () => {
    window.history.replaceState(null, "", "/?url=https://example.com/p.geolibre.json");
    const { result, rerender } = renderHook(({ state }) => useProjectUrlSettled(state), {
      initialProps: { state: { status: "loading" } as never },
    });
    assert.equal(result.current, false);
    rerender({ state: { status: "loaded" } as never });
    assert.equal(result.current, true);
    rerender({ state: { status: "idle" } as never });
    assert.equal(result.current, true);
  });

  it("treats a failed ?url= load as settled", () => {
    window.history.replaceState(null, "", "/?url=https://example.com/p.geolibre.json");
    const { result } = renderHook(() => useProjectUrlSettled({ status: "error" } as never));
    assert.equal(result.current, true);
  });
});
