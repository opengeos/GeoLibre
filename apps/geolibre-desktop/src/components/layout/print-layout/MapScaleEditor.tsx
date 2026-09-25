import type { Dispatch } from "react";
import { useTranslation } from "react-i18next";
import { Input, Label, Select } from "@geolibre/ui";
import type { PrintLayoutAction } from "./state";

/** Common industry scale denominators offered as quick presets (GH #522). */
const SCALE_PRESETS = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

interface MapScaleEditorProps {
  dispatch: Dispatch<PrintLayoutAction>;
  scaleDraft: string;
  scaleNotice: string | null;
  /** False before a capture exists and in extent mode (a drawn extent fixes the area). */
  scaleEditable: boolean;
  currentRatio: number;
  /** Marks the input as focused so the two-way sync leaves it alone. */
  scaleFocusedRef: React.RefObject<boolean>;
  applyScale: (targetRatio: number) => void;
}

/** The map's 1:N scale on physical paper: typed, or picked from presets. */
export function MapScaleEditor({
  dispatch,
  scaleDraft,
  scaleNotice,
  scaleEditable,
  currentRatio,
  scaleFocusedRef,
  applyScale,
}: MapScaleEditorProps) {
  const { t } = useTranslation();
  const setScaleDraft = (value: string) =>
    dispatch({ type: "setUi", patch: { scaleDraft: value } });
  return (
    <div className="space-y-1.5">
      <Label htmlFor="layout-scale">{t("printLayout.scaleLabel")}</Label>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">1:</span>
        <Input
          id="layout-scale"
          inputMode="numeric"
          className="flex-1"
          value={scaleDraft}
          disabled={!scaleEditable}
          placeholder={t("printLayout.scalePlaceholder")}
          onFocus={() => {
            scaleFocusedRef.current = true;
          }}
          onChange={(e) => setScaleDraft(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={() => {
            scaleFocusedRef.current = false;
            const n = Number(scaleDraft);
            if (n > 0) applyScale(n);
            else setScaleDraft(currentRatio > 0 ? String(Math.round(currentRatio)) : "");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <Select
          aria-label={t("printLayout.scalePresetsAria")}
          value=""
          disabled={!scaleEditable}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n > 0) applyScale(n);
          }}
        >
          <option value="">{t("printLayout.scalePresets")}</option>
          {SCALE_PRESETS.map((n) => (
            <option key={n} value={n}>
              1:{n.toLocaleString()}
            </option>
          ))}
        </Select>
      </div>
      {scaleNotice && <p className="text-xs text-destructive">{scaleNotice}</p>}
    </div>
  );
}
