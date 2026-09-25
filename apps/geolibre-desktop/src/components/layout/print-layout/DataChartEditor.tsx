import { useTranslation } from "react-i18next";
import type { GeoLibreLayer } from "@geolibre/core";
import { Input, Label, Select } from "@geolibre/ui";
import type { BodyCorner } from "../../../lib/print-layout";
import type { ChartBlockType, PageFilterMode } from "../../../lib/print-data-blocks";
import type { BarAggregation } from "../../../lib/attribute-charts";
import type { LayoutEditorProps } from "./state";
import type { DataBlocks } from "./useDataBlocks";

interface DataChartEditorProps extends LayoutEditorProps {
  /** Layers with loaded features: the ones a data block can use. */
  atlasLayers: GeoLibreLayer[];
  blocks: DataBlocks;
}

/** The chart block's settings (GH #1324). */
export function DataChartEditor({ layout, dispatch, atlasLayers, blocks }: DataChartEditorProps) {
  const { t } = useTranslation();
  const { chartLayerId, chartTitle, chartType, chartAggregation, chartPosition, chartPageFilter } =
    layout;
  const {
    chartLayer,
    chartCategoryOptions,
    chartNumericFields,
    effectiveCategoryField,
    effectiveValueField,
    chartNeedsValueField,
    displayDataBlocks,
  } = blocks;
  const set = (patch: Partial<typeof layout>) => dispatch({ type: "setLayout", patch });
  return (
    <div className="space-y-3 rounded-md border p-3">
      {atlasLayers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("printLayout.atlas.noLayers")}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="dc-layer">{t("printLayout.dataBlocks.layer")}</Label>
            <Select
              id="dc-layer"
              value={chartLayerId}
              onChange={(e) => dispatch({ type: "selectChartLayer", layerId: e.target.value })}
            >
              {atlasLayers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dc-type">{t("printLayout.dataChart.type")}</Label>
              <Select
                id="dc-type"
                value={chartType}
                onChange={(e) => set({ chartType: e.target.value as ChartBlockType })}
              >
                <option value="bar">{t("printLayout.dataChart.typeBar")}</option>
                <option value="pie">{t("printLayout.dataChart.typePie")}</option>
                <option value="line">{t("printLayout.dataChart.typeLine")}</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dc-position">{t("printLayout.dataBlocks.position")}</Label>
              <Select
                id="dc-position"
                value={chartPosition}
                onChange={(e) => set({ chartPosition: e.target.value as BodyCorner })}
              >
                <option value="top-left">{t("printLayout.position.topLeft")}</option>
                <option value="top-right">{t("printLayout.position.topRight")}</option>
                <option value="bottom-left">{t("printLayout.position.bottomLeft")}</option>
                <option value="bottom-right">{t("printLayout.position.bottomRight")}</option>
              </Select>
            </div>
          </div>
          {chartType !== "line" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dc-category">{t("printLayout.dataChart.categoryField")}</Label>
                <Select
                  id="dc-category"
                  value={effectiveCategoryField}
                  onChange={(e) => set({ chartCategoryField: e.target.value })}
                >
                  {chartCategoryOptions.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dc-aggregation">{t("printLayout.dataChart.aggregation")}</Label>
                <Select
                  id="dc-aggregation"
                  value={chartAggregation}
                  onChange={(e) => set({ chartAggregation: e.target.value as BarAggregation })}
                >
                  <option value="count">{t("printLayout.dataChart.aggCount")}</option>
                  <option value="sum">{t("printLayout.dataChart.aggSum")}</option>
                  <option value="mean">{t("printLayout.dataChart.aggMean")}</option>
                </Select>
              </div>
            </div>
          )}
          {chartNeedsValueField && (
            <div className="space-y-1.5">
              <Label htmlFor="dc-value">{t("printLayout.dataChart.valueField")}</Label>
              <Select
                id="dc-value"
                value={effectiveValueField}
                disabled={chartNumericFields.length === 0}
                onChange={(e) => set({ chartValueField: e.target.value })}
              >
                {chartNumericFields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
              {chartNumericFields.length === 0 && (
                <p className="text-xs text-destructive">
                  {t("printLayout.dataChart.noNumericFields")}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="dc-title">{t("printLayout.dataBlocks.titleLabel")}</Label>
            <Input
              id="dc-title"
              value={chartTitle}
              placeholder={chartLayer?.name ?? ""}
              onChange={(e) => set({ chartTitle: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dc-filter-page">{t("printLayout.dataBlocks.pageFilter")}</Label>
            <Select
              id="dc-filter-page"
              value={chartPageFilter}
              onChange={(e) => set({ chartPageFilter: e.target.value as PageFilterMode })}
            >
              <option value="all">{t("printLayout.dataBlocks.filterAll")}</option>
              <option value="contained">{t("printLayout.dataBlocks.filterContained")}</option>
              <option value="intersecting">{t("printLayout.dataBlocks.filterIntersecting")}</option>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("printLayout.dataBlocks.filterToPageHint")}
          </p>
          {!displayDataBlocks.dataChart && (
            <p className="text-xs text-muted-foreground">{t("printLayout.dataChart.noData")}</p>
          )}
        </>
      )}
    </div>
  );
}
