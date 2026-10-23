import { useTranslation } from "react-i18next";
import { Button, Input, Label } from "@geolibre/ui";
import type { LayoutEditorProps } from "./state";

interface MapFrameEditorProps extends LayoutEditorProps {
  /** The free-form hex field's text (may be a half-typed colour). */
  mapBackgroundDraft: string;
}

/** The map frame: its background colour and its border (GH #749). */
export function MapFrameEditor({ layout, dispatch, mapBackgroundDraft }: MapFrameEditorProps) {
  const { t } = useTranslation();
  const { mapBackground, mapBorderColor, mapBorderWidth } = layout;
  const commitMapBackground = (value: string) => dispatch({ type: "commitMapBackground", value });
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="layout-map-bg">{t("printLayout.mapBackground")}</Label>
        <div className="flex items-center gap-2">
          <input
            id="layout-map-bg"
            type="color"
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-background"
            value={mapBackground}
            onChange={(e) => commitMapBackground(e.target.value)}
          />
          <Input
            aria-label={t("printLayout.mapBackground")}
            className="flex-1"
            value={mapBackgroundDraft}
            onChange={(e) => commitMapBackground(e.target.value)}
          />
          <Button variant="ghost" size="sm" onClick={() => commitMapBackground("#e5e7eb")}>
            {t("common.reset")}
          </Button>
        </div>
      </div>

      {/* Map frame border (color + thickness; 0 hides it). GH #749. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="layout-map-border-color">{t("printLayout.mapBorderColor")}</Label>
          <input
            id="layout-map-border-color"
            type="color"
            className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
            value={mapBorderColor}
            onChange={(e) =>
              dispatch({ type: "setLayout", patch: { mapBorderColor: e.target.value } })
            }
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="layout-map-border-width">{t("printLayout.mapBorderWidth")}</Label>
          <Input
            id="layout-map-border-width"
            type="number"
            min={0}
            max={10}
            value={mapBorderWidth}
            onChange={(e) =>
              dispatch({
                type: "setLayout",
                patch: {
                  mapBorderWidth: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                },
              })
            }
          />
        </div>
      </div>
    </>
  );
}
