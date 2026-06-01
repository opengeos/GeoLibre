import { useAppStore } from "@geolibre/core";
import {
  Button,
  Input,
  ScrollArea,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@geolibre/ui";
import type { Feature } from "geojson";
import {
  ArrowDown,
  ArrowUp,
  PanelBottomClose,
  PanelBottomOpen,
  TableProperties,
  X,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useRef,
  useState,
} from "react";
import { isTauri } from "../../lib/tauri-io";

type SortDirection = "asc" | "desc";
type SortKey = "__featureId" | string;
type ColumnWidths = Record<string, number>;

const DEFAULT_FEATURE_ID_COLUMN_WIDTH = 72;
const DEFAULT_ATTRIBUTE_COLUMN_WIDTH = 160;
const MIN_FEATURE_ID_COLUMN_WIDTH = 48;
const MAX_FEATURE_ID_COLUMN_WIDTH = 180;
const MIN_ATTRIBUTE_COLUMN_WIDTH = 72;
const MAX_ATTRIBUTE_COLUMN_WIDTH = 520;
const DEFAULT_TABLE_HEIGHT = 192;
const MIN_TABLE_HEIGHT = 96;
const MAX_TABLE_HEIGHT = 520;
const PANEL_RESIZE_START_EVENT = "geolibre:panel-resize-start";
const PANEL_RESIZE_END_EVENT = "geolibre:panel-resize-end";

function compareAttributeValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;

  if (typeof a === "number" && typeof b === "number") return a - b;

  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
    return aNumber - bNumber;
  }

  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function AttributeTable() {
  const tableSectionRef = useRef<HTMLElement>(null);
  const tableResizeGuideRef = useRef<HTMLDivElement>(null);
  const selectedLayerId = useAppStore((s) => s.selectedLayerId);
  const layers = useAppStore((s) => s.layers);
  const attributeFilter = useAppStore((s) => s.attributeFilter);
  const setAttributeFilter = useAppStore((s) => s.setAttributeFilter);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const selectFeature = useAppStore((s) => s.selectFeature);
  const attributeTableOpen = useAppStore((s) => s.ui.attributeTableOpen);
  const setAttributeTableOpen = useAppStore((s) => s.setAttributeTableOpen);
  const zoomToSelectedFeature = useAppStore(
    (s) => s.ui.zoomToSelectedFeature,
  );
  const setZoomToSelectedFeature = useAppStore(
    (s) => s.setZoomToSelectedFeature,
  );
  const [sort, setSort] = useState<{
    key: SortKey;
    direction: SortDirection;
  }>({
    key: "__featureId",
    direction: "asc",
  });
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({});
  const [tableHeight, setTableHeight] = useState(DEFAULT_TABLE_HEIGHT);
  const deferTableResize = isTauri();

  const layer = layers.find((l) => l.id === selectedLayerId);
  const features = layer?.geojson?.features ?? [];

  const filterLower = attributeFilter.toLowerCase();
  const indexedFeatures = features.map((feature, index) => ({
    feature,
    featureId: String(feature.id ?? index),
  }));
  const filtered = indexedFeatures.filter(({ feature, featureId }) => {
    if (!filterLower) return true;
    const props = JSON.stringify(feature.properties ?? {}).toLowerCase();
    return featureId.includes(filterLower) || props.includes(filterLower);
  });
  const sorted = [...filtered].sort((a, b) => {
    const aValue =
      sort.key === "__featureId"
        ? a.featureId
        : a.feature.properties?.[sort.key];
    const bValue =
      sort.key === "__featureId"
        ? b.featureId
        : b.feature.properties?.[sort.key];
    const result = compareAttributeValues(aValue, bValue);
    return sort.direction === "asc" ? result : -result;
  });

  const propKeys = new Set<string>();
  for (const f of features) {
    if (f.properties) {
      for (const k of Object.keys(f.properties)) propKeys.add(k);
    }
  }
  const columns = Array.from(propKeys).slice(0, 8);
  const tableColumns = ["__featureId", ...columns];

  const columnWidth = (key: SortKey) =>
    columnWidths[key] ??
    (key === "__featureId"
      ? DEFAULT_FEATURE_ID_COLUMN_WIDTH
      : DEFAULT_ATTRIBUTE_COLUMN_WIDTH);

  const columnWidthLimits = (key: SortKey) =>
    key === "__featureId"
      ? {
          max: MAX_FEATURE_ID_COLUMN_WIDTH,
          min: MIN_FEATURE_ID_COLUMN_WIDTH,
        }
      : {
          max: MAX_ATTRIBUTE_COLUMN_WIDTH,
          min: MIN_ATTRIBUTE_COLUMN_WIDTH,
        };

  const startColumnResize = (
    key: SortKey,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = columnWidth(key);
    const { min, max } = columnWidthLimits(key);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(
        max,
        Math.max(min, startWidth + moveEvent.clientX - startX),
      );
      setColumnWidths((current) => ({ ...current, [key]: nextWidth }));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const startTableResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const startY = event.clientY;
    const startHeight = tableHeight;
    let nextHeight = startHeight;
    let resizeFrame: number | null = null;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMouseMove = (moveEvent: MouseEvent) => {
      const availableHeight = Math.max(
        MIN_TABLE_HEIGHT,
        window.innerHeight - 180,
      );
      const maxHeight = Math.min(MAX_TABLE_HEIGHT, availableHeight);
      nextHeight = Math.min(
        maxHeight,
        Math.max(MIN_TABLE_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        if (deferTableResize) {
          if (tableResizeGuideRef.current) {
            tableResizeGuideRef.current.style.top = `${
              startY + startHeight - nextHeight
            }px`;
            tableResizeGuideRef.current.classList.remove("hidden");
          }
          return;
        }
        if (tableSectionRef.current) {
          tableSectionRef.current.style.height = `${nextHeight}px`;
        }
      });
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      if (tableSectionRef.current) {
        tableSectionRef.current.style.height = `${nextHeight}px`;
      }
      tableResizeGuideRef.current?.classList.add("hidden");
      setTableHeight(nextHeight);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const toggleSort = (key: SortKey) => {
    setSort((current) => ({
      key,
      direction:
        current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };

  const renderSortIcon = (key: SortKey) => {
    if (sort.key !== key) return null;
    return sort.direction === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    );
  };

  const sortableHeader = (key: SortKey, label: string) => (
    <div className="relative flex h-full min-h-10 items-center">
      <button
        type="button"
        className="flex h-full min-w-0 flex-1 items-center gap-1 pr-3 text-left font-medium"
        onClick={() => toggleSort(key)}
      >
        <span className="truncate">{label}</span>
        {renderSortIcon(key)}
      </button>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} column`}
        className="absolute -right-2 top-0 h-full w-3 cursor-col-resize select-none border-r border-transparent hover:border-primary"
        onMouseDown={(event) => startColumnResize(key, event)}
      />
    </div>
  );

  if (!attributeTableOpen) {
    return (
      <section className="flex h-11 shrink-0 items-center gap-2 border-t bg-card px-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Expand attribute table"
          aria-label="Expand attribute table"
          onClick={() => setAttributeTableOpen(true)}
        >
          <PanelBottomOpen className="h-4 w-4" />
        </Button>
        <TableProperties className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Attribute table
        </span>
      </section>
    );
  }

  return (
    <section
      ref={tableSectionRef}
      className="relative flex shrink-0 flex-col border-t bg-card"
      style={{ height: tableHeight }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize attribute table"
        className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-row-resize select-none border-t border-transparent hover:border-primary"
        onMouseDown={startTableResize}
      />
      <div
        ref={tableResizeGuideRef}
        className="pointer-events-none fixed left-0 right-0 z-50 hidden h-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.25)]"
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Collapse attribute table"
          aria-label="Collapse attribute table"
          onClick={() => setAttributeTableOpen(false)}
        >
          <PanelBottomClose className="h-4 w-4" />
        </Button>
        <TableProperties className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Attribute table</span>
        {layer ? (
          <span className="text-xs text-muted-foreground">— {layer.name}</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            — select a vector layer
          </span>
        )}
        <Input
          className="ml-auto h-7 max-w-xs text-xs"
          placeholder="Search attributes…"
          aria-label="Search attributes"
          value={attributeFilter}
          onChange={(e) => setAttributeFilter(e.target.value)}
        />
        <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={zoomToSelectedFeature}
            onChange={(event) =>
              setZoomToSelectedFeature(event.target.checked)
            }
          />
          Zoom to selection
        </label>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Clear selected feature"
          aria-label="Clear selected feature"
          disabled={!selectedFeatureId}
          onClick={() => selectFeature(null)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea
        type="always"
        className="flex-1 [&_[data-orientation=vertical]]:!top-11 [&_[data-orientation=vertical]]:!h-[calc(100%-2.75rem)]"
      >
        {!layer?.geojson ? (
          <p className="p-4 text-xs text-muted-foreground">
            Attribute table requires a vector layer.
          </p>
        ) : (
          <table className="min-w-full table-fixed caption-bottom text-sm">
            <colgroup>
              {tableColumns.map((col) => (
                <col key={col} style={{ width: columnWidth(col) }} />
              ))}
            </colgroup>
            <TableHeader className="sticky top-0 z-10 bg-card shadow-sm">
              <TableRow>
                <TableHead className="bg-card">
                  {sortableHeader("__featureId", "#")}
                </TableHead>
                {columns.map((col) => (
                  <TableHead key={col} className="bg-card">
                    {sortableHeader(col, col)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(({ feature, featureId }: {
                feature: Feature;
                featureId: string;
              }) => {
                const selected = selectedFeatureId === featureId;
                return (
                  <TableRow
                    key={featureId}
                    data-state={selected ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => {
                      selectFeature(featureId);
                    }}
                  >
                    <TableCell>{featureId}</TableCell>
                    {columns.map((col) => (
                      <TableCell key={col}>
                        {String(feature.properties?.[col] ?? "")}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </table>
        )}
      </ScrollArea>
    </section>
  );
}
