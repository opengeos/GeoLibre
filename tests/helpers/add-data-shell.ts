/**
 * Render an Add Data source component inside a minimal Add Data shell, the
 * context `AddDataDialog` normally provides, and record what it does.
 *
 * This module imports `./dom` itself before loading the shell context, so the
 * source's CSS imports and Vite globals resolve; load the source under test
 * with a dynamic `import()` as usual.
 */
import type { GeoLibreLayer } from "@geolibre/core";
import { createElement, createRef, type ReactElement, useState } from "react";
import type { AddDataShellContextValue } from "../../apps/geolibre-desktop/src/components/layout/add-data/context";
import { render } from "./dom";

const { AddDataShellProvider } =
  await import("../../apps/geolibre-desktop/src/components/layout/add-data/context");

/** A Martin connection that is never started. */
const IDLE_MARTIN: AddDataShellContextValue["martin"] = {
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
};

/**
 * Render `source` inside the shell.
 *
 * Args:
 *   source: The source element, e.g. `createElement(WmsSource, props)`.
 *
 * Returns:
 *   The layers the source added, and how many times it closed the dialog.
 */
export function renderAddDataSource(source: ReactElement): {
  added: GeoLibreLayer[];
  closed: () => number;
} {
  const added: GeoLibreLayer[] = [];
  let closed = 0;
  function Shell() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const shell: AddDataShellContextValue = {
      mapControllerRef: createRef(),
      addLayer: (layer) => void added.push(layer),
      existingLayers: [],
      isSubmitting,
      setIsSubmitting,
      closeDialog: () => void (closed += 1),
      targetGroupId: null,
      martin: IDLE_MARTIN,
    };
    return createElement(AddDataShellProvider, { value: shell }, source);
  }
  render(createElement(Shell));
  return { added, closed: () => closed };
}
