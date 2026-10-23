import { useTranslation } from "react-i18next";
import type { PrintLayoutConfig } from "@geolibre/core";
import { ToggleField } from "./ToggleField";
import type { LayoutEditorProps } from "./state";

/** The layout fields that switch a page element on or off. */
type ElementField = {
  [K in keyof PrintLayoutConfig]: PrintLayoutConfig[K] extends boolean ? K : never;
}[keyof PrintLayoutConfig];

/** The "Map elements" checklist: which elements the page shows. */
export function ElementToggles({ layout, dispatch }: LayoutEditorProps) {
  const { t } = useTranslation();
  const toggle = (field: ElementField) => (next: boolean) =>
    dispatch({ type: "setLayout", patch: { [field]: next } });
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("printLayout.mapElements")}</p>
      <ToggleField
        id="el-title"
        label={t("printLayout.element.title")}
        checked={layout.showTitle}
        onChange={toggle("showTitle")}
      />
      <ToggleField
        id="el-subtitle"
        label={t("printLayout.element.subtitle")}
        checked={layout.showSubtitle}
        onChange={toggle("showSubtitle")}
      />
      <ToggleField
        id="el-legend"
        label={t("printLayout.element.legend")}
        checked={layout.showLegend}
        onChange={toggle("showLegend")}
      />
      <ToggleField
        id="el-scale"
        label={t("printLayout.element.scaleBar")}
        checked={layout.showScaleBar}
        onChange={toggle("showScaleBar")}
      />
      <ToggleField
        id="el-north"
        label={t("printLayout.element.northArrow")}
        checked={layout.showNorthArrow}
        onChange={toggle("showNorthArrow")}
      />
      {layout.showScaleBar && layout.showNorthArrow && (
        <ToggleField
          id="el-nav-group"
          label={t("printLayout.element.groupNavigation")}
          checked={layout.navigationGrouped}
          onChange={toggle("navigationGrouped")}
        />
      )}
      <ToggleField
        id="el-date"
        label={t("printLayout.element.date")}
        checked={layout.showDate}
        onChange={toggle("showDate")}
      />
      <ToggleField
        id="el-attribution"
        label={t("printLayout.element.attribution")}
        checked={layout.showAttribution}
        onChange={toggle("showAttribution")}
      />
      <ToggleField
        id="el-footer"
        label={t("printLayout.element.footer")}
        checked={layout.showFooter}
        onChange={toggle("showFooter")}
      />
      <ToggleField
        id="el-border"
        label={t("printLayout.element.pageBorder")}
        checked={layout.showPageBorder}
        onChange={toggle("showPageBorder")}
      />
      <ToggleField
        id="el-info-block"
        label={t("printLayout.element.infoBlock")}
        checked={layout.showInfoBlock}
        onChange={toggle("showInfoBlock")}
      />
      <ToggleField
        id="el-colorbar"
        label={t("printLayout.element.colorbar")}
        checked={layout.showColorbar}
        onChange={toggle("showColorbar")}
      />
      <ToggleField
        id="el-custom-legend"
        label={t("printLayout.element.customLegend")}
        checked={layout.showCustomLegend}
        onChange={toggle("showCustomLegend")}
      />
      <ToggleField
        id="el-data-table"
        label={t("printLayout.element.dataTable")}
        checked={layout.showDataTable}
        onChange={toggle("showDataTable")}
      />
      <ToggleField
        id="el-data-chart"
        label={t("printLayout.element.dataChart")}
        checked={layout.showDataChart}
        onChange={toggle("showDataChart")}
      />
    </div>
  );
}
