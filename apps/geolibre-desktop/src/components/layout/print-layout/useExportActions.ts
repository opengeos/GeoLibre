import { useCallback, type Dispatch } from "react";
import type { TFunction } from "i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import type { LayoutOptions } from "../../../lib/print-layout";
import { rowForAtlasFeature } from "../../../lib/print-data-blocks";
import {
  copyLayoutToClipboard,
  exportAtlasPdf,
  exportAtlasPngZip,
  exportLayoutPdf,
  exportLayoutPng,
  exportLayoutSvg,
  type CapturedMap,
} from "../../../lib/print-layout-export";
import {
  atlasEntryName,
  stripAtlasTokens,
  substituteAtlasTokens,
  type AtlasTokenContext,
} from "../../../lib/print-atlas";
import type { PrintLayoutAction } from "./state";
import type { AtlasSeries } from "./useAtlasSeries";
import type { DataBlocks } from "./useDataBlocks";
import type { useAtlasCapture } from "./useAtlasDrive";

/**
 * A safe export file base name from a title.
 *
 * @param name - The page title (or project name).
 * @returns The name with punctuation stripped and spaces hyphenated, or
 *   "map-layout" when nothing is left.
 */
export function sanitizeFilename(name: string): string {
  // Keep letters and digits from any script (\p{L}\p{N}) so non-Latin project
  // names are not stripped to the fallback.
  const cleaned = name
    .trim()
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .replace(/\s+/g, "-");
  return cleaned || "map-layout";
}

interface UseExportActionsArgs {
  layout: PrintLayoutConfig;
  projectName: string | null | undefined;
  captured: CapturedMap | null;
  exporting: boolean;
  atlasBusy: boolean;
  options: LayoutOptions;
  displayOptions: LayoutOptions;
  atlas: AtlasSeries;
  blocks: DataBlocks;
  captureAtlasPage: ReturnType<typeof useAtlasCapture>["captureAtlasPage"];
  copiedTimeoutRef: React.RefObject<number | null>;
  onOpenChange: (open: boolean) => void;
  dispatch: Dispatch<PrintLayoutAction>;
  t: TFunction;
}

/**
 * The composer's output actions: copy to the clipboard, export one page
 * (PNG / PDF / SVG), export the whole atlas, and closing (which is refused
 * while an export or atlas drive is running).
 *
 * @returns The action handlers.
 */
export function useExportActions({
  layout,
  projectName,
  captured,
  exporting,
  atlasBusy,
  options,
  displayOptions,
  atlas,
  blocks,
  captureAtlasPage,
  copiedTimeoutRef,
  onOpenChange,
  dispatch,
  t,
}: UseExportActionsArgs) {
  const setError = (error: string | null) => dispatch({ type: "setUi", patch: { error } });

  // Copy the composed layout to the clipboard as a PNG, so it can be pasted
  // straight into a document without saving a file first (GH #773).
  const handleCopy = async () => {
    if (!captured) {
      setError(t("printLayout.errors.captureFirst"));
      return;
    }
    dispatch({ type: "setUi", patch: { exporting: true, error: null } });
    try {
      await copyLayoutToClipboard(displayOptions);
      dispatch({ type: "setUi", patch: { copied: true } });
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      copiedTimeoutRef.current = window.setTimeout(() => {
        dispatch({ type: "setUi", patch: { copied: false } });
        copiedTimeoutRef.current = null;
      }, 2000);
    } catch {
      setError(t("printLayout.errors.clipboardFailed"));
    } finally {
      dispatch({ type: "setUi", patch: { exporting: false } });
    }
  };

  const handleExport = async (kind: "png" | "pdf" | "svg") => {
    if (!captured) {
      setError(t("printLayout.errors.captureFirst"));
      return;
    }
    dispatch({ type: "setUi", patch: { exporting: true, error: null } });
    try {
      const base = sanitizeFilename(displayOptions.title || projectName || "map-layout");
      if (kind === "png") {
        await exportLayoutPng(displayOptions, `${base}.png`);
      } else if (kind === "svg") {
        await exportLayoutSvg(displayOptions, `${base}.svg`);
      } else {
        await exportLayoutPdf(displayOptions, `${base}.pdf`);
      }
    } catch {
      setError(t("printLayout.errors.exportFailed", { format: kind.toUpperCase() }));
    } finally {
      dispatch({ type: "setUi", patch: { exporting: false } });
    }
  };

  // Export the whole atlas: iterate the pages, drive the map to each feature,
  // capture, resolve tokens, and hand the per-page layout options to the
  // multi-page PDF or PNG-zip writer (GH #1291). The page list and the raw
  // option templates are frozen at click time so edits made while the loop
  // runs cannot produce a mixed document.
  const handleAtlasExport = async (kind: "pdf" | "zip") => {
    const { atlasActive, atlasConfigBlocked, atlasPages } = atlas;
    const {
      buildBlocksFromRows,
      tableUsesAtlasLayer,
      tableAllRows,
      rowsForBlock,
      tableFeatureInfos,
      chartFeatureInfos,
      chartAllRows,
    } = blocks;
    const {
      tableFilterToAtlasFeature,
      tablePageFilter,
      chartPageFilter,
      title,
      atlasFilenamePattern,
    } = layout;
    if (!atlasActive || atlasBusy || atlasConfigBlocked) return;
    const pages = atlasPages;
    const total = pages.length;
    dispatch({ type: "setUi", patch: { exporting: true, atlasBusy: true, error: null } });
    try {
      const ctxFor = (i: number): AtlasTokenContext => ({
        name: pages[i].name,
        pageNumber: i + 1,
        total,
        properties: pages[i].properties,
      });
      const source = {
        total,
        onProgress: (current: number, totalPages: number) =>
          dispatch({ type: "setUi", patch: { atlasProgress: { current, total: totalPages } } }),
        optionsForPage: async (i: number): Promise<LayoutOptions> => {
          const { cap, viewBounds, mapFit: atlasMapFit } = await captureAtlasPage(pages[i]);
          // Mirror progress into the dialog preview as pages are produced.
          dispatch({ type: "atlasPageCaptured", captured: cap, index: i, bounds: viewBounds });
          const ctx = ctxFor(i);
          return {
            ...options,
            // Each page's table/chart re-filters to the extent the page's
            // capture actually shows (not just the nominal feature bounds).
            ...buildBlocksFromRows(
              tableFilterToAtlasFeature && tableUsesAtlasLayer
                ? rowForAtlasFeature(tableAllRows, pages[i].sourceIndex)
                : rowsForBlock(tableFeatureInfos, tableAllRows, tablePageFilter, viewBounds),
              rowsForBlock(chartFeatureInfos, chartAllRows, chartPageFilter, viewBounds),
            ),
            title: substituteAtlasTokens(options.title, ctx),
            subtitle: substituteAtlasTokens(options.subtitle, ctx),
            footerText: substituteAtlasTokens(options.footerText, ctx),
            metersPerPixel: cap.metersPerPixel,
            mapPixelRatio: cap.pixelRatio,
            bearingDeg: cap.bearingDeg,
            mapImage: cap.image,
            mapImageWidth: cap.width,
            mapImageHeight: cap.height,
            mapFit: atlasMapFit,
          };
        },
      };
      // The combined file's name cannot carry any single page's tokens.
      const base = sanitizeFilename(stripAtlasTokens(title) || projectName || "atlas");
      if (kind === "pdf") {
        await exportAtlasPdf(source, `${base}-atlas.pdf`);
      } else {
        await exportAtlasPngZip(
          source,
          (i) => atlasEntryName(atlasFilenamePattern, ctxFor(i)),
          `${base}-atlas.zip`,
        );
      }
    } catch {
      setError(
        t("printLayout.errors.exportFailed", {
          format: kind === "pdf" ? "PDF" : "ZIP",
        }),
      );
    } finally {
      dispatch({
        type: "setUi",
        patch: { exporting: false, atlasBusy: false, atlasProgress: null },
      });
    }
  };

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && (atlasBusy || exporting)) return;
      onOpenChange(nextOpen);
    },
    [atlasBusy, exporting, onOpenChange],
  );

  return { handleCopy, handleExport, handleAtlasExport, handleDialogOpenChange };
}
