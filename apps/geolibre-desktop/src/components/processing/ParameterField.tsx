import type { AlgorithmParameter } from "@geolibre/processing";
import { Input, Label, Select } from "@geolibre/ui";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

export interface ParameterFieldProps {
  param: AlgorithmParameter;
  value: unknown;
  layerOptions: { id: string; name: string }[];
  /** Attribute-field names for a `type: "field"` parameter. */
  fieldOptions?: string[];
  onChange: (value: unknown) => void;
}

/**
 * Renders a single processing-tool parameter input (layer/select/field/
 * boolean/number/string). Shared by the Vector tools and Network analysis
 * dialogs so they stay visually and behaviorally consistent.
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

  if (param.type === "select") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <Select
          id={param.id}
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {param.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
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
