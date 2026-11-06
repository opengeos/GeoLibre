import {
  collectLevels,
  currentLevelChoice,
  guessLevelField,
  selectLevel,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import { Label, Select } from "@geolibre/ui";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";

/**
 * The property names seen in a layer's features, the likely floor field first.
 *
 * @param features - The layer's local features.
 * @returns Field names, sorted, with {@link guessLevelField}'s pick moved to the front.
 */
function fieldOptions(
  features: readonly { properties?: Record<string, unknown> | null }[] = [],
): string[] {
  const names = new Set<string>();
  // Every feature, not a sample: a floor field may appear only on features
  // late in the file (a collection that lists outdoor features first).
  for (const feature of features) {
    for (const key of Object.keys(feature?.properties ?? {})) names.add(key);
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const guess = guessLevelField(sorted);
  return guess ? [guess, ...sorted.filter((name) => name !== guess)] : sorted;
}

/**
 * The Style panel's Floor picker section (issue #3341): link a multi-floor
 * layer to the on-map floor picker by naming the field that holds its floor.
 *
 * Linking adopts the floor the picker currently shows, so a second layer of
 * the same building (rooms, then doors) joins on the floor in view.
 */
export function FloorPickerSection({ layer }: { layer: GeoLibreLayer }) {
  const { t } = useTranslation();
  const setLayerLevelFilter = useAppStore((state) => state.setLayerLevelFilter);
  const linked = useAppStore(
    useShallow((state) => state.layers.filter((item) => item.levelFilter !== undefined)),
  );
  const features = layer.geojson?.features;
  const fields = useMemo(() => fieldOptions(features), [features]);
  const field = layer.levelFilter?.field ?? "";
  const levelCount = useMemo(
    () => (field ? collectLevels(layer.geojson?.features, field).length : 0),
    [layer.geojson, field],
  );

  const onChange = (next: string) => {
    if (!next) {
      setLayerLevelFilter(layer.id, null);
      return;
    }
    const others = linked.filter((item) => item.id !== layer.id);
    const choice = currentLevelChoice(others);
    setLayerLevelFilter(
      layer.id,
      selectLevel({ field: next }, layer.geojson?.features, choice.level, choice.mode),
    );
  };

  return (
    <div className="space-y-2" data-testid="floor-picker-section">
      <p className="text-sm font-semibold">{t("floorPicker.heading")}</p>
      <div className="space-y-2">
        <Label htmlFor={`floor-field-${layer.id}`}>{t("floorPicker.field")}</Label>
        <Select
          id={`floor-field-${layer.id}`}
          value={field}
          onChange={(event) => onChange(event.target.value)}
          data-testid="floor-picker-field"
        >
          <option value="">{t("floorPicker.off")}</option>
          {fields.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          {field && !fields.includes(field) ? <option value={field}>{field}</option> : null}
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {field
          ? levelCount > 0
            ? t("floorPicker.linkedHint", { count: levelCount })
            : t("floorPicker.noLevels", { field })
          : t("floorPicker.hint")}
      </p>
    </div>
  );
}
