import type { AlgorithmParameter, FieldWeight } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Plus, X } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

export interface FieldWeightsFieldProps {
  param: AlgorithmParameter;
  /** Current rows; anything that is not an array reads as "no rows yet". */
  value: unknown;
  /** Attribute-field names of the parameter's source layer. */
  fieldOptions: string[];
  onChange: (value: FieldWeight[]) => void;
}

/** A fresh row's settings, used for every field the author adds. */
const DEFAULT_ROW: Omit<FieldWeight, "field"> = {
  normalization: "min-max",
  weight: 1,
  direction: "higher",
};

/** Normalization ids in the order the row's picker offers them. */
const NORMALIZATIONS: FieldWeight["normalization"][] = ["min-max", "z-score", "rank", "quantile"];

/** Read the parameter value as rows, tolerating an unset or malformed value. */
function toRows(value: unknown): FieldWeight[] {
  return Array.isArray(value) ? (value as FieldWeight[]) : [];
}

/**
 * Editor for a `type: "field-weights"` parameter: one row per scored field,
 * each with a normalization, a relative weight, and the end of the range that
 * scores well. Used by the composite score builder.
 *
 * Weights are entered as plain relative numbers and shown as the share of the
 * total each one carries, because that share — not the raw number — is what
 * moves the result. A field already used by another row is left out of that
 * row's picker, so the same field cannot be weighted twice.
 *
 * @param props.param - The parameter definition (label, required flag, help).
 * @param props.value - Current rows.
 * @param props.fieldOptions - Attribute fields of the selected layer.
 * @param props.onChange - Receives the edited rows.
 */
export function FieldWeightsField({
  param,
  value,
  fieldOptions,
  onChange,
}: FieldWeightsFieldProps): ReactElement {
  const { t } = useTranslation();
  const rows = toRows(value);
  const used = new Set(rows.map((row) => row.field));
  const totalWeight = rows.reduce((acc, row) => acc + (row.weight > 0 ? row.weight : 0), 0);
  const available = fieldOptions.filter((name) => !used.has(name));

  const updateRow = (index: number, patch: Partial<FieldWeight>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const addRow = (): void => {
    // Pre-fill with the first unused field: the picker still shows what was
    // chosen, and the common case (score every numeric field) is one click.
    onChange([...rows, { ...DEFAULT_ROW, field: available[0] ?? "" }]);
  };

  const normalizationLabel = (id: FieldWeight["normalization"]): string =>
    ({
      "min-max": t("processing.fieldWeights.normalization.minMax"),
      "z-score": t("processing.fieldWeights.normalization.zScore"),
      rank: t("processing.fieldWeights.normalization.rank"),
      quantile: t("processing.fieldWeights.normalization.quantile"),
    })[id];

  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs">
        {param.label}
        {param.required ? <span className="text-destructive"> *</span> : null}
      </Label>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {fieldOptions.length
            ? t("processing.fieldWeights.empty")
            : t("processing.parameterField.selectLayerFirst")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_4.5rem_minmax(0,1.4fr)_2rem] items-center gap-2 text-[11px] text-muted-foreground">
            <span>{t("processing.fieldWeights.columnField")}</span>
            <span>{t("processing.fieldWeights.columnNormalization")}</span>
            <span>{t("processing.fieldWeights.columnWeight")}</span>
            <span>{t("processing.fieldWeights.columnDirection")}</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div
              // Rows are positional and a field may be blank, so the index is
              // the only stable key here.
              key={index}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_4.5rem_minmax(0,1.4fr)_2rem] items-center gap-2"
            >
              <Select
                aria-label={t("processing.fieldWeights.columnField")}
                value={row.field}
                onChange={(e) => updateRow(index, { field: e.target.value })}
              >
                <option value="">{t("processing.parameterField.selectField")}</option>
                {fieldOptions
                  .filter((name) => name === row.field || !used.has(name))
                  .map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
              </Select>
              <Select
                aria-label={t("processing.fieldWeights.columnNormalization")}
                value={row.normalization}
                onChange={(e) =>
                  updateRow(index, {
                    normalization: e.target.value as FieldWeight["normalization"],
                  })
                }
              >
                {NORMALIZATIONS.map((id) => (
                  <option key={id} value={id}>
                    {normalizationLabel(id)}
                  </option>
                ))}
              </Select>
              <Input
                aria-label={t("processing.fieldWeights.columnWeight")}
                type="number"
                min={0}
                step={0.1}
                value={String(row.weight)}
                onChange={(e) =>
                  updateRow(index, {
                    weight: e.target.value === "" ? 0 : Number(e.target.value),
                  })
                }
              />
              <Select
                aria-label={t("processing.fieldWeights.columnDirection")}
                value={row.direction}
                onChange={(e) =>
                  updateRow(index, { direction: e.target.value as FieldWeight["direction"] })
                }
              >
                <option value="higher">{t("processing.fieldWeights.direction.higher")}</option>
                <option value="lower">{t("processing.fieldWeights.direction.lower")}</option>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label={t("processing.fieldWeights.removeAria", {
                  field: row.field || t("processing.fieldWeights.columnField"),
                })}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {totalWeight > 0
              ? t("processing.fieldWeights.shares", {
                  shares: rows
                    .map(
                      (row) =>
                        `${row.field || "?"} ${Math.round(((row.weight > 0 ? row.weight : 0) / totalWeight) * 100)}%`,
                    )
                    .join(" · "),
                })
              : t("processing.fieldWeights.noWeight")}
          </p>
        </div>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7"
          disabled={available.length === 0}
          onClick={addRow}
        >
          <Plus className="me-1 h-3.5 w-3.5" />
          {t("processing.fieldWeights.addField")}
        </Button>
      </div>

      {param.description ? (
        <p className="text-xs text-muted-foreground">{param.description}</p>
      ) : null}
    </div>
  );
}
