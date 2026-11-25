import { render, screen, fireEvent, waitFor, useAppStore, act } from "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement, createRef, useState } from "react";
import type { AddDataShellContextValue } from "../apps/geolibre-desktop/src/components/layout/add-data/context";

const [{ OgcCoveragesSource }, { AddDataShellProvider }] = await Promise.all([
  import("../apps/geolibre-desktop/src/components/layout/add-data/sources/OgcCoveragesSource"),
  import("../apps/geolibre-desktop/src/components/layout/add-data/context"),
]);

function coverageForm() {
  function Shell() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const shell: AddDataShellContextValue = {
      mapControllerRef: createRef(),
      addLayer: () => {},
      existingLayers: [],
      isSubmitting,
      setIsSubmitting,
      closeDialog: () => {},
      targetGroupId: null,
      martin: {
        server: null,
        setServer: () => {},
        sources: [],
        setSources: () => {},
        selectedSourceId: "",
        setSelectedSourceId: () => {},
        status: null,
        setStatus: () => {},
        markLayerAdded: () => {},
        resetOnOpen: () => {},
        stopTransient: () => {},
      },
    };
    return createElement(
      AddDataShellProvider,
      { value: shell },
      createElement(OgcCoveragesSource, {
        initialUrl: "https://example.org/collections/gdps-temperature",
      }),
    );
  }
  return render(createElement(Shell));
}

for (const action of ["project switch", "unmount"] as const) {
  test(`a ${action} aborts a pending coverage download before it can publish a raster`, async () => {
    const metadata = readFileSync(
      new URL("./fixtures/ogc-coverages/gdps-collection.json", import.meta.url),
      "utf8",
    );
    let pendingSignal: AbortSignal | undefined;
    globalThis.fetch = async (input, init) => {
      if (!String(input).includes("/coverage?")) return new Response(metadata);
      const signal = init?.signal;
      assert.ok(signal);
      pendingSignal = signal;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const form = coverageForm();
    fireEvent.click(screen.getByRole("button", { name: "Retrieve collections" }));
    await waitFor(() =>
      assert.equal(screen.getByLabelText("Coverage").hasAttribute("disabled"), false),
    );
    for (const [name, value] of [
      ["West", "-80"],
      ["South", "43"],
      ["East", "-79"],
      ["North", "44"],
    ]) {
      fireEvent.change(screen.getByLabelText(name), { target: { value } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Add layer" }));
    await waitFor(() => assert.ok(pendingSignal));
    await act(async () => {
      if (action === "unmount") form.unmount();
      else useAppStore.setState((state) => ({ projectLoadCount: state.projectLoadCount + 1 }));
    });
    assert.ok(pendingSignal?.aborted);
    assert.equal(useAppStore.getState().layers.length, 0);
  });
}
