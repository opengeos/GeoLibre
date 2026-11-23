import { useTranslation } from "react-i18next";
import { Input, Label, Select } from "@geolibre/ui";
import { PRINT_LAYOUT_INSET_BASEMAPS, type PrintLayoutInsetBasemap } from "@geolibre/core";
import type { LayoutEditorProps } from "./state";

interface InsetMapEditorProps extends LayoutEditorProps {
  /** Whether the capture is georeferenced, so the extent box can be drawn. */
  georeferenced: boolean;
}

/** The overview / inset locator map's basemap, zoom and extent colour (GH #3530). */
export function InsetMapEditor({ layout, dispatch, georeferenced }: InsetMapEditorProps) {
  const { t } = useTranslation();
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
            value={-layout.insetZoomOffset}
            onChange={(e) =>
              dispatch({
                type: "setLayout",
                patch: {
                  insetZoomOffset: -Math.max(0, Math.min(12, Number(e.target.value) || 0)),
                },
              })
            }
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
    </div>
  );
}
