import {
  type GeoLibreLayer,
  type SelectionMode,
  SELECTION_MODES,
} from "@geolibre/core";
import { Label, Select } from "@geolibre/ui";
import type { ParseKeys } from "i18next";
import { useTranslation } from "react-i18next";

/**
 * Layers the interactive selection dialogs can operate on: those whose
 * features are present in the store. Matches the highlight/attribute-table
 * model, which resolves selection ids against `layer.geojson`.
 */
export function selectableVectorLayers(
  layers: GeoLibreLayer[],
): GeoLibreLayer[] {
  return layers.filter((layer) => (layer.geojson?.features?.length ?? 0) > 0);
}

/** i18n label key per selection mode. */
export const SELECTION_MODE_LABEL_KEYS: Record<SelectionMode, ParseKeys> = {
  new: "selection.modeNew",
  add: "selection.modeAdd",
  remove: "selection.modeRemove",
  intersect: "selection.modeIntersect",
};

/** The "modify current selection by" dropdown shared by both dialogs. */
export function SelectionModeField({
  mode,
  onChange,
}: {
  mode: SelectionMode;
  onChange: (mode: SelectionMode) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <Label htmlFor="selection-mode">{t("selection.mode")}</Label>
      <Select
        id="selection-mode"
        value={mode}
        onChange={(event) => onChange(event.target.value as SelectionMode)}
      >
        {SELECTION_MODES.map((value) => (
          <option key={value} value={value}>
            {t(SELECTION_MODE_LABEL_KEYS[value])}
          </option>
        ))}
      </Select>
    </div>
  );
}
