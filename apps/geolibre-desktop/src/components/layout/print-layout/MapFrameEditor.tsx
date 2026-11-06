import { useTranslation } from "react-i18next";
import { Input, Label, Select } from "@geolibre/ui";
import { DEFAULT_PRINT_LAYOUT } from "@geolibre/core";
import { BackgroundColorField } from "./BackgroundColorField";
import type { LayoutEditorProps } from "./state";

interface MapFrameEditorProps extends LayoutEditorProps {
  /** The free-form hex field's text (may be a half-typed colour). */
  mapBackgroundDraft: string;
}

/** The map frame: its background colour, its border (GH #749) and the panels over it. */
export function MapFrameEditor({ layout, dispatch, mapBackgroundDraft }: MapFrameEditorProps) {
  const { t } = useTranslation();
  const { mapBackground, mapBorderColor, mapBorderWidth } = layout;
  return (
    <>
      <BackgroundColorField
        id="layout-map-bg"
        label={t("printLayout.mapBackground")}
        value={mapBackground}
        draft={mapBackgroundDraft}
        resetValue={DEFAULT_PRINT_LAYOUT.mapBackground}
        onCommit={(value) => dispatch({ type: "commitMapBackground", value })}
      />

      <div className="space-y-1.5">
        <Label htmlFor="layout-panel-theme">{t("printLayout.panelTheme")}</Label>
        <Select
          id="layout-panel-theme"
          value={layout.panelTheme}
          onChange={(e) =>
            dispatch({
              type: "setLayout",
              patch: { panelTheme: e.target.value as "light" | "dark" },
            })
          }
        >
          <option value="light">{t("printLayout.panelThemeOption.light")}</option>
          <option value="dark">{t("printLayout.panelThemeOption.dark")}</option>
        </Select>
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
