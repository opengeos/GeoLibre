import { useTranslation } from "react-i18next";
import type { GeoLibreLayer } from "@geolibre/core";
import { Input, Label, Select } from "@geolibre/ui";
import type { BodyCorner } from "../../../lib/print-layout";
import {
  DEFAULT_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  type PageFilterMode,
} from "../../../lib/print-data-blocks";
import { ToggleField } from "./ToggleField";
import type { LayoutEditorProps } from "./state";
import type { DataBlocks } from "./useDataBlocks";

interface DataTableEditorProps extends LayoutEditorProps {
  /** Layers with loaded features: the ones a data block can use. */
  atlasLayers: GeoLibreLayer[];
  blocks: DataBlocks;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
}

/** The attribute-table block's settings (GH #1324). */
export function DataTableEditor({
  layout,
  dispatch,
  atlasLayers,
  blocks,
  atlasEnabled,
}: DataTableEditorProps) {
  const { t } = useTranslation();
  const {
    tableLayerId,
    tableTitle,
    tableSortField,
    tableSortDesc,
    tableMaxRows,
    tableFitRows,
    tablePosition,
    tablePageFilter,
    tableFilterToAtlasFeature,
  } = layout;
  const { tableLayer, tableFields, effectiveTableColumns, tableUsesAtlasLayer, displayDataBlocks } =
    blocks;
  const set = (patch: Partial<typeof layout>) => dispatch({ type: "setLayout", patch });
  return (
    <div className="space-y-3 rounded-md border p-3">
      {atlasLayers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("printLayout.atlas.noLayers")}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="dt-layer">{t("printLayout.dataBlocks.layer")}</Label>
            <Select
              id="dt-layer"
              value={tableLayerId}
              onChange={(e) => dispatch({ type: "selectTableLayer", layerId: e.target.value })}
            >
              {atlasLayers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dt-title">{t("printLayout.dataBlocks.titleLabel")}</Label>
            <Input
              id="dt-title"
              value={tableTitle}
              placeholder={tableLayer?.name ?? ""}
              onChange={(e) => set({ tableTitle: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("printLayout.dataTable.columns")}</Label>
            <div className="max-h-40 space-y-1 overflow-auto rounded-md border p-2">
              {tableFields.map((f) => (
                <label key={f} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={effectiveTableColumns.includes(f)}
                    onChange={(e) => {
                      const next = new Set(effectiveTableColumns);
                      if (e.target.checked) next.add(f);
                      else next.delete(f);
                      // Normalize to the layer's field order so the
                      // printed column order is stable.
                      set({ tableColumns: tableFields.filter((c) => next.has(c)) });
                    }}
                  />
                  {f}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("printLayout.dataTable.columnsHint", {
                count: DEFAULT_TABLE_COLUMNS,
              })}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dt-sort">{t("printLayout.atlas.sortField")}</Label>
              <Select
                id="dt-sort"
                value={tableSortField}
                onChange={(e) => set({ tableSortField: e.target.value })}
              >
                <option value="">{t("printLayout.atlas.sortNone")}</option>
                {tableFields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dt-sort-dir">{t("printLayout.atlas.sortOrder")}</Label>
              <Select
                id="dt-sort-dir"
                value={tableSortDesc ? "desc" : "asc"}
                disabled={!tableSortField}
                onChange={(e) => set({ tableSortDesc: e.target.value === "desc" })}
              >
                <option value="asc">{t("printLayout.atlas.sortAsc")}</option>
                <option value="desc">{t("printLayout.atlas.sortDesc")}</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dt-max-rows">{t("printLayout.dataTable.maxRows")}</Label>
              <Input
                id="dt-max-rows"
                type="number"
                min={1}
                max={MAX_TABLE_ROWS}
                value={tableMaxRows}
                disabled={tableFitRows}
                onChange={(e) =>
                  set({
                    tableMaxRows: Math.max(
                      1,
                      Math.min(MAX_TABLE_ROWS, Number(e.target.value) || 1),
                    ),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dt-position">{t("printLayout.dataBlocks.position")}</Label>
              <Select
                id="dt-position"
                value={tablePosition}
                onChange={(e) => set({ tablePosition: e.target.value as BodyCorner })}
              >
                <option value="top-left">{t("printLayout.position.topLeft")}</option>
                <option value="top-right">{t("printLayout.position.topRight")}</option>
                <option value="bottom-left">{t("printLayout.position.bottomLeft")}</option>
                <option value="bottom-right">{t("printLayout.position.bottomRight")}</option>
              </Select>
            </div>
          </div>
          <ToggleField
            id="dt-fit-rows"
            label={t("printLayout.dataTable.fitRows")}
            checked={tableFitRows}
            onChange={(next) => set({ tableFitRows: next })}
          />
          <div className="space-y-1.5">
            <Label htmlFor="dt-filter-page">{t("printLayout.dataBlocks.pageFilter")}</Label>
            <Select
              id="dt-filter-page"
              value={tablePageFilter}
              disabled={tableFilterToAtlasFeature && tableUsesAtlasLayer}
              onChange={(e) => set({ tablePageFilter: e.target.value as PageFilterMode })}
            >
              <option value="all">{t("printLayout.dataBlocks.filterAll")}</option>
              <option value="contained">{t("printLayout.dataBlocks.filterContained")}</option>
              <option value="intersecting">{t("printLayout.dataBlocks.filterIntersecting")}</option>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("printLayout.dataBlocks.filterToPageHint")}
          </p>
          {atlasEnabled && (
            <>
              <ToggleField
                id="dt-filter-atlas-feature"
                label={t("printLayout.dataBlocks.filterToAtlasFeature")}
                checked={tableFilterToAtlasFeature}
                disabled={!tableUsesAtlasLayer}
                onChange={(next) => set({ tableFilterToAtlasFeature: next })}
              />
              <p className="text-xs text-muted-foreground">
                {t("printLayout.dataBlocks.filterToAtlasFeatureHint")}
              </p>
            </>
          )}
          {!displayDataBlocks.dataTable && (
            <p className="text-xs text-muted-foreground">{t("printLayout.dataTable.noRows")}</p>
          )}
        </>
      )}
    </div>
  );
}
