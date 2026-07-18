import type { DashboardWidget } from "@geolibre/core";
import { MAX_DASHBOARD_COLUMNS, MIN_DASHBOARD_COLUMNS, useAppStore } from "@geolibre/core";
import { Button, Select } from "@geolibre/ui";
import {
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  PanelBottomClose,
  PanelBottomOpen,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isChartableLayer, useLayerChartData } from "../../hooks/useLayerChartData";
import { ChartView, computeChart, type ChartSpec } from "./charts/chart-view";
import { WidgetEditorDialog } from "./WidgetEditorDialog";
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";

const MIN_DASHBOARD_HEIGHT = 160;
const MAX_DASHBOARD_HEIGHT = 720;
const DEFAULT_DASHBOARD_HEIGHT = 360;
// Per-row floor once widgets wrap onto multiple rows; below it the panel
// scrolls instead of crushing the charts. A single row has no floor, so it
// fills and resizes with the panel height (issue #728).
const MIN_DASHBOARD_ROW_HEIGHT = 200;

/** Turn a stored widget into the render-side {@link ChartSpec}. */
function widgetToSpec(widget: DashboardWidget): ChartSpec {
  return {
    type: widget.type,
    field: widget.field,
    xField: widget.xField,
    yField: widget.yField,
    bins: widget.bins,
    category: widget.category,
    aggregation: widget.aggregation,
    valueField: widget.valueField,
  };
}

/**
 * The Dashboard panel: a bottom-docked, resizable strip of chart widgets, each
 * bound to a layer and field(s), in the spirit of CARTO Builder / Foursquare
 * Studio (issue #401). Widgets are stored in the project, so a dashboard
 * reopens intact. Rendered only while open. Charts are read-only summaries
 * here; cross-filtering the map is intentionally out of scope for now.
 */
export function DashboardPanel() {
  const { t } = useTranslation();
  const widgets = useAppStore((s) => s.widgets);
  const layers = useAppStore((s) => s.layers);
  const columns = useAppStore((s) => s.dashboardColumns);
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const setDashboardColumns = useAppStore((s) => s.setDashboardColumns);
  const addWidget = useAppStore((s) => s.addWidget);
  const updateWidget = useAppStore((s) => s.updateWidget);
  const removeWidget = useAppStore((s) => s.removeWidget);
  const moveWidget = useAppStore((s) => s.moveWidget);

  // Choices for the column-count picker, derived from the supported range.
  const columnOptions = useMemo(() => {
    const values: number[] = [];
    for (let n = MIN_DASHBOARD_COLUMNS; n <= MAX_DASHBOARD_COLUMNS; n += 1) {
      values.push(n);
    }
    return values;
  }, []);

  const sectionRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(DEFAULT_DASHBOARD_HEIGHT);
  // Collapse the panel to just its header bar for a full map view, without
  // losing the last height (issue #459). The height is kept in state so an
  // expand restores the panel to exactly the size the user last dragged it to.
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DashboardWidget | null>(null);

  // Layers that expose chartable attributes, for the editor's layer picker.
  const chartableLayers = useMemo(
    () =>
      layers
        .filter((layer) => isChartableLayer(layer))
        .map((layer) => ({ id: layer.id, name: layer.name })),
    [layers],
  );

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = height;
    let nextHeight = startHeight;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMove = (moveEvent: MouseEvent) => {
      const available = Math.max(MIN_DASHBOARD_HEIGHT, window.innerHeight - 180);
      const maxHeight = Math.min(MAX_DASHBOARD_HEIGHT, available);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_DASHBOARD_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (sectionRef.current) {
          sectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    const onUp = () => {
      cleanup();
      resizeCleanupRef.current = null;
      setHeight(nextHeight);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    resizeCleanupRef.current = cleanup;
  };

  // Tear down an in-flight drag if the panel unmounts mid-resize.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const openAdd = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (widget: DashboardWidget) => {
    setEditing(widget);
    setEditorOpen(true);
  };
  const handleSave = (widget: DashboardWidget) => {
    if (widgets.some((w) => w.id === widget.id)) {
      const { id: _id, ...patch } = widget;
      updateWidget(widget.id, patch);
    } else {
      addWidget(widget);
    }
  };

  // When widgets wrap onto multiple rows, floor the grid height (rows plus the
  // gap-3 gaps between them) so it scrolls rather than crushing the charts; a
  // single row stays unbounded and fills the panel (issue #728). calc() lets
  // the browser resolve 0.75rem so the gap tracks the root font size.
  const rowCount = Math.max(1, Math.ceil(widgets.length / Math.max(1, columns)));
  const gridMinHeight =
    rowCount > 1
      ? // 0.75rem is gap-3; keep in sync if the grid's gap class changes.
        `calc(${rowCount} * ${MIN_DASHBOARD_ROW_HEIGHT}px + ${rowCount - 1} * 0.75rem)`
      : undefined;

  return (
    <section
      ref={sectionRef}
      style={isCollapsed ? undefined : { height }}
      className="relative flex shrink-0 flex-col border-t bg-card"
    >
      {!isCollapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("dashboard.resize")}
          aria-valuenow={Math.round(height)}
          aria-valuemin={MIN_DASHBOARD_HEIGHT}
          aria-valuemax={MAX_DASHBOARD_HEIGHT}
          tabIndex={0}
          className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary focus-visible:border-primary focus-visible:outline-none"
          onMouseDown={startResize}
          onKeyDown={(event) => {
            // Arrow keys resize for keyboard-only users (Shift = larger step).
            const step = event.shiftKey ? 24 : 8;
            if (event.key === "ArrowUp") {
              setHeight((h) => Math.min(MAX_DASHBOARD_HEIGHT, h + step));
            } else if (event.key === "ArrowDown") {
              setHeight((h) => Math.max(MIN_DASHBOARD_HEIGHT, h - step));
            } else {
              return;
            }
            event.preventDefault();
          }}
        />
      ) : null}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("dashboard.title")}</span>
        <span className="text-xs text-muted-foreground">
          {t("dashboard.widgetCount", { count: widgets.length })}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {!isCollapsed && widgets.length > 0 ? (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="hidden sm:inline">{t("dashboard.columns")}</span>
              <Select
                aria-label={t("dashboard.columns")}
                className="h-8 w-16"
                value={String(columns)}
                onChange={(event) => setDashboardColumns(Number(event.target.value))}
              >
                {columnOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {!isCollapsed ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-2"
              onClick={openAdd}
              disabled={chartableLayers.length === 0}
              title={
                chartableLayers.length === 0
                  ? t("dashboard.noLayersHint")
                  : t("dashboard.addWidget")
              }
            >
              <Plus className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("dashboard.addWidget")}</span>
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={isCollapsed ? t("dashboard.expand") : t("dashboard.collapse")}
            title={isCollapsed ? t("dashboard.expand") : t("dashboard.collapse")}
            onClick={() => setIsCollapsed((c) => !c)}
          >
            {isCollapsed ? (
              <PanelBottomOpen className="h-4 w-4" />
            ) : (
              <PanelBottomClose className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={t("dashboard.close")}
            title={t("dashboard.close")}
            onClick={() => setDashboardOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {!isCollapsed ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          {widgets.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-muted-foreground">
                {chartableLayers.length === 0 ? t("dashboard.emptyNoLayers") : t("dashboard.empty")}
              </p>
            </div>
          ) : (
            <div
              className="grid h-full gap-3"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                // Equal-height rows that shrink with the panel (issue #728).
                gridAutoRows: "minmax(0, 1fr)",
                minHeight: gridMinHeight,
              }}
            >
              {widgets.map((widget, index) => (
                <WidgetCard
                  key={widget.id}
                  widget={widget}
                  index={index}
                  count={widgets.length}
                  onEdit={() => openEdit(widget)}
                  onRemove={() => removeWidget(widget.id)}
                  onMove={(toIndex) => moveWidget(widget.id, toIndex)}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      <WidgetEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        widget={editing}
        layers={chartableLayers}
        onSave={handleSave}
      />
    </section>
  );
}

function WidgetCard({
  widget,
  index,
  count,
  onEdit,
  onRemove,
  onMove,
}: {
  widget: DashboardWidget;
  index: number;
  count: number;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (toIndex: number) => void;
}) {
  const { t } = useTranslation();
  const data = useLayerChartData(widget.layerId);
  const result = useMemo(() => computeChart(data.rows, widgetToSpec(widget)), [data.rows, widget]);
  // A readable title from the widget's chart type and fields when untitled.
  const defaultWidgetTitle = (): string => {
    switch (widget.type) {
      case "histogram":
        return `${t("dashboard.chartType.histogram")} · ${widget.field ?? ""}`;
      case "scatter":
        return `${widget.yField ?? ""} / ${widget.xField ?? ""}`;
      case "bar": {
        const agg =
          widget.aggregation === "sum"
            ? t("dashboard.aggregate.sum")
            : widget.aggregation === "mean"
              ? t("dashboard.aggregate.mean")
              : t("dashboard.aggregate.count");
        return `${agg} · ${widget.category ?? ""}`;
      }
      case "line":
        return `${t("dashboard.chartType.line")} · ${widget.field ?? ""}`;
      case "box":
        return `${t("dashboard.chartType.box")} · ${widget.field ?? ""}`;
      case "pie":
        return `${t("dashboard.chartType.pie")} · ${widget.category ?? ""}`;
    }
  };
  const title = widget.title?.trim() || defaultWidgetTitle();

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-md border bg-background p-3">
      <div className="flex shrink-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={title}>
            {title}
          </div>
          <div className="truncate text-xs text-muted-foreground" title={data.layerName}>
            {data.hasData ? data.layerName : t("dashboard.layerMissing")}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("dashboard.moveBack")}
            title={t("dashboard.moveBack")}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("dashboard.moveForward")}
            title={t("dashboard.moveForward")}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("dashboard.editWidget")}
            title={t("dashboard.editWidget")}
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t("dashboard.removeWidget")}
            title={t("dashboard.removeWidget")}
            onClick={onRemove}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* [&>svg] targets ChartView's chart SVG, which is a direct DOM child
          (React Fragments emit no nodes): it flexes to fill, min-h-0 lets it
          shrink past its intrinsic aspect-ratio height, and preserveAspectRatio
          letterboxes it. Update this if a chart ever wraps its SVG (issue #728). */}
      <div className="flex min-h-0 flex-1 flex-col [&>svg]:min-h-0 [&>svg]:flex-1">
        {data.hasData ? (
          <ChartView result={result} color={widget.color} />
        ) : (
          <p className="flex flex-1 items-center justify-center py-4 text-center text-xs text-muted-foreground">
            {t("dashboard.noData")}
          </p>
        )}
      </div>
    </div>
  );
}
