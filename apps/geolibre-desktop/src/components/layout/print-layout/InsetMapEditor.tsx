import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { PRINT_LAYOUT_INSET_BASEMAPS, type PrintLayoutInsetBasemap } from "@geolibre/core";
import type { LayoutEditorProps } from "./state";

interface InsetMapEditorProps extends LayoutEditorProps {
  /** Whether the capture is georeferenced, so the extent box can be drawn. */
  georeferenced: boolean;
  status: { loading: boolean; failed: boolean; retry: () => void };
}

/** The overview / inset locator map's basemap, zoom and extent colour (GH #3530). */
export function InsetMapEditor({ layout, dispatch, georeferenced, status }: InsetMapEditorProps) {
  const { t } = useTranslation();
  const [zoomDraft, setZoomDraft] = useState(String(-layout.insetZoomOffset));
  useEffect(() => setZoomDraft(String(-layout.insetZoomOffset)), [layout.insetZoomOffset]);
  const commitZoom = () => {
    const value = zoomDraft.trim() ? Number(zoomDraft) : NaN;
    const normalized = Number.isFinite(value)
      ? Math.max(0, Math.min(12, value))
      : -layout.insetZoomOffset;
    dispatch({ type: "setLayout", patch: { insetZoomOffset: -normalized } });
    setZoomDraft(String(normalized));
  };
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t("printLayout.inset.heading")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="layout-inset-basemap">{t("printLayout.inset.basemap")}</Label>
        <Select
          id="layout-inset-basemap"
          value={layout.insetBasemap}
          onChange={(e) =>
            dispatch({
              type: "setLayout",
              patch: { insetBasemap: e.target.value as PrintLayoutInsetBasemap },
            })
          }
        >
          {PRINT_LAYOUT_INSET_BASEMAPS.map((id) => (
            <option key={id} value={id}>
              {t(`printLayout.inset.basemapOption.${id}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="layout-inset-zoom">{t("printLayout.inset.zoomOffset")}</Label>
          <Input
            id="layout-inset-zoom"
            type="number"
            min={0}
            max={12}
            step={1}
            // Shown as a positive "zoom out by N levels"; stored as a negative
            // offset from the main frame's fitted zoom.
            value={zoomDraft}
            onChange={(event) => setZoomDraft(event.target.value)}
            onBlur={commitZoom}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="layout-inset-color">{t("printLayout.inset.extentColor")}</Label>
          <input
            id="layout-inset-color"
            type="color"
            className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
            value={layout.insetExtentColor}
            onChange={(e) =>
              dispatch({ type: "setLayout", patch: { insetExtentColor: e.target.value } })
            }
          />
        </div>
      </div>
      {!georeferenced && (
        <p className="text-xs text-muted-foreground">{t("printLayout.inset.needsGeoref")}</p>
      )}
      {status.loading && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("printLayout.inset.loading")}
        </p>
      )}
      {status.failed && (
        <div role="alert" className="space-y-2 text-xs">
          <p>{t("printLayout.inset.failed")}</p>
          <Button size="sm" variant="outline" onClick={status.retry}>
            {t("printLayout.inset.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
