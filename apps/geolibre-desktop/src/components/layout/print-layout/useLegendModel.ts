import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import type { GeoLibreLayer, LegendConfig } from "@geolibre/core";
import { loadMarkerSvgImage } from "@geolibre/map";
import {
  applyLegendConfig,
  buildLegend,
  legendEditorRows,
  reorderLegendEntry,
} from "../../../lib/print-layout-export";

/**
 * The auto-built legend for the Print Layout composer: the entries built from
 * the project's layers, the project's legend overrides applied on top, the
 * editor rows, and the custom SVG marker images its swatches need.
 *
 * @param layers - The project's layers (empty while the dialog is closed).
 * @param legendConfig - The project's legend overrides.
 * @param setLegendConfig - Store setter for the legend overrides.
 * @param t - Translation function.
 * @returns The legend for the page, the editor rows and marker images, and a
 *   callback that moves a layer's entry up or down.
 */
export function useLegendModel(
  layers: GeoLibreLayer[],
  legendConfig: LegendConfig,
  setLegendConfig: (config: LegendConfig) => void,
  t: TFunction,
) {
  const baseLegend = useMemo(
    () =>
      buildLegend(layers, {
        labels: {
          centroid: t("style.generator.typeCentroid"),
          "bounding-box": t("style.generator.typeBoundingBox"),
          "convex-hull": t("style.generator.typeConvexHull"),
          buffer: t("style.generator.typeBuffer"),
        },
      }),
    [layers, t],
  );
  const legend = useMemo(
    () => applyLegendConfig(baseLegend, legendConfig),
    [baseLegend, legendConfig],
  );
  const editorRows = useMemo(
    () => legendEditorRows(baseLegend, legendConfig),
    [baseLegend, legendConfig],
  );

  // Custom SVG markers must be drawn into legend swatches, but drawLayout is
  // synchronous while decoding an SVG is not, so preload them here (keyed by the
  // swatch marker's svg string) and hand drawLayout the ready images -- like the
  // captured map image. The key is a JSON array of the sorted sources: it
  // round-trips losslessly (SVG markup and URLs contain spaces/newlines) and,
  // being stable, avoids reloading on unrelated legend edits (labels, hidden
  // flags).
  const markerSvgKey = useMemo(() => {
    const sources = new Set<string>();
    for (const entry of baseLegend) {
      for (const sw of entry.swatches) {
        if (sw.marker?.shape === "custom" && sw.marker.svg) sources.add(sw.marker.svg);
      }
    }
    return JSON.stringify(Array.from(sources).sort());
  }, [baseLegend]);
  // A decoded-image cache derived from the legend, not composer state.
  const [markerIcons, setMarkerIcons] = useState<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    const sources = JSON.parse(markerSvgKey) as string[];
    if (sources.length === 0) {
      setMarkerIcons((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let cancelled = false;
    void Promise.all(
      sources.map(async (src) => [src, await loadMarkerSvgImage(src)] as const),
    ).then((pairs) => {
      if (cancelled) return;
      const next = new Map<string, HTMLImageElement>();
      for (const [src, img] of pairs) if (img) next.set(src, img);
      setMarkerIcons(next);
    });
    return () => {
      cancelled = true;
    };
  }, [markerSvgKey]);
  const entryIdsInOrder = useMemo(
    () => editorRows.filter((r) => r.kind === "entry").map((r) => r.layerId),
    [editorRows],
  );

  const moveEntry = useCallback(
    (layerId: string, direction: "up" | "down") => {
      setLegendConfig(reorderLegendEntry(legendConfig, entryIdsInOrder, layerId, direction));
    },
    [legendConfig, entryIdsInOrder, setLegendConfig],
  );

  return { legend, editorRows, markerIcons, entryIdsInOrder, moveEntry };
}
