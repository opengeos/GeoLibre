import type { DashboardWidget } from "@geolibre/core";
import { useAppStore } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import {
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { isChartableLayer, useLayerChartData } from "../../hooks/useLayerChartData";
import {
  ChartView,
  computeChart,
  type ChartSpec,
} from "./charts/chart-view";
import { WidgetEditorDialog } from "./WidgetEditorDialog";

const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";
const MIN_DASHBOARD_HEIGHT = 160;
const MAX_DASHBOARD_HEIGHT = 720;
const DEFAULT_DASHBOARD_HEIGHT = 360;

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
  const setDashboardOpen = useAppStore((s) => s.setDashboardOpen);
  const addWidget = useAppStore((s) => s.addWidget);
  const updateWidget = useAppStore((s) => s.updateWidget);
  const removeWidget = useAppStore((s) => s.removeWidget);
  const moveWidget = useAppStore((s) => s.moveWidget);

  const sectionRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [height, setHeight] = useState(DEFAULT_DASHBOARD_HEIGHT);
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

  return (
    <section
      ref={sectionRef}
      style={{ height }}
      className="relative flex shrink-0 flex-col border-t bg-card"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("dashboard.resize")}
        className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startResize}
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("dashboard.title")}</span>
        <span className="text-xs text-muted-foreground">
          {t("dashboard.widgetCount", { count: widgets.length })}
        </span>
        <div className="ml-auto flex items-center gap-1">
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

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {widgets.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <p className="text-sm text-muted-foreground">
              {chartableLayers.length === 0
                ? t("dashboard.emptyNoLayers")
                : t("dashboard.empty")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
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
  const result = useMemo(
    () => computeChart(data.rows, widgetToSpec(widget)),
    [data.rows, widget],
  );
  const title = widget.title?.trim() || defaultWidgetTitle();

  /** A readable title from the widget's chart type and fields when untitled. */
  function defaultWidgetTitle(): string {
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
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-background p-3">
      <div className="flex items-center gap-2">
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
            <ChevronLeft className="h-3.5 w-3.5" />
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
            <ChevronRight className="h-3.5 w-3.5" />
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

      {data.hasData ? (
        <ChartView result={result} />
      ) : (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {t("dashboard.noData")}
        </p>
      )}
    </div>
  );
}
