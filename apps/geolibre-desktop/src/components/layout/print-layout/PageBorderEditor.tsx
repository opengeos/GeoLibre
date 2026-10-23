import { useTranslation } from "react-i18next";
import { Input, Label } from "@geolibre/ui";
import type { LayoutEditorProps } from "./state";

/** The page border's colour and width. */
export function PageBorderEditor({ layout, dispatch }: LayoutEditorProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="layout-border-color">{t("printLayout.borderColor")}</Label>
        <input
          id="layout-border-color"
          type="color"
          className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
          value={layout.pageBorderColor}
          onChange={(e) =>
            dispatch({ type: "setLayout", patch: { pageBorderColor: e.target.value } })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="layout-border-width">{t("printLayout.borderWidth")}</Label>
        <Input
          id="layout-border-width"
          type="number"
          min={1}
          max={10}
          value={layout.pageBorderWidth}
          onChange={(e) =>
            dispatch({
              type: "setLayout",
              patch: {
                pageBorderWidth: Math.max(1, Math.min(10, Number(e.target.value) || 1)),
              },
            })
          }
        />
      </div>
    </div>
  );
}
