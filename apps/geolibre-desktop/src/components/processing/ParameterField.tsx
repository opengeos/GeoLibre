import type { AlgorithmParameter, FieldWeight } from "@geolibre/processing";
import { Input, Label, Select } from "@geolibre/ui";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { FieldWeightsField } from "./FieldWeightsField";

export interface ParameterFieldProps {
  param: AlgorithmParameter;
  value: unknown;
  layerOptions: { id: string; name: string }[];
  /** Attribute-field names for a `type: "field"` or `"field-weights"` parameter. */
  fieldOptions?: string[];
  onChange: (value: unknown) => void;
}

/**
 * Renders a single processing-tool parameter input (layer/select/field/
 * field-weights/boolean/number/string). Shared by the Vector tools and Network
 * analysis dialogs so they stay visually and behaviorally consistent.
 *
 * @param props - The parameter, its current value, the layer/field options,
 *   and an onChange callback.
 */
export function ParameterField({
  param,
  value,
  layerOptions,
  fieldOptions,
  onChange,
}: ParameterFieldProps): ReactElement {
  const { t } = useTranslation();
  const label = (
    <Label htmlFor={param.id} className="text-xs">
      {param.label}
      {param.required ? <span className="text-destructive"> *</span> : null}
    </Label>
  );

  if (param.type === "layer") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Select
          id={param.id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t("processing.parameterField.selectLayer")}</option>
          {layerOptions.map((layer) => (
            <option key={layer.id} value={layer.id}>
              {layer.name}
            </option>
          ))}
        </Select>
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "layers") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="flex flex-col gap-1">
        {label}
        <select
          id={param.id}
          multiple
          value={selected}
          size={Math.min(Math.max(layerOptions.length, 2), 6)}
          onChange={(e) => {
            const next = Array.from(e.target.selectedOptions, (option) => option.value);
            onChange(next);
          }}
          className="flex h-auto w-full appearance-none rounded-md border border-input bg-background py-1 ps-3 pe-3 text-sm shadow-xs transition-colors focus-visible:border-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {layerOptions.map((layer) => (
            <option key={layer.id} value={layer.id}>
              {layer.name}
            </option>
          ))}
        </select>
        {selected.length ? (
          <p className="text-xs text-muted-foreground">
            {t("processing.parameterField.layersSelected", { count: selected.length })}
          </p>
        ) : null}
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "select") {
    // A required select with no default is a deliberate "you must choose"
    // (e.g. how a composite score treats missing values): show a placeholder
    // rather than letting the browser present the first option as if chosen.
    const needsPlaceholder = Boolean(param.required) && param.default === undefined;
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Select
          id={param.id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {needsPlaceholder ? (
            <option value="">{t("processing.parameterField.selectOption")}</option>
          ) : null}
          {param.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "field-weights") {
    return (
      <FieldWeightsField
        param={param}
        value={value}
        fieldOptions={fieldOptions ?? []}
        onChange={(rows: FieldWeight[]) => onChange(rows)}
      />
    );
  }

  if (param.type === "field") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Select
          id={param.id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">
            {fieldOptions?.length
              ? t("processing.parameterField.selectField")
              : t("processing.parameterField.selectLayerFirst")}
          </option>
          {fieldOptions?.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "boolean") {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm" htmlFor={param.id}>
          <input
            id={param.id}
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          {param.label}
        </label>
        {param.description ? (
          <p className="text-xs text-muted-foreground ps-6">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "number") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Input
          id={param.id}
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          min={param.min}
          max={param.max}
          step={param.step}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      </div>
    );
  }

  // string
  return (
    <div className="flex flex-col gap-1">
      {label}
      <Input
        id={param.id}
        type="text"
        value={(value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {param.description ? (
        <p className="text-xs text-muted-foreground">{param.description}</p>
      ) : null}
    </div>
  );
}
