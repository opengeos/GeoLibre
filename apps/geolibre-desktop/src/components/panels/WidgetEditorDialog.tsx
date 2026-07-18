import type { DashboardWidget } from "@geolibre/core";
import {
  Button,
  ColorField,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
} from "@geolibre/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  categoricalColumns,
  DEFAULT_HISTOGRAM_BINS,
  MAX_HISTOGRAM_BINS,
  MIN_HISTOGRAM_BINS,
  numericColumns,
  type BarAggregation,
  type ChartType,
} from "../../lib/attribute-charts";
import { useLayerChartData } from "../../hooks/useLayerChartData";

interface WidgetEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The widget being edited, or null to create a new one. */
  widget: DashboardWidget | null;
  /** Chartable layers to choose from. */
  layers: { id: string; name: string }[];
  /** Called with the assembled widget when the user saves. */
  onSave: (widget: DashboardWidget) => void;
}

/** Keep a chosen field valid for the active layer: fall back to the first
 * available option when the saved value is not among them. */
function pick(value: string, options: string[]): string {
  return options.includes(value) ? value : (options[0] ?? "");
}

/**
 * Add or edit a dashboard chart widget: pick a layer, a chart type, and the
 * field(s) to plot. The field choices follow the selected layer and the chart
 * type, mirroring the attribute Charts dialog. A new id is minted on save for a
 * new widget; editing preserves the existing id.
 */
export function WidgetEditorDialog({
  open,
  onOpenChange,
  widget,
  layers,
  onSave,
}: WidgetEditorDialogProps) {
  const { t } = useTranslation();
  const [layerId, setLayerId] = useState("");
  const [type, setType] = useState<ChartType>("histogram");
  const [field, setField] = useState("");
  const [xField, setXField] = useState("");
  const [yField, setYField] = useState("");
  const [bins, setBins] = useState(DEFAULT_HISTOGRAM_BINS);
  const [category, setCategory] = useState("");
  const [aggregation, setAggregation] = useState<BarAggregation>("count");
  const [valueField, setValueField] = useState("");
  const [title, setTitle] = useState("");
  // "" means no custom color: fall back to the theme primary / palette.
  const [color, setColor] = useState("");

  // Seed the form when it opens, from the edited widget or sensible defaults.
  useEffect(() => {
    if (!open) return;
    setLayerId(widget?.layerId ?? layers[0]?.id ?? "");
    setType(widget?.type ?? "histogram");
    setField(widget?.field ?? "");
    setXField(widget?.xField ?? "");
    setYField(widget?.yField ?? "");
    setBins(widget?.bins ?? DEFAULT_HISTOGRAM_BINS);
    setCategory(widget?.category ?? "");
    setAggregation(widget?.aggregation ?? "count");
    setValueField(widget?.valueField ?? "");
    setTitle(widget?.title ?? "");
    setColor(widget?.color ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, widget]);

  const data = useLayerChartData(layerId);
  const numericCols = useMemo(() => numericColumns(data.rows, data.columns), [data]);
  const categoryCols = useMemo(() => categoricalColumns(data.rows, data.columns), [data]);
  const hasNumeric = numericCols.length > 0;
  const hasCategory = categoryCols.length > 0;
  const hasChartable = hasNumeric || hasCategory;

  // A widget can only be saved when its chart type has the fields it needs in
  // the chosen layer: bar/pie need a category (and a numeric field too when they
  // sum/average rather than count); scatter needs two numeric fields so x and y
  // aren't forced to the same column; the rest need one numeric field.
  const isCategorical = type === "bar" || type === "pie";
  const canSave =
    layerId !== "" &&
    (isCategorical
      ? hasCategory && (aggregation === "count" || hasNumeric)
      : type === "scatter"
        ? numericCols.length >= 2
        : hasNumeric);

  const save = () => {
    if (!canSave) return;
    const next: DashboardWidget = {
      id: widget?.id ?? crypto.randomUUID(),
      layerId,
      type,
    };
    const trimmedTitle = title.trim();
    if (trimmedTitle) next.title = trimmedTitle;
    if (color) next.color = color;
    if (type === "histogram" || type === "line" || type === "box") {
      next.field = pick(field, numericCols);
    }
    // Clicking Save can skip the bins input's onBlur, so guard the cleared/0
    // sentinel here rather than persisting an invalid bin count.
    if (type === "histogram") {
      next.bins = Math.max(MIN_HISTOGRAM_BINS, bins || MIN_HISTOGRAM_BINS);
    }
    if (type === "scatter") {
      next.xField = pick(xField, numericCols);
      next.yField = pick(yField, numericCols);
    }
    if (type === "bar" || type === "pie") {
      next.category = pick(category, categoryCols);
      // A pie shows parts of a whole, so it only counts or sums (no average).
      const agg = type === "pie" && aggregation === "mean" ? "sum" : aggregation;
      next.aggregation = agg;
      if (agg !== "count") next.valueField = pick(valueField, numericCols);
    }
    onSave(next);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {widget ? t("dashboard.editor.editTitle") : t("dashboard.editor.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("dashboard.editor.description")}</DialogDescription>
        </DialogHeader>

        {layers.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("dashboard.editor.noLayers")}
          </p>
        ) : (
          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="widget-layer">{t("dashboard.editor.layer")}</Label>
              <Select
                id="widget-layer"
                value={layerId}
                onChange={(event) => setLayerId(event.target.value)}
              >
                {layers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </Select>
            </div>

            {!hasChartable ? (
              <p className="text-sm text-muted-foreground">{t("dashboard.editor.noFields")}</p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="widget-type">{t("dashboard.editor.chartType")}</Label>
                  <Select
                    id="widget-type"
                    className="w-36"
                    value={type}
                    onChange={(event) => {
                      const nextType = event.target.value as ChartType;
                      setType(nextType);
                      // Pie has no "average"; drop a carried-over mean so the
                      // select doesn't show a stale value with no matching option.
                      if (nextType === "pie" && aggregation === "mean") {
                        setAggregation("count");
                      }
                    }}
                  >
                    <option value="histogram" disabled={!hasNumeric}>
                      {t("dashboard.chartType.histogram")}
                    </option>
                    <option value="scatter" disabled={!hasNumeric}>
                      {t("dashboard.chartType.scatter")}
                    </option>
                    <option value="bar" disabled={!hasCategory}>
                      {t("dashboard.chartType.bar")}
                    </option>
                    <option value="line" disabled={!hasNumeric}>
                      {t("dashboard.chartType.line")}
                    </option>
                    <option value="box" disabled={!hasNumeric}>
                      {t("dashboard.chartType.box")}
                    </option>
                    <option value="pie" disabled={!hasCategory}>
                      {t("dashboard.chartType.pie")}
                    </option>
                  </Select>
                </div>

                {(type === "histogram" || type === "line" || type === "box") && (
                  <FieldSelect
                    id="widget-field"
                    label={t("dashboard.editor.field")}
                    value={pick(field, numericCols)}
                    options={numericCols}
                    onChange={setField}
                  />
                )}

                {type === "histogram" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="widget-bins">{t("dashboard.editor.bins")}</Label>
                    <Input
                      id="widget-bins"
                      type="number"
                      className="w-24"
                      min={MIN_HISTOGRAM_BINS}
                      max={MAX_HISTOGRAM_BINS}
                      value={bins === 0 ? "" : bins}
                      onChange={(event) => {
                        const raw = event.target.value;
                        if (raw === "") {
                          setBins(0);
                          return;
                        }
                        const value = Number(raw);
                        if (Number.isFinite(value)) {
                          setBins(
                            Math.max(
                              MIN_HISTOGRAM_BINS,
                              Math.min(MAX_HISTOGRAM_BINS, Math.trunc(value)),
                            ),
                          );
                        }
                      }}
                      onBlur={() => {
                        if (bins < MIN_HISTOGRAM_BINS) setBins(MIN_HISTOGRAM_BINS);
                      }}
                    />
                  </div>
                )}

                {type === "scatter" && (
                  <>
                    <FieldSelect
                      id="widget-x"
                      label={t("dashboard.editor.xAxis")}
                      value={pick(xField, numericCols)}
                      options={numericCols}
                      onChange={setXField}
                    />
                    <FieldSelect
                      id="widget-y"
                      label={t("dashboard.editor.yAxis")}
                      value={pick(yField, numericCols)}
                      options={numericCols}
                      onChange={setYField}
                    />
                  </>
                )}

                {(type === "bar" || type === "pie") && (
                  <>
                    <FieldSelect
                      id="widget-category"
                      label={t("dashboard.editor.category")}
                      value={pick(category, categoryCols)}
                      options={categoryCols}
                      onChange={setCategory}
                    />
                    <div className="grid gap-1.5">
                      <Label htmlFor="widget-agg">{t("dashboard.editor.aggregate")}</Label>
                      <Select
                        id="widget-agg"
                        className="w-32"
                        value={aggregation}
                        onChange={(event) => setAggregation(event.target.value as BarAggregation)}
                      >
                        <option value="count">{t("dashboard.aggregate.count")}</option>
                        <option value="sum" disabled={!hasNumeric}>
                          {t("dashboard.aggregate.sum")}
                        </option>
                        {/* Averaging parts of a whole is meaningless for a pie. */}
                        {type !== "pie" && (
                          <option value="mean" disabled={!hasNumeric}>
                            {t("dashboard.aggregate.mean")}
                          </option>
                        )}
                      </Select>
                    </div>
                    {aggregation !== "count" && (
                      <FieldSelect
                        id="widget-value"
                        label={t("dashboard.editor.value")}
                        value={pick(valueField, numericCols)}
                        options={numericCols}
                        onChange={setValueField}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="widget-title">{t("dashboard.editor.titleLabel")}</Label>
              <Input
                id="widget-title"
                value={title}
                placeholder={t("dashboard.editor.titlePlaceholder")}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="widget-color">{t("dashboard.editor.color")}</Label>
              <div className="flex items-center gap-2">
                <ColorField
                  id="widget-color"
                  eyedropperLabel={t("common.pickColorFromScreen")}
                  fill={false}
                  className="h-8 w-12 cursor-pointer p-0.5"
                  buttonClassName="h-8 w-8"
                  // Native color inputs need a concrete value; show a neutral
                  // swatch while no custom color is set.
                  value={color || "#3fb1ce"}
                  onChange={(next) => setColor(next)}
                />
                {color ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    onClick={() => setColor("")}
                  >
                    {t("dashboard.editor.colorReset")}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("dashboard.editor.colorDefault")}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("dashboard.editor.cancel")}
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {t("dashboard.editor.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FieldSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
        className="w-44"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((col) => (
          <option key={col} value={col}>
            {col}
          </option>
        ))}
      </Select>
    </div>
  );
}
