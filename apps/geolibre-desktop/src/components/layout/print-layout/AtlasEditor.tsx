import { useTranslation } from "react-i18next";
import { Input, Label, Select } from "@geolibre/ui";
import { MAX_LINE_ATLAS_PAGES } from "../../../lib/print-atlas";
import { ToggleField } from "./ToggleField";
import type { LayoutEditorProps } from "./state";
import type { AtlasSeries } from "./useAtlasSeries";

interface AtlasEditorProps extends LayoutEditorProps {
  atlas: AtlasSeries;
  /** The atlas setting, AND-ed with the renderer being able to drive it. */
  atlasEnabled: boolean;
  atlasRendererSupported: boolean;
  atlasBusy: boolean;
  atlasScaleNotice: string | null;
  isMmPage: boolean;
}

/** Atlas / map series: one page per coverage feature (GH #1291). */
export function AtlasEditor({
  layout,
  dispatch,
  atlas,
  atlasEnabled,
  atlasRendererSupported,
  atlasBusy,
  atlasScaleNotice,
  isMmPage,
}: AtlasEditorProps) {
  const { t } = useTranslation();
  const {
    atlasLayerId,
    atlasCoverage,
    atlasSegmentKm,
    atlasNameField,
    atlasExtentMode,
    atlasMarginPct,
    atlasMaskEnabled,
    atlasScale,
    atlasSortField,
    atlasSortDescending,
    atlasFilter,
    atlasFilenamePattern,
  } = layout;
  const {
    atlasLayers,
    atlasFields,
    deferredAtlasFilter,
    atlasFilterPredicate,
    atlasLineFeatureCount,
    atlasPageCount,
    atlasMaskAvailable,
    atlasScaleValid,
    atlasSegmentValid,
  } = atlas;
  const set = (patch: Partial<typeof layout>) => dispatch({ type: "setLayout", patch });
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("printLayout.atlas.section")}</p>
      <ToggleField
        id="atlas-enabled"
        label={t("printLayout.atlas.enable")}
        checked={atlasEnabled}
        disabled={atlasBusy || !atlasRendererSupported}
        onChange={(next) => dispatch({ type: "setAtlasEnabled", enabled: next })}
      />
      {atlasEnabled && (
        <div className="space-y-3 rounded-md border p-3">
          {atlasLayers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("printLayout.atlas.noLayers")}</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="atlas-layer">{t("printLayout.atlas.coverageLayer")}</Label>
                <Select
                  id="atlas-layer"
                  value={atlasLayerId}
                  disabled={atlasBusy}
                  onChange={(e) => dispatch({ type: "selectAtlasLayer", layerId: e.target.value })}
                >
                  {atlasLayers.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </div>
              {/* Coverage strategy: per feature, or fixed-length
                  stretches along the layer's line features. */}
              <div className="space-y-1.5">
                <Label htmlFor="atlas-coverage">{t("printLayout.atlas.coverage")}</Label>
                <Select
                  id="atlas-coverage"
                  value={atlasCoverage}
                  disabled={atlasBusy}
                  onChange={(e) =>
                    dispatch({
                      type: "setAtlasCoverage",
                      coverage: e.target.value as "features" | "line",
                    })
                  }
                >
                  <option value="features">{t("printLayout.atlas.coveragePerFeature")}</option>
                  <option value="line">{t("printLayout.atlas.coverageAlongLine")}</option>
                </Select>
              </div>
              {atlasCoverage === "line" && (
                <div className="space-y-1.5">
                  <Label htmlFor="atlas-segment-km">{t("printLayout.atlas.segmentLength")}</Label>
                  <Input
                    id="atlas-segment-km"
                    inputMode="decimal"
                    disabled={atlasBusy}
                    value={atlasSegmentKm}
                    onChange={(e) =>
                      set({ atlasSegmentKm: e.target.value.replace(/[^0-9.]/g, "") })
                    }
                  />
                  {!atlasSegmentValid && (
                    <p className="text-xs text-destructive">
                      {t("printLayout.atlas.segmentRequired")}
                    </p>
                  )}
                  {atlasSegmentValid && atlasLineFeatureCount === 0 && (
                    <p className="text-xs text-destructive">
                      {t("printLayout.atlas.noLineFeatures")}
                    </p>
                  )}
                  {atlasSegmentValid && atlasPageCount >= MAX_LINE_ATLAS_PAGES && (
                    <p className="text-xs text-destructive">
                      {t("printLayout.atlas.segmentTruncated", {
                        count: MAX_LINE_ATLAS_PAGES,
                      })}
                    </p>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="atlas-name-field">{t("printLayout.atlas.nameField")}</Label>
                  <Select
                    id="atlas-name-field"
                    value={atlasNameField}
                    disabled={atlasBusy}
                    onChange={(e) => set({ atlasNameField: e.target.value })}
                  >
                    <option value="">{t("printLayout.atlas.nameFieldNone")}</option>
                    {atlasFields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="atlas-extent-mode">{t("printLayout.atlas.extentMode")}</Label>
                  <Select
                    id="atlas-extent-mode"
                    value={atlasExtentMode}
                    disabled={atlasBusy}
                    onChange={(e) => set({ atlasExtentMode: e.target.value as "margin" | "scale" })}
                  >
                    <option value="margin">{t("printLayout.atlas.extentMargin")}</option>
                    {isMmPage && (
                      <option value="scale">{t("printLayout.atlas.extentScale")}</option>
                    )}
                  </Select>
                </div>
              </div>
              {atlasExtentMode === "margin" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="atlas-margin">{t("printLayout.atlas.marginLabel")}</Label>
                  <Input
                    id="atlas-margin"
                    type="number"
                    disabled={atlasBusy}
                    min={0}
                    max={100}
                    value={atlasMarginPct}
                    onChange={(e) =>
                      set({
                        atlasMarginPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                      })
                    }
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="atlas-scale">{t("printLayout.atlas.scaleLabel")}</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">1:</span>
                    <Input
                      id="atlas-scale"
                      inputMode="numeric"
                      disabled={atlasBusy}
                      className="flex-1"
                      value={atlasScale}
                      onChange={(e) => set({ atlasScale: e.target.value.replace(/[^0-9]/g, "") })}
                    />
                  </div>
                  {!atlasScaleValid && (
                    <p className="text-xs text-destructive">
                      {t("printLayout.atlas.scaleRequired")}
                    </p>
                  )}
                  {atlasScaleValid && atlasScaleNotice && (
                    <p className="text-xs text-destructive">{atlasScaleNotice}</p>
                  )}
                </div>
              )}
              {atlasMaskAvailable && (
                <div className="space-y-1.5">
                  <ToggleField
                    id="atlas-mask-outside"
                    label={t("printLayout.atlas.maskOutside")}
                    checked={atlasMaskEnabled}
                    disabled={atlasBusy}
                    onChange={(next) => set({ atlasMaskEnabled: next })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("printLayout.atlas.maskOutsideHint")}
                  </p>
                </div>
              )}
              {/* Along-a-line pages follow the line's own chainage,
                  so ordering controls only apply per-feature mode. */}
              {atlasCoverage === "features" && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="atlas-sort">{t("printLayout.atlas.sortField")}</Label>
                    <Select
                      id="atlas-sort"
                      value={atlasSortField}
                      disabled={atlasBusy}
                      onChange={(e) => set({ atlasSortField: e.target.value })}
                    >
                      <option value="">{t("printLayout.atlas.sortNone")}</option>
                      {atlasFields.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="atlas-sort-dir">{t("printLayout.atlas.sortOrder")}</Label>
                    <Select
                      id="atlas-sort-dir"
                      value={atlasSortDescending ? "desc" : "asc"}
                      disabled={atlasBusy || !atlasSortField}
                      onChange={(e) => set({ atlasSortDescending: e.target.value === "desc" })}
                    >
                      <option value="asc">{t("printLayout.atlas.sortAsc")}</option>
                      <option value="desc">{t("printLayout.atlas.sortDesc")}</option>
                    </Select>
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="atlas-filter">{t("printLayout.atlas.filterLabel")}</Label>
                <Input
                  id="atlas-filter"
                  value={atlasFilter}
                  disabled={atlasBusy}
                  placeholder={t("printLayout.atlas.filterPlaceholder")}
                  onChange={(e) => set({ atlasFilter: e.target.value })}
                />
                {deferredAtlasFilter.trim() !== "" && !atlasFilterPredicate && (
                  <p className="text-xs text-destructive">{t("printLayout.atlas.filterError")}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="atlas-filename">{t("printLayout.atlas.filenamePattern")}</Label>
                <Input
                  id="atlas-filename"
                  value={atlasFilenamePattern}
                  disabled={atlasBusy}
                  onChange={(e) => set({ atlasFilenamePattern: e.target.value })}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {atlasPageCount > 0
                  ? t("printLayout.atlas.pages", {
                      count: atlasPageCount,
                    })
                  : t("printLayout.atlas.noPages")}
              </p>
              <p className="text-xs text-muted-foreground">{t("printLayout.atlas.tokensHint")}</p>
              {atlasCoverage === "line" && (
                <p className="text-xs text-muted-foreground">
                  {t("printLayout.atlas.alongLineHint")}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
