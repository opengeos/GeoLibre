import {
  Input,
  Label,
  Select,
  Slider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@geolibre/ui";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../../lib/clamp";

interface RuleNumberInputProps {
  label: string;
  value: number | undefined;
  min: number;
  max?: number;
  step: number;
  placeholder: string;
  onChange: (value: number | undefined) => void;
}

/** A compact numeric input where a blank value means "inherit the layer value". */
export function RuleNumberInput({
  label,
  value,
  min,
  max,
  step,
  placeholder,
  onChange,
}: RuleNumberInputProps) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        className="h-8"
        placeholder={placeholder}
        value={value ?? ""}
        aria-label={label}
        onChange={(event) => {
          const raw = event.target.value.trim();
          if (raw === "") {
            onChange(undefined);
            return;
          }
          const next = Number(raw);
          if (!Number.isFinite(next)) return;
          // Clamp into the field's domain before it reaches the store, so an
          // out-of-range typed value (e.g. a negative width) never persists.
          onChange(clamp(next, min, max ?? Number.POSITIVE_INFINITY));
        }}
      />
    </label>
  );
}

function stepPrecision(step: number): number {
  const [, decimals = ""] = String(step).split(".");
  return decimals.length;
}

interface NumericStyleInputProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  tooltip?: string;
}

export function NumericStyleInput({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  tooltip,
}: NumericStyleInputProps) {
  const { t } = useTranslation();
  const normalize = (next: number) => Number(clamp(next, min, max).toFixed(stepPrecision(step)));

  const stepValue = (direction: 1 | -1) => {
    onChange(normalize(value + direction * step));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id}>{label}</Label>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={tooltip}
                className="inline-flex cursor-help rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          className="pe-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(normalize(next));
          }}
        />
        <div className="absolute end-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
          <button
            type="button"
            className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
            aria-label={t("style.increaseValue", { label })}
            onClick={() => stepValue(1)}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
            aria-label={t("style.decreaseValue", { label })}
            onClick={() => stepValue(-1)}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface StopValueInputProps {
  index: number;
  isNumeric: boolean;
  value: string | number;
  onChange: (value: string) => void;
}

export function StopValueInput({ index, isNumeric, value, onChange }: StopValueInputProps) {
  const { t } = useTranslation();
  const label = t("style.symbology.classValue", { index: index + 1 });

  if (!isNumeric) {
    return (
      <Input
        type="text"
        aria-label={label}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const stepValue = (direction: 1 | -1) => {
    const current = Number(value);
    const next = Number.isFinite(current) ? current + direction : direction;
    onChange(String(next));
  };

  return (
    <div className="relative">
      <Input
        type="number"
        step="any"
        aria-label={label}
        className="pe-9 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="absolute end-1 top-0.5 flex h-8 w-7 flex-col overflow-hidden rounded border bg-background">
        <button
          type="button"
          className="flex h-1/2 items-center justify-center text-foreground hover:bg-accent"
          aria-label={t("style.increaseValue", { label })}
          onClick={() => stepValue(1)}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-1/2 items-center justify-center border-t text-foreground hover:bg-accent"
          aria-label={t("style.decreaseValue", { label })}
          onClick={() => stepValue(-1)}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

interface RasterStyleSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}

export function RasterStyleSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format = (next) => next.toFixed(2),
}: RasterStyleSliderProps) {
  // Double-clicking the value label (or the slider track) swaps the read-only
  // value for an inline numeric input, so users can type an exact value instead
  // of dragging to it (#832). Enter/blur commits the clamped value, Escape cancels.
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const precision = stepPrecision(step);
  // Guard so each edit session commits (or cancels) at most once: Enter and
  // Escape both tear down the input, and React still fires onBlur on the
  // unmounting element. Without this, blur would re-commit after Enter or
  // commit a cancelled draft after Escape.
  const handledRef = useRef(false);

  const commit = (raw: string) => {
    if (handledRef.current) return;
    handledRef.current = true;
    const parsed = Number(raw);
    // Treat an empty/whitespace entry like Escape: cancel rather than commit 0
    // (Number("") === 0 would otherwise silently reset the slider to its min).
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      onChange(Number(clamp(parsed, min, max).toFixed(precision)));
    }
    setEditing(false);
  };

  const cancel = () => {
    handledRef.current = true;
    setEditing(false);
  };

  const startEditing = () => {
    handledRef.current = false;
    setDraft(String(value));
    setEditing(true);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs">{label}</Label>
        {editing ? (
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            autoFocus
            aria-label={t("style.raster.valueAria", { label })}
            className="h-6 w-20 px-1.5 py-0 text-end font-mono text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit((event.target as HTMLInputElement).value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="shrink-0 cursor-text font-mono text-xs text-muted-foreground hover:text-foreground"
            title={t("style.raster.exactValueHint")}
            aria-label={t("style.raster.editValueAria", { label })}
            onDoubleClick={startEditing}
          >
            {format(value)}
          </button>
        )}
      </div>
      <Slider
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]: number[]) => {
          if (typeof next === "number") onChange(next);
        }}
        onDoubleClick={startEditing}
      />
    </div>
  );
}

interface NumericFieldSelectProps {
  id: string;
  label: string;
  value: string;
  onSelect: (property: string) => void;
  /** Label of the blank option; defaults to "None (fixed)". */
  emptyLabel?: string;
  numericPropertyOptions: string[];
}

/**
 * A picker over the layer's numeric attributes (the diagram and geometry
 * generator size fields, the heatmap weight field).
 *
 * @param props - The select's id, label, value, change handler, blank-option
 *   label and the numeric attribute candidates.
 * @returns The labelled select.
 */
export function NumericFieldSelect({
  id,
  label,
  value,
  onSelect,
  emptyLabel,
  numericPropertyOptions,
}: NumericFieldSelectProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        value={value}
        onChange={(event) => onSelect(event.target.value)}
        disabled={numericPropertyOptions.length === 0 && value === ""}
      >
        {numericPropertyOptions.length === 0 && value === "" ? (
          <option value="">{t("style.labels.noAttributes")}</option>
        ) : (
          <>
            <option value="">{emptyLabel ?? t("style.generator.fieldNone")}</option>
            {numericPropertyOptions.map((property) => (
              <option key={property} value={property}>
                {property}
              </option>
            ))}
            {/* A stored field that is not a numeric column here — a style
                pasted from another layer, a `?style=` import, or data whose
                schema changed — still renders as the selection. Without it
                the browser would fall back to "None (fixed)" while the style
                kept sizing by a field that resolves to null everywhere. */}
            {value !== "" && !numericPropertyOptions.includes(value) ? (
              <option value={value}>{value}</option>
            ) : null}
          </>
        )}
      </Select>
    </div>
  );
}
