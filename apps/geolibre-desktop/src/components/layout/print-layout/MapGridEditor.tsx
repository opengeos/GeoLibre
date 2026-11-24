import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { Input, Label, Select } from "@geolibre/ui";
import type { PrintLayoutGridType } from "@geolibre/core";
import { ToggleField } from "./ToggleField";
import type { LayoutEditorProps } from "./state";
import { layoutMapGrid, resolvePageSize, type LayoutOptions } from "../../../lib/print-layout";

const GRID_TYPES: readonly PrintLayoutGridType[] = ["dms", "decimal", "utm", "mgrs"];

interface MapGridEditorProps extends LayoutEditorProps {
  options: LayoutOptions;
}

/** The map-frame coordinate grid: type, interval, label size, lines (GH #3530). */
export function MapGridEditor({ layout, dispatch, options }: MapGridEditorProps) {
  const { t } = useTranslation();
  const georeferenced = Boolean(options.mapGeoref);
  const effectiveInterval = useMemo(() => {
    if (!options.grid || !(options.grid.interval > 0)) return undefined;
    const page = resolvePageSize(options);
    return layoutMapGrid(options, page.width, page.height)?.interval;
  }, [options]);
  const projected = layout.gridType === "utm" || layout.gridType === "mgrs";
  const [intervalDraft, setIntervalDraft] = useState(String(layout.gridInterval));
  const [fontDraft, setFontDraft] = useState(String(layout.gridFontSize));
  useEffect(
    () => setIntervalDraft(String(layout.gridInterval)),
    [layout.gridInterval, layout.gridType],
  );
  useEffect(() => setFontDraft(String(layout.gridFontSize)), [layout.gridFontSize]);
  const commitInterval = () => {
    const parsed = Number(intervalDraft);
    const value = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    const interval =
      layout.gridType === "mgrs" && value > 0 ? Math.ceil(value / 1000) * 1000 : value;
    setIntervalDraft(String(interval));
    dispatch({ type: "setLayout", patch: { gridInterval: interval } });
  };
  const commitFont = () => {
    const value = Math.max(3, Math.min(36, Number(fontDraft) || 7));
    setFontDraft(String(value));
    dispatch({ type: "setLayout", patch: { gridFontSize: value } });
  };
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t("printLayout.grid.heading")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="layout-grid-type">{t("printLayout.grid.type")}</Label>
        <Select
          id="layout-grid-type"
          value={layout.gridType}
          onChange={(e) => {
            const gridType = e.target.value as PrintLayoutGridType;
            const wasProjected = projected;
            const isProjected = gridType === "utm" || gridType === "mgrs";
            // Degrees and metres do not convert: switching unit families
            // returns the interval to automatic rather than reading 1 degree as
            // 1 metre.
            dispatch({
              type: "setLayout",
              patch: {
                gridType,
                gridInterval:
                  wasProjected !== isProjected
                    ? 0
                    : gridType === "mgrs" && layout.gridInterval > 0
                      ? Math.ceil(layout.gridInterval / 1000) * 1000
                      : layout.gridInterval,
              },
            });
          }}
        >
          {GRID_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`printLayout.grid.typeOption.${type}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="layout-grid-interval">
            {projected
              ? t("printLayout.grid.intervalMeters")
              : t("printLayout.grid.intervalDegrees")}
          </Label>
          <Input
            id="layout-grid-interval"
            type="number"
            min={0}
            step={projected ? 1000 : 0.25}
            value={intervalDraft}
            onChange={(e) => setIntervalDraft(e.target.value)}
            onBlur={commitInterval}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          {layout.gridType === "mgrs" && (
            <p className="text-xs text-muted-foreground">{t("printLayout.grid.mgrsPrecision")}</p>
          )}
          {layout.gridInterval > 0 &&
            effectiveInterval !== undefined &&
            effectiveInterval > layout.gridInterval * (1 + 1e-9) && (
              <p className="text-xs text-muted-foreground">
                {t("printLayout.grid.denseInterval", {
                  interval: Number(effectiveInterval.toPrecision(4)),
                })}
              </p>
            )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="layout-grid-font">{t("printLayout.grid.fontSize")}</Label>
          <Input
            id="layout-grid-font"
            type="number"
            min={3}
            max={36}
            value={fontDraft}
            onChange={(e) => setFontDraft(e.target.value)}
            onBlur={commitFont}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </div>
      </div>
      <ToggleField
        id="layout-grid-lines"
        label={t("printLayout.grid.lines")}
        checked={layout.gridLines}
        onChange={(gridLines) => dispatch({ type: "setLayout", patch: { gridLines } })}
      />
      {!georeferenced && (
        <p className="text-xs text-muted-foreground">{t("printLayout.grid.needsGeoref")}</p>
      )}
    </div>
  );
}
