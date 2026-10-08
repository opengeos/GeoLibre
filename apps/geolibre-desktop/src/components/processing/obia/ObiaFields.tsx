import { Input, Label } from "@geolibre/ui";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

interface ObiaNumberFieldProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max?: number;
  step: number;
}

/** A labelled number input that ignores values outside `[min, max]`. */
export function ObiaNumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
}: ObiaNumberFieldProps): ReactElement {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={String(value)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isFinite(parsed) || parsed < min) return;
          onChange(max != null ? Math.min(max, parsed) : parsed);
        }}
      />
    </div>
  );
}

/** A workbench step heading, e.g. "1. Segment". */
export function ObiaStepHeading({ index, title }: { index: number; title: string }): ReactElement {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {index}. {title}
    </h3>
  );
}

/** A step's error or success line. */
export function ObiaStatus({
  error,
  success,
  testId,
}: {
  error: string | null;
  success?: ReactNode;
  testId?: string;
}): ReactElement | null {
  if (error) {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        {error}
      </p>
    );
  }
  if (!success) return null;
  return (
    <p
      className="flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-400"
      data-testid={testId}
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      {success}
    </p>
  );
}
