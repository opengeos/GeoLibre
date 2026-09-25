import { useTranslation } from "react-i18next";
import { VECTOR_COLOR_RAMPS } from "@geolibre/core";
import { Input, Label, Select, Slider } from "@geolibre/ui";
import type { LayoutEditorProps } from "./state";

/** A native colorbar composed in the dialog: ramp, range, label, placement. */
export function ColorbarEditor({ layout, dispatch }: LayoutEditorProps) {
  const { t } = useTranslation();
  const {
    colorbarRamp,
    colorbarMin,
    colorbarMax,
    colorbarLabel,
    colorbarOrientation,
    colorbarPosition,
    colorbarLength,
  } = layout;
  const set = (patch: Partial<typeof layout>) => dispatch({ type: "setLayout", patch });
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="cb-ramp">{t("printLayout.colorbar.colormap")}</Label>
        <Select
          id="cb-ramp"
          value={colorbarRamp}
          onChange={(e) => set({ colorbarRamp: e.target.value })}
        >
          {VECTOR_COLOR_RAMPS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cb-min">{t("printLayout.colorbar.min")}</Label>
          <Input
            id="cb-min"
            type="number"
            value={colorbarMin}
            onChange={(e) => set({ colorbarMin: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cb-max">{t("printLayout.colorbar.max")}</Label>
          <Input
            id="cb-max"
            type="number"
            value={colorbarMax}
            onChange={(e) => set({ colorbarMax: e.target.value })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cb-label">{t("printLayout.colorbar.label")}</Label>
        <Input
          id="cb-label"
          value={colorbarLabel}
          placeholder={t("printLayout.colorbar.labelPlaceholder")}
          onChange={(e) => set({ colorbarLabel: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="cb-orientation">{t("printLayout.colorbar.orientation")}</Label>
          <Select
            id="cb-orientation"
            value={colorbarOrientation}
            onChange={(e) =>
              set({ colorbarOrientation: e.target.value as "vertical" | "horizontal" })
            }
          >
            <option value="vertical">{t("printLayout.colorbar.vertical")}</option>
            <option value="horizontal">{t("printLayout.colorbar.horizontal")}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cb-position">{t("printLayout.colorbar.position")}</Label>
          <Select
            id="cb-position"
            value={colorbarPosition}
            onChange={(e) => set({ colorbarPosition: e.target.value as typeof colorbarPosition })}
          >
            <option value="top-left">{t("printLayout.position.topLeft")}</option>
            <option value="top-right">{t("printLayout.position.topRight")}</option>
            <option value="bottom-left">{t("printLayout.position.bottomLeft")}</option>
            <option value="bottom-right">{t("printLayout.position.bottomRight")}</option>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="cb-length">{t("printLayout.colorbar.length")}</Label>
          <span className="text-sm tabular-nums text-muted-foreground">{colorbarLength}%</span>
        </div>
        <Slider
          id="cb-length"
          aria-label={t("printLayout.colorbar.length")}
          min={5}
          max={95}
          step={1}
          value={[colorbarLength]}
          onValueChange={(v: number[]) => set({ colorbarLength: v[0] })}
        />
      </div>
    </div>
  );
}
