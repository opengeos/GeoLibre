import type { MapCanvasIdentifyAllLabels } from "@geolibre/map";
import { useMemo } from "react";
import type { TFunction } from "i18next";

/**
 * Build the translated strings the map's "identify all" popup renders.
 *
 * Args:
 *   t: The active translation function.
 *
 * Returns:
 *   The popup's labels, with the count- and index-dependent ones as functions.
 */
export function identifyAllLabels(t: TFunction): MapCanvasIdentifyAllLabels {
  return {
    title: (count: number) => t("map.identifyAll.title", { count }),
    resultCount: (count: number) => t("map.identifyAll.resultCount", { count }),
    featureFallback: (index: number) => t("map.identifyAll.featureFallback", { index }),
    pixel: t("map.identifyAll.pixel"),
    expandAll: t("map.identifyAll.expandAll"),
    collapseAll: t("map.identifyAll.collapseAll"),
    loadingTitle: t("map.identifyAll.loadingTitle"),
    loading: t("map.identifyAll.loading"),
    errorLabel: t("map.identifyAll.errorLabel"),
    error: t("map.identifyAll.error"),
    noData: t("map.identifyAll.noData"),
    pixelReadFailed: t("map.identifyAll.pixelReadFailed"),
    pixelValue: t("map.identifyAll.pixelValue"),
    pixelBand: (index: number) => t("map.identifyAll.pixelBand", { index }),
    wmsFailed: t("map.identifyAll.wmsFailed"),
    wmsNotQueryable: t("map.identifyAll.wmsNotQueryable"),
    editGeometry: t("map.identifyAll.editGeometry"),
    editAttributes: t("map.identifyAll.editAttributes"),
    photo: {
      photo: t("map.identifyAll.photo"),
      noPreview: t("map.identifyAll.photoNoPreview"),
      viewFullResolution: t("map.identifyAll.photoViewFullResolution"),
      viewFullscreen: t("map.identifyAll.photoViewFullscreen"),
      close: t("map.identifyAll.photoClose"),
    },
    compare: {
      comparedWith: (title: string | null) =>
        title ? t("map.compare.comparedWith", { title }) : t("map.compare.comparedWithPinned"),
      pinnedValue: (value: string) => t("map.compare.pinnedValue", { value }),
      noValue: t("map.compare.noValue"),
      identical: t("map.compare.identical"),
      moreDifferences: (count: number) => t("map.compare.moreDifferences", { count }),
      sameFields: (count: number) => t("map.compare.sameFields", { count }),
    },
  };
}

/**
 * The "identify all" popup labels, rebuilt only when the language changes so
 * every map engine receives a stable object between renders.
 *
 * Args:
 *   t: The active translation function.
 *
 * Returns:
 *   The memoized popup labels.
 */
export function useIdentifyAllLabels(t: TFunction): MapCanvasIdentifyAllLabels {
  return useMemo(() => identifyAllLabels(t), [t]);
}
