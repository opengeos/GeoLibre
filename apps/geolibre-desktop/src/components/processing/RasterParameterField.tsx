import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { AlgorithmParameter } from "@geolibre/processing";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { FolderOpen, X } from "lucide-react";

export interface RasterParameterFieldProps {
  param: AlgorithmParameter;
  value: unknown;
  onChange: (value: unknown) => void;
  onPick: () => void;
  readOnly?: boolean;
  onClear?: () => void;
}

export function RasterParameterField({
  param,
  value,
  onChange,
  onPick,
  readOnly = false,
  onClear,
}: RasterParameterFieldProps): ReactElement {
  const { t } = useTranslation();
  const label = (
    <Label htmlFor={param.id} className="text-xs">
      {param.label}
      {param.required ? <span className="text-destructive"> *</span> : null}
    </Label>
  );

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
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

  if (param.type === "path") {
    return (
      <div className="flex flex-col gap-1">
        {label}
        <div
          className={
            onClear
              ? "grid grid-cols-[minmax(0,1fr)_2.25rem_2.25rem] gap-2"
              : "grid grid-cols-[minmax(0,1fr)_2.25rem] gap-2"
          }
        >
          <Input
            id={param.id}
            value={(value as string) ?? ""}
            placeholder={
              readOnly ? t("toolbar.rasterTool.chooseGeoTiff") : t("processing.filePicker.filePath")
            }
            readOnly={readOnly}
            onChange={readOnly ? undefined : (e) => onChange(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            title={t("processing.filePicker.chooseFile")}
            onClick={onPick}
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
          {onClear ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              title={t("common.remove")}
              onClick={onClear}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
        {param.description ? (
          <p className="text-xs text-muted-foreground">{param.description}</p>
        ) : null}
      </div>
    );
  }

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
