import {
  setBookmarkLabels,
  setTerrainMeasureBodyNames,
  setTerrainMeasureLabels,
  setViewStateLabels,
} from "@geolibre/plugins";
import type { TFunction } from "i18next";
import { useEffect } from "react";
import { PLANET_SWITCHER_LABEL_KEYS } from "../../lib/planet-labels";

/**
 * Pushes translated labels into plugin controls that cannot call `t()`.
 *
 * @param t - The shell's translation function; the labels re-push when it changes.
 */
export function useTranslatedPluginLabels(t: TFunction): void {
  // Push the translated bookmark labels into the framework-agnostic plugins
  // package (which can't call t() itself). Done here rather than in TopToolbar
  // so it still applies when the toolbar is hidden (e.g. `?maponly`), where the
  // BookmarkControl overlay is still present.
  useEffect(() => {
    setBookmarkLabels({
      captureStateLabel: t("bookmark.captureStateLabel"),
      captureStateTooltip: t("bookmark.captureStateTooltip"),
      exportLabel: t("bookmark.export"),
      exportSelectedLabel: t("bookmark.exportSelected"),
      exportAllLabel: t("bookmark.exportAll"),
      newFolderLabel: t("bookmark.newFolder"),
      defaultFolderName: t("bookmark.defaultFolderName"),
    });
    setViewStateLabels({ title: t("viewState.panelTitle") });
    setTerrainMeasureLabels({
      title: t("terrainMeasure.title"),
      surfaceDistance: t("terrainMeasure.surfaceDistance"),
      surfaceArea: t("terrainMeasure.surfaceArea"),
      elevationGainLoss: t("terrainMeasure.elevationGainLoss"),
      elevationRange: t("terrainMeasure.elevationRange"),
      meanSlope: t("terrainMeasure.meanSlope"),
      computing: t("terrainMeasure.computing"),
      partialData: t("terrainMeasure.partialData"),
      heading: t("terrainMeasure.heading"),
      finalHeading: t("terrainMeasure.finalHeading"),
      bodyNote: t("terrainMeasure.bodyNote"),
    });
    // The note names the body, so it uses the planet switcher's names rather
    // than the ellipsoid records' datum-qualified ones.
    setTerrainMeasureBodyNames(
      Object.fromEntries(
        Object.entries(PLANET_SWITCHER_LABEL_KEYS).map(([id, key]) => [id, t(key)]),
      ),
    );
  }, [t]);
}
