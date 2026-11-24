import { render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { createDefaultPrintLayout } from "../packages/core/src/print-layout-config";
import type { LayoutOptions } from "../apps/geolibre-desktop/src/lib/print-layout";
import type { CapturedMap } from "../apps/geolibre-desktop/src/lib/print-layout-export";

const { useInsetMap } =
  await import("../apps/geolibre-desktop/src/components/layout/print-layout/useInsetMap");

it("reports an unavailable inset for a georeference with non-finite boundary coordinates", () => {
  const captured: CapturedMap = {
    image: document.createElement("canvas"),
    width: 100,
    height: 100,
    metersPerPixel: 1,
    pixelRatio: 1,
    bearingDeg: 0,
    georef: {
      transform: [0, 1, 0, 0, 0, -1],
      projection: {
        epsg: 4326,
        wkt: null,
        geographic: true,
        forward: (lng, lat) => [lng, lat],
        inverse: () => [NaN, NaN],
      },
    },
  };
  const options: LayoutOptions = {
    title: "",
    subtitle: "",
    paperSize: "fullhd",
    orientation: "landscape",
    showTitle: false,
    showLegend: false,
    showScaleBar: false,
    showNorthArrow: false,
    showFooter: false,
    footerText: "",
    legend: [],
    legendTitle: "",
    legendGroupByLayer: true,
    metersPerPixel: 1,
    bearingDeg: 0,
    mapImage: captured.image,
    mapImageWidth: captured.width,
    mapImageHeight: captured.height,
  };
  function Probe() {
    const state = useInsetMap(
      true,
      { ...createDefaultPrintLayout(), showInset: true },
      options,
      captured,
    );
    return createElement(
      "output",
      null,
      JSON.stringify({
        unavailable: state.unavailable,
        ready: state.ready,
        loading: state.loading,
        failed: state.failed,
      }),
    );
  }
  render(createElement(Probe));
  assert.deepEqual(JSON.parse(screen.getByRole("status").textContent!), {
    unavailable: true,
    ready: false,
    loading: false,
    failed: false,
  });
});
