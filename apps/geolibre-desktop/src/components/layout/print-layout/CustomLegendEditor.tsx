import { useTranslation } from "react-i18next";
import { Button, Input, Label, Select, Separator, Textarea } from "@geolibre/ui";
import { Plus, Trash2 } from "lucide-react";
import type { LayoutEditorProps } from "./state";

interface CustomLegendEditorProps extends LayoutEditorProps {
  /** The "Import from Dictionary" textarea text. */
  legendDict: string;
  legendDictError: string | null;
}

/** A user-defined legend composed in the dialog (like Controls -> Legend). */
export function CustomLegendEditor({
  layout,
  dispatch,
  legendDict,
  legendDictError,
}: CustomLegendEditorProps) {
  const { t } = useTranslation();
  const { customLegendTitle, customLegendEntries, customLegendPosition } = layout;
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="cl-title">{t("printLayout.customLegend.title")}</Label>
        <Input
          id="cl-title"
          value={customLegendTitle}
          placeholder={t("printLayout.legend.defaultTitle")}
          onChange={(e) =>
            dispatch({ type: "setLayout", patch: { customLegendTitle: e.target.value } })
          }
        />
      </div>
      <div className="space-y-1.5">
        {customLegendEntries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-2">
            <input
              type="color"
              aria-label={t("printLayout.customLegend.color")}
              className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-background"
              value={entry.color}
              onChange={(e) =>
                dispatch({
                  type: "updateCustomLegendEntry",
                  id: entry.id,
                  patch: { color: e.target.value },
                })
              }
            />
            <Input
              className="h-8 flex-1 text-sm"
              value={entry.label}
              placeholder={t("printLayout.customLegend.itemLabel")}
              onChange={(e) =>
                dispatch({
                  type: "updateCustomLegendEntry",
                  id: entry.id,
                  patch: { label: e.target.value },
                })
              }
            />
            <button
              type="button"
              aria-label={t("printLayout.customLegend.removeItem")}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => dispatch({ type: "removeCustomLegendEntry", id: entry.id })}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: "addCustomLegendEntry" })}
        >
          <Plus className="me-1.5 h-3.5 w-3.5" />
          {t("printLayout.customLegend.addItem")}
        </Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cl-position">{t("printLayout.customLegend.position")}</Label>
        <Select
          id="cl-position"
          value={customLegendPosition}
          onChange={(e) =>
            dispatch({
              type: "setLayout",
              patch: { customLegendPosition: e.target.value as typeof customLegendPosition },
            })
          }
        >
          <option value="top-left">{t("printLayout.position.topLeft")}</option>
          <option value="top-right">{t("printLayout.position.topRight")}</option>
          <option value="bottom-left">{t("printLayout.position.bottomLeft")}</option>
          <option value="bottom-right">{t("printLayout.position.bottomRight")}</option>
        </Select>
      </div>
      <Separator />
      <div className="space-y-1.5">
        <Label htmlFor="cl-dict">{t("printLayout.customLegend.importFromDict")}</Label>
        <Textarea
          id="cl-dict"
          rows={3}
          className="font-mono text-xs"
          value={legendDict}
          placeholder={'{"Label A": "#ff6b6b", "Label B": "#4ecdc4"}'}
          onChange={(e) => dispatch({ type: "setUi", patch: { legendDict: e.target.value } })}
        />
        {legendDictError && <p className="text-xs text-destructive">{legendDictError}</p>}
        <Button
          variant="outline"
          size="sm"
          disabled={!legendDict.trim()}
          onClick={() =>
            dispatch({
              type: "importLegendDict",
              errorMessage: t("printLayout.customLegend.importError"),
            })
          }
        >
          {t("printLayout.customLegend.import")}
        </Button>
      </div>
    </div>
  );
}
