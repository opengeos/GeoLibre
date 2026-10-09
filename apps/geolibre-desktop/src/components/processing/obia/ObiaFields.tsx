import type { ObiaRunOptions } from "@geolibre/processing";
import { Button, Input, Label } from "@geolibre/ui";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

interface ObiaNumberFieldProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max?: number;
  step: number;
}

interface ObiaNumberInputProps {
  id?: string;
  "aria-label"?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  className?: string;
}

/**
 * A number input that keeps its own text while the user types, so an
 * intermediate value ("-" on the way to "-0.1", "0" on the way to "0.5", or an
 * empty field) is not snapped back. A value within `[min, max]` is committed as
 * soon as it is typed; leaving the field restores the last committed value.
 */
export function ObiaNumberInput({
  value,
  onChange,
  min,
  max,
  ...props
}: ObiaNumberInputProps): ReactElement {
  const [text, setText] = useState(String(value));
  // Follow outside changes (a reset, another control) without clobbering typing.
  useEffect(() => {
    setText((current) => (Number(current) === value && current !== "" ? current : String(value)));
  }, [value]);
  return (
    <Input
      {...props}
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value);
        if (event.target.value === "" || !Number.isFinite(parsed)) return;
        if ((min != null && parsed < min) || (max != null && parsed > max)) return;
        onChange(parsed);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

/**
 * A labelled number input. It keeps its own text while the user types, so an
 * intermediate value ("0" on the way to "0.5", or an empty field) is not
 * snapped back; a value within `[min, max]` is committed as soon as it is
 * typed, and leaving the field restores the last committed value.
 */
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
      <ObiaNumberInput id={id} value={value} onChange={onChange} min={min} max={max} step={step} />
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

/** Whether a caught error is a user cancellation (an aborted run). */
export function isObiaCancel(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}

/**
 * Progress and cancellation for one workbench step: `begin()` returns the run
 * options to pass to the OBIA calls (a fresh AbortSignal and a step reporter),
 * `cancel()` aborts the run, and `step`/`startedAt` drive the progress line.
 */
export function useObiaRun() {
  const controllerRef = useRef<AbortController | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const begin = useCallback((): ObiaRunOptions => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStep(null);
    setStartedAt(Date.now());
    return { signal: controller.signal, onStep: setStep };
  }, []);
  const end = useCallback(() => {
    controllerRef.current = null;
    setStep(null);
    setStartedAt(null);
  }, []);
  const cancel = useCallback(() => controllerRef.current?.abort(), []);
  return useMemo(
    () => ({ step, startedAt, begin, end, cancel }),
    [step, startedAt, begin, end, cancel],
  );
}

/** "Running <tool>… 12 s" with a Cancel button, while a step runs. */
export function ObiaRunProgress({
  step,
  startedAt,
  onCancel,
}: {
  step: string | null;
  startedAt: number | null;
  onCancel: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt == null) return null;
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="obia-progress"
    >
      <span className="min-w-0 flex-1 truncate">
        {step
          ? t("obia.progress.step", { tool: step, seconds })
          : t("obia.progress.starting", { seconds })}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 px-2"
        onClick={onCancel}
      >
        <X className="h-3.5 w-3.5" />
        {t("obia.progress.cancel")}
      </Button>
    </div>
  );
}
