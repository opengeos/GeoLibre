import type { LayerQuickFilter, QuickFilterKind, QuickFilterTextOperator } from "@geolibre/core";
import { Button, Input, RangeSlider, Select } from "@geolibre/ui";
import { Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  QuickFilterFieldProfile,
  QuickFilterValueCount,
} from "../../lib/quick-filter-profile";

/** Options above which the value list gets its own search box. */
const SEARCH_THRESHOLD = 8;

/** Slider positions across a numeric field's extent. */
const SLIDER_STEPS = 100;

export interface QuickFilterControlProps {
  filter: LayerQuickFilter;
  /** The field's profile, absent when the data has not been read yet. */
  profile?: QuickFilterFieldProfile;
  /** Prefix for input ids, so two panels showing the same filter stay distinct. */
  idPrefix: string;
  onChange: (next: LayerQuickFilter) => void;
  /**
   * Authoring affordances: switching the control type, muting it, and removing
   * it. Omitted in viewer mode, where a quick filter is a way of reading the
   * map rather than of editing it.
   */
  onRemove?: () => void;
}

/** Locale-aware count for the value list. */
function useCountFormatter(): Intl.NumberFormat {
  const { i18n } = useTranslation();
  return useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
}

/** Render a raw field value the way the checkbox list should label it. */
function valueLabel(value: string | number | boolean): string {
  return typeof value === "boolean" ? String(value) : String(value);
}

/**
 * A step that divides the extent into {@link SLIDER_STEPS} positions, rounded
 * to a whole number once the extent is wide enough that fractions are noise.
 */
function sliderStep(min: number, max: number): number {
  const extent = max - min;
  if (!Number.isFinite(extent) || extent <= 0) return 1;
  const raw = extent / SLIDER_STEPS;
  return raw >= 1 ? Math.max(1, Math.round(raw)) : raw;
}

/** Parse a number input, treating a blank or unparseable box as "no bound". */
function parseBound(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function CategoricalControl({
  filter,
  profile,
  idPrefix,
  onChange,
}: Pick<QuickFilterControlProps, "filter" | "profile" | "idPrefix" | "onChange">) {
  const { t } = useTranslation();
  const countFormatter = useCountFormatter();
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(filter.values ?? []), [filter.values]);

  // A value chosen before the data changed (or one outside the loaded tiles)
  // still appears, so a saved filter never silently loses part of its
  // selection just because the profile no longer lists that value.
  const options = useMemo<QuickFilterValueCount[]>(() => {
    const listed = profile?.values ?? [];
    const known = new Set(listed.map((option) => option.value));
    const extras = [...selected]
      .filter((value) => !known.has(value))
      .map((value) => ({ value, count: 0 }));
    return [...listed, ...extras];
  }, [profile?.values, selected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return options;
    return options.filter((option) => valueLabel(option.value).toLowerCase().includes(needle));
  }, [options, query]);

  const toggle = (value: string | number | boolean, checked: boolean): void => {
    const next = new Set(selected);
    if (checked) next.add(value);
    else next.delete(value);
    onChange({ ...filter, values: [...next] });
  };

  if (options.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("quickFilters.noValues")}</p>;
  }

  return (
    <div className="space-y-1.5">
      {options.length > SEARCH_THRESHOLD && (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("quickFilters.searchValues")}
          aria-label={t("quickFilters.searchValues")}
          className="h-7 text-xs"
        />
      )}
      <div
        className="max-h-44 space-y-0.5 overflow-y-auto rounded-md border border-input p-1.5"
        data-testid="quick-filter-values"
      >
        {visible.length === 0 && (
          <p className="px-1 py-0.5 text-xs text-muted-foreground">
            {t("quickFilters.noMatchingValues")}
          </p>
        )}
        {visible.map((option) => {
          const key = `${typeof option.value}:${valueLabel(option.value)}`;
          return (
            <label
              key={key}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted"
            >
              <input
                type="checkbox"
                id={`${idPrefix}-${filter.id}-${key}`}
                checked={selected.has(option.value)}
                onChange={(event) => toggle(option.value, event.target.checked)}
              />
              <span className="min-w-0 flex-1 truncate">{valueLabel(option.value)}</span>
              {option.count > 0 && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {countFormatter.format(option.count)}
                </span>
              )}
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() =>
            onChange({
              ...filter,
              values: visible.map((option) => option.value),
            })
          }
        >
          {t("quickFilters.selectAll")}
        </button>
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => onChange({ ...filter, values: [] })}
        >
          {t("quickFilters.selectNone")}
        </button>
        <span className="ms-auto text-muted-foreground">
          {selected.size === 0
            ? t("quickFilters.allValues")
            : t("quickFilters.selectedCount", { count: selected.size })}
        </span>
      </div>
    </div>
  );
}

function RangeControl({
  filter,
  profile,
  idPrefix,
  onChange,
}: Pick<QuickFilterControlProps, "filter" | "profile" | "idPrefix" | "onChange">) {
  const { t } = useTranslation();
  const bounds =
    profile && Number.isFinite(profile.min ?? NaN) && Number.isFinite(profile.max ?? NaN)
      ? { min: profile.min as number, max: profile.max as number }
      : null;

  // Writing the full extent back as an explicit bound would keep the filter
  // "on" (and so keep dropping features that have no value for the field), so
  // dragging the handles back to the ends clears the filter instead.
  const commit = (min: number | null, max: number | null): void => {
    const atExtent =
      bounds !== null && min !== null && max !== null && min <= bounds.min && max >= bounds.max;
    onChange({
      ...filter,
      min: atExtent ? null : min,
      max: atExtent ? null : max,
    });
  };

  const lower = filter.min ?? bounds?.min ?? null;
  const upper = filter.max ?? bounds?.max ?? null;

  return (
    <div className="space-y-2">
      {bounds && lower !== null && upper !== null && (
        <RangeSlider
          value={[Math.max(bounds.min, lower), Math.min(bounds.max, upper)]}
          min={bounds.min}
          max={bounds.max}
          step={sliderStep(bounds.min, bounds.max)}
          minLabel={t("quickFilters.rangeMin")}
          maxLabel={t("quickFilters.rangeMax")}
          onValueChange={([nextMin, nextMax]) => commit(nextMin, nextMax)}
        />
      )}
      <div className="flex items-center gap-2">
        <Input
          id={`${idPrefix}-${filter.id}-min`}
          type="number"
          inputMode="decimal"
          className="h-7 text-xs"
          value={filter.min ?? ""}
          placeholder={bounds ? String(bounds.min) : t("quickFilters.rangeMin")}
          aria-label={t("quickFilters.rangeMin")}
          onChange={(event) => onChange({ ...filter, min: parseBound(event.target.value) })}
        />
        <span className="text-xs text-muted-foreground">{t("quickFilters.rangeSeparator")}</span>
        <Input
          id={`${idPrefix}-${filter.id}-max`}
          type="number"
          inputMode="decimal"
          className="h-7 text-xs"
          value={filter.max ?? ""}
          placeholder={bounds ? String(bounds.max) : t("quickFilters.rangeMax")}
          aria-label={t("quickFilters.rangeMax")}
          onChange={(event) => onChange({ ...filter, max: parseBound(event.target.value) })}
        />
      </div>
    </div>
  );
}

function DateControl({
  filter,
  profile,
  idPrefix,
  onChange,
}: Pick<QuickFilterControlProps, "filter" | "profile" | "idPrefix" | "onChange">) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Input
        id={`${idPrefix}-${filter.id}-start`}
        type="date"
        className="h-7 text-xs"
        min={profile?.minDate}
        max={profile?.maxDate}
        value={filter.start ?? ""}
        aria-label={t("quickFilters.dateFrom")}
        onChange={(event) => onChange({ ...filter, start: event.target.value || null })}
      />
      <span className="text-xs text-muted-foreground">{t("quickFilters.rangeSeparator")}</span>
      <Input
        id={`${idPrefix}-${filter.id}-end`}
        type="date"
        className="h-7 text-xs"
        min={profile?.minDate}
        max={profile?.maxDate}
        value={filter.end ?? ""}
        aria-label={t("quickFilters.dateTo")}
        onChange={(event) => onChange({ ...filter, end: event.target.value || null })}
      />
    </div>
  );
}

const TEXT_OPERATORS: QuickFilterTextOperator[] = ["contains", "startsWith", "equals"];

function TextControl({
  filter,
  idPrefix,
  onChange,
}: Pick<QuickFilterControlProps, "filter" | "idPrefix" | "onChange">) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Select
        className="w-32 shrink-0"
        value={filter.operator ?? "contains"}
        aria-label={t("quickFilters.textOperator")}
        onChange={(event) =>
          onChange({
            ...filter,
            operator: event.target.value as QuickFilterTextOperator,
          })
        }
      >
        {TEXT_OPERATORS.map((operator) => (
          <option key={operator} value={operator}>
            {t(`quickFilters.operator.${operator}` as const)}
          </option>
        ))}
      </Select>
      <Input
        id={`${idPrefix}-${filter.id}-text`}
        className="h-7 text-xs"
        value={filter.text ?? ""}
        placeholder={t("quickFilters.textPlaceholder")}
        aria-label={t("quickFilters.textValue")}
        onChange={(event) => onChange({ ...filter, text: event.target.value })}
      />
    </div>
  );
}

/** Every control kind, for the authoring type switcher. */
const KIND_ORDER: QuickFilterKind[] = ["categorical", "range", "date", "text"];

/**
 * One quick-filter control: the header naming its field plus whichever input
 * the field's profile calls for.
 *
 * The same component renders in the Style panel (with the affordances to change
 * the control type and remove it) and in the viewer's layer panel (without
 * them), so a filter behaves identically wherever it is answered.
 */
export function QuickFilterControl({
  filter,
  profile,
  idPrefix,
  onChange,
  onRemove,
}: QuickFilterControlProps) {
  const { t } = useTranslation();
  const editable = onRemove !== undefined;
  const kinds = profile?.availableKinds ?? KIND_ORDER;
  const enabled = filter.enabled !== false;

  const clear = (): void =>
    onChange({
      ...filter,
      values: [],
      min: null,
      max: null,
      start: null,
      end: null,
      text: "",
    });

  const hasValue =
    (filter.values?.length ?? 0) > 0 ||
    filter.min != null ||
    filter.max != null ||
    !!filter.start ||
    !!filter.end ||
    (filter.text ?? "").trim() !== "";

  return (
    <div className="space-y-1.5 rounded-md border border-input p-2" data-testid="quick-filter">
      <div className="flex items-center gap-2">
        {editable && (
          <input
            type="checkbox"
            checked={enabled}
            title={t("quickFilters.enabledTitle")}
            aria-label={t("quickFilters.enabledTitle")}
            onChange={(event) => onChange({ ...filter, enabled: event.target.checked })}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={filter.field}>
          {filter.field}
        </span>
        {hasValue && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            title={t("quickFilters.clearOne")}
            aria-label={t("quickFilters.clearOneNamed", {
              field: filter.field,
            })}
            onClick={clear}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        {editable && (
          <>
            {kinds.length > 1 && (
              <Select
                className="w-28 shrink-0"
                value={filter.kind}
                aria-label={t("quickFilters.controlType")}
                onChange={(event) =>
                  onChange({
                    ...filter,
                    kind: event.target.value as QuickFilterKind,
                    // The chosen values belong to the old control, so switching
                    // type starts from "no constraint" rather than carrying a
                    // selection the new control cannot show.
                    values: [],
                    min: null,
                    max: null,
                    start: null,
                    end: null,
                    text: "",
                  })
                }
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`quickFilters.kind.${kind}` as const)}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0"
              title={t("quickFilters.remove")}
              aria-label={t("quickFilters.removeNamed", {
                field: filter.field,
              })}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>
      <div className={enabled ? undefined : "pointer-events-none opacity-50"}>
        {filter.kind === "categorical" && (
          <CategoricalControl
            filter={filter}
            profile={profile}
            idPrefix={idPrefix}
            onChange={onChange}
          />
        )}
        {filter.kind === "range" && (
          <RangeControl filter={filter} profile={profile} idPrefix={idPrefix} onChange={onChange} />
        )}
        {filter.kind === "date" && (
          <DateControl filter={filter} profile={profile} idPrefix={idPrefix} onChange={onChange} />
        )}
        {filter.kind === "text" && (
          <TextControl filter={filter} idPrefix={idPrefix} onChange={onChange} />
        )}
      </div>
    </div>
  );
}
