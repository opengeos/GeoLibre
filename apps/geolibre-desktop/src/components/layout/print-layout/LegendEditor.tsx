import { useTranslation } from "react-i18next";
import { DEFAULT_LEGEND_CONFIG, type LegendConfig } from "@geolibre/core";
import { Button, Input, Label, Separator } from "@geolibre/ui";
import { ArrowDown, ArrowUp, Eye, EyeOff, RotateCcw } from "lucide-react";
import {
  setLegendItemLabel,
  toggleLegendItemHidden,
  type legendEditorRows,
} from "../../../lib/print-layout-export";
import { ToggleField } from "./ToggleField";

interface LegendEditorProps {
  /** The project's legend overrides (shared with Controls -> Legend). */
  legendConfig: LegendConfig;
  setLegendConfig: (config: LegendConfig) => void;
  editorRows: ReturnType<typeof legendEditorRows>;
  entryIdsInOrder: string[];
  markerIcons: Map<string, HTMLImageElement>;
  moveEntry: (layerId: string, direction: "up" | "down") => void;
}

/**
 * The auto-built legend's settings: its title, grouping, and per-entry
 * labels, visibility and order. These edit the project's legend config (in
 * the store), not the print layout.
 */
export function LegendEditor({
  legendConfig,
  setLegendConfig,
  editorRows,
  entryIdsInOrder,
  markerIcons,
  moveEntry,
}: LegendEditorProps) {
  const { t } = useTranslation();
  return (
    <>
      <Separator />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("printLayout.legend.section")}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLegendConfig({ ...DEFAULT_LEGEND_CONFIG })}
          >
            <RotateCcw className="me-1.5 h-3.5 w-3.5" />
            {t("common.reset")}
          </Button>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="legend-title">{t("printLayout.legend.titleLabel")}</Label>
          <Input
            id="legend-title"
            value={legendConfig.title}
            placeholder={t("printLayout.legend.defaultTitle")}
            onChange={(e) =>
              setLegendConfig({
                ...legendConfig,
                title: e.target.value,
              })
            }
          />
        </div>
        <ToggleField
          id="legend-group"
          label={t("printLayout.legend.groupByLayer")}
          checked={legendConfig.groupByLayer}
          onChange={(next) => setLegendConfig({ ...legendConfig, groupByLayer: next })}
        />

        {editorRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("printLayout.legend.empty")}</p>
        ) : (
          <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-2">
            {editorRows.map((row) => {
              const entryIndex = entryIdsInOrder.indexOf(row.layerId);
              return (
                <div
                  key={row.key}
                  className={`flex items-center gap-1.5 ${
                    row.kind === "class" ? "ps-5" : ""
                  } ${row.hidden ? "opacity-50" : ""}`}
                >
                  {row.kind === "entry" ? (
                    <div className="flex flex-col">
                      <button
                        type="button"
                        aria-label={t("printLayout.legend.moveUp")}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={entryIndex <= 0}
                        onClick={() => moveEntry(row.layerId, "up")}
                      >
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label={t("printLayout.legend.moveDown")}
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={entryIndex >= entryIdsInOrder.length - 1}
                        onClick={() => moveEntry(row.layerId, "down")}
                      >
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  {(() => {
                    const svgSrc =
                      row.marker?.shape === "custom" && row.marker.svg
                        ? markerIcons.get(row.marker.svg)?.src
                        : undefined;
                    if (svgSrc) {
                      return (
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm border bg-contain bg-center bg-no-repeat"
                          // Quote the url(): resolveSvgSource encodes markup with
                          // encodeURIComponent, which leaves ( ) unescaped, and an
                          // unquoted ) (common in SVG: translate(), rgba(), url(#id))
                          // would prematurely close the CSS url() token.
                          style={{
                            backgroundImage: `url("${svgSrc}")`,
                          }}
                        />
                      );
                    }
                    if (row.color) {
                      return (
                        <span
                          className="h-3.5 w-3.5 shrink-0 rounded-sm border"
                          style={{ backgroundColor: row.color }}
                        />
                      );
                    }
                    return <span className="w-3.5 shrink-0" />;
                  })()}
                  <Input
                    className="h-7 flex-1 text-sm"
                    value={row.label}
                    placeholder={row.defaultLabel || t("printLayout.legend.labelPlaceholder")}
                    onChange={(e) =>
                      setLegendConfig(
                        setLegendItemLabel(legendConfig, row.key, e.target.value, row.defaultLabel),
                      )
                    }
                  />
                  <button
                    type="button"
                    aria-label={
                      row.hidden
                        ? t("printLayout.legend.showEntry")
                        : t("printLayout.legend.hideEntry")
                    }
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setLegendConfig(toggleLegendItemHidden(legendConfig, row.key))}
                  >
                    {row.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
