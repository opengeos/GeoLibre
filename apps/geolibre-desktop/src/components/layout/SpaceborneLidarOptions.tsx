import { useMemo, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { SpaceborneLidarField, SpaceborneLidarFile } from "@geolibre/plugins";
import { Input, Label, Select } from "@geolibre/ui";
import { fieldKey } from "../../lib/spaceborne-lidar-samples";

type SetState<T> = Dispatch<SetStateAction<T>>;

/** Return a copy of `set` with `key` added or removed. */
function toggle(set: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

interface SpaceborneLidarOptionsProps {
  file: SpaceborneLidarFile;
  fields: SpaceborneLidarField[];
  chosenFields: SpaceborneLidarField[];
  selectedBeams: Set<string>;
  setSelectedBeams: SetState<Set<string>>;
  selectedFields: Set<string>;
  setSelectedFields: SetState<Set<string>>;
  fieldFilter: string;
  setFieldFilter: SetState<string>;
  colorBy: string;
  setColorBy: SetState<string>;
  qualityFilter: boolean;
  setQualityFilter: SetState<boolean>;
  viewOnly: boolean;
  setViewOnly: SetState<boolean>;
  maxPoints: string;
  setMaxPoints: SetState<string>;
}

/**
 * The ICESat-2/GEDI dialog's read options for an opened granule: beams, the
 * filterable field list, the color-by field, the quality and extent filters,
 * and the point cap. State lives in the dialog, which reads it on submit.
 */
export function SpaceborneLidarOptions({
  file,
  fields,
  chosenFields,
  selectedBeams,
  setSelectedBeams,
  selectedFields,
  setSelectedFields,
  fieldFilter,
  setFieldFilter,
  colorBy,
  setColorBy,
  qualityFilter,
  setQualityFilter,
  viewOnly,
  setViewOnly,
  maxPoints,
  setMaxPoints,
}: SpaceborneLidarOptionsProps) {
  const { t } = useTranslation();

  const visibleFields = useMemo(() => {
    const query = fieldFilter.trim().toLowerCase();
    if (!query) return fields;
    return fields.filter(
      (field) =>
        field.path.toLowerCase().includes(query) ||
        field.name.toLowerCase().includes(query) ||
        field.description?.toLowerCase().includes(query),
    );
  }, [fields, fieldFilter]);

  return (
    <>
      <div className="space-y-1.5">
        <Label>{t("addData.spaceborneLidar.beamsLabel")}</Label>
        <div className="grid grid-cols-2 gap-1">
          {file.beams.map((beam) => (
            <label key={beam.name} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 rounded border"
                checked={selectedBeams.has(beam.name)}
                onChange={(e) =>
                  setSelectedBeams((prev) => toggle(prev, beam.name, e.target.checked))
                }
              />
              <span>
                {beam.name}
                {beam.type ? ` (${beam.type})` : ""}
                <span className="text-muted-foreground"> · {beam.count.toLocaleString()}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="spaceborne-lidar-field-filter">
          {t("addData.spaceborneLidar.fieldsLabel", {
            selected: chosenFields.length,
            total: fields.length,
          })}
        </Label>
        <Input
          id="spaceborne-lidar-field-filter"
          value={fieldFilter}
          placeholder={t("addData.spaceborneLidar.fieldFilterPlaceholder")}
          onChange={(e) => setFieldFilter(e.target.value)}
        />
        <div className="max-h-40 space-y-0.5 overflow-y-auto overflow-x-hidden rounded border p-1.5">
          {visibleFields.map((field) => {
            const key = fieldKey(field);
            return (
              <label
                key={key}
                className="flex cursor-pointer items-center gap-2 text-xs"
                title={field.description}
              >
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border"
                  checked={selectedFields.has(key)}
                  onChange={(e) => setSelectedFields((prev) => toggle(prev, key, e.target.checked))}
                />
                <span className="shrink-0 font-mono">{field.name}</span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {field.name !== field.path ? field.path : ""}
                  {field.column !== undefined ? `[${field.column}]` : ""}
                  {field.units ? ` (${field.units})` : ""}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="spaceborne-lidar-color-by">
          {t("addData.spaceborneLidar.colorByLabel")}
        </Label>
        <Select
          id="spaceborne-lidar-color-by"
          value={colorBy}
          onChange={(e) => setColorBy(e.target.value)}
          disabled={chosenFields.length === 0}
        >
          {chosenFields.map((field) => (
            <option key={fieldKey(field)} value={field.name}>
              {field.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border"
            checked={qualityFilter}
            onChange={(e) => setQualityFilter(e.target.checked)}
          />
          {t("addData.spaceborneLidar.qualityFilter")}
        </label>
        <p className="ps-5 text-xs text-muted-foreground">
          {t(`addData.spaceborneLidar.qualityHelp.${file.product.id}`)}
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border"
            checked={viewOnly}
            onChange={(e) => setViewOnly(e.target.checked)}
          />
          {t("addData.spaceborneLidar.viewOnly")}
        </label>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="spaceborne-lidar-max-points">
          {t("addData.spaceborneLidar.maxPointsLabel")}
        </Label>
        <Input
          id="spaceborne-lidar-max-points"
          type="number"
          min={1}
          value={maxPoints}
          onChange={(e) => setMaxPoints(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("addData.spaceborneLidar.maxPointsHelp")}
        </p>
      </div>
    </>
  );
}
