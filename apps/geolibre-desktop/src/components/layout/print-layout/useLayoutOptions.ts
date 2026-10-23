import { useMemo } from "react";
import type { TFunction } from "i18next";
import { getVectorColorRamp, type LegendConfig, type PrintLayoutConfig } from "@geolibre/core";
import {
  computeScaleRatio,
  resolvePageSize,
  type CustomSize,
  type LayoutOptions,
} from "../../../lib/print-layout";
import type { CapturedMap } from "../../../lib/print-layout-export";

interface UseLayoutOptionsArgs {
  layout: PrintLayoutConfig;
  projectName: string | null | undefined;
  scaleUnit: LayoutOptions["scaleUnit"];
  legend: LayoutOptions["legend"];
  legendConfig: LegendConfig;
  markerIcons: LayoutOptions["markerIcons"];
  captured: CapturedMap | null;
  mapFit: "cover" | "contain";
  t: TFunction;
}

/**
 * The page the composer draws, as the `LayoutOptions` the export pipeline
 * takes: the persisted layout resolved against the project (blank title and
 * date follow the project name and today), the legend, and the captured map.
 *
 * @returns The options, whether the page is physical paper (only that carries
 *   a true cartographic scale), and the current 1:N scale of the capture.
 */
export function useLayoutOptions({
  layout,
  projectName,
  scaleUnit,
  legend,
  legendConfig,
  markerIcons,
  captured,
  mapFit,
  t,
}: UseLayoutOptionsArgs) {
  const {
    title,
    subtitle,
    paperSize,
    orientation,
    customWidth,
    customHeight,
    customUnit,
    showTitle,
    showSubtitle,
    titlePlacement,
    titleAlign,
    showLegend,
    showScaleBar,
    showNorthArrow,
    navigationGrouped,
    showFooter,
    footerText,
    showDate,
    dateText,
    showAttribution,
    pageMargin,
    showPageBorder,
    pageBorderColor,
    pageBorderWidth,
    mapBorderColor,
    mapBorderWidth,
    mapBackground,
    showColorbar,
    colorbarRamp,
    colorbarMin,
    colorbarMax,
    colorbarLabel,
    colorbarOrientation,
    colorbarPosition,
    colorbarLength,
    showCustomLegend,
    customLegendTitle,
    customLegendEntries,
    customLegendPosition,
    showInfoBlock,
    author,
    projectNumber,
    crs,
    revision,
  } = layout;
  const isCustom = paperSize === "custom";
  const customSize = useMemo<CustomSize | null>(
    () => (isCustom ? { width: customWidth, height: customHeight, unit: customUnit } : null),
    [isCustom, customWidth, customHeight, customUnit],
  );

  // Blank title / date follow the project rather than being written into the
  // controls: seeding them on open would edit the saved layout (and mark the
  // project dirty) just because the composer was opened, and a title seeded
  // once would go stale when the project is renamed.
  const resolvedTitle = title.trim() ? title : (projectName ?? "").trim();
  const resolvedDateText = dateText.trim() ? dateText : new Date().toLocaleDateString();

  const options = useMemo<LayoutOptions>(
    () => ({
      title: resolvedTitle,
      subtitle,
      paperSize,
      orientation,
      customSize,
      showTitle,
      showSubtitle,
      titlePlacement,
      titleAlign,
      showLegend,
      showScaleBar,
      scaleUnit,
      showNorthArrow,
      navigationGrouped,
      showFooter,
      footerText,
      showDate,
      dateText: resolvedDateText,
      showAttribution,
      pageMargin,
      showPageBorder,
      pageBorderColor,
      pageBorderWidth,
      mapBorderColor,
      mapBorderWidth,
      mapBackground,
      colorbar: showColorbar
        ? {
            colors: getVectorColorRamp(colorbarRamp).colors,
            // Treat a blank/invalid field as 0 explicitly (Number("abc") is NaN,
            // which would otherwise flow into a degenerate gradient).
            min: Number.isFinite(Number(colorbarMin)) ? Number(colorbarMin) : 0,
            max: Number.isFinite(Number(colorbarMax)) ? Number(colorbarMax) : 0,
            label: colorbarLabel,
            orientation: colorbarOrientation,
            position: colorbarPosition,
            lengthPct: colorbarLength,
          }
        : null,
      customLegend: showCustomLegend
        ? {
            title: customLegendTitle,
            entries: customLegendEntries.map((e) => ({
              label: e.label,
              color: e.color,
            })),
            position: customLegendPosition,
          }
        : null,
      showInfoBlock,
      author,
      projectNumber,
      crs,
      revision,
      infoLabels: {
        author: t("printLayout.info.author"),
        project: t("printLayout.info.project"),
        crs: t("printLayout.info.crs"),
        scale: t("printLayout.info.scale"),
        revision: t("printLayout.info.revision"),
      },
      legend,
      legendTitle: legendConfig.title,
      legendGroupByLayer: legendConfig.groupByLayer,
      legendFormatNote: (count: number) => t("printLayout.legend.moreItems", { count }),
      markerIcons,
      metersPerPixel: captured?.metersPerPixel ?? 0,
      mapPixelRatio: captured?.pixelRatio ?? 1,
      bearingDeg: captured?.bearingDeg ?? 0,
      mapImage: captured?.image ?? null,
      mapImageWidth: captured?.width ?? 0,
      mapImageHeight: captured?.height ?? 0,
      mapFit,
    }),
    [
      resolvedTitle,
      subtitle,
      paperSize,
      orientation,
      customSize,
      showTitle,
      showSubtitle,
      titlePlacement,
      titleAlign,
      showLegend,
      showScaleBar,
      scaleUnit,
      showNorthArrow,
      navigationGrouped,
      showFooter,
      footerText,
      showDate,
      resolvedDateText,
      showAttribution,
      pageMargin,
      showPageBorder,
      pageBorderColor,
      pageBorderWidth,
      mapBorderColor,
      mapBorderWidth,
      mapBackground,
      showColorbar,
      colorbarRamp,
      colorbarMin,
      colorbarMax,
      colorbarLabel,
      colorbarOrientation,
      colorbarPosition,
      colorbarLength,
      showCustomLegend,
      customLegendTitle,
      customLegendEntries,
      customLegendPosition,
      showInfoBlock,
      author,
      projectNumber,
      crs,
      revision,
      legend,
      legendConfig,
      markerIcons,
      captured,
      mapFit,
      t,
    ],
  );

  // Current representative fraction (1:N), and whether scale is meaningful for
  // the chosen page (only physical paper carries a true cartographic scale).
  const isMmPage = resolvePageSize(options).unit === "mm";
  const currentRatio = useMemo(() => computeScaleRatio(options), [options]);

  return { options, isMmPage, currentRatio };
}
