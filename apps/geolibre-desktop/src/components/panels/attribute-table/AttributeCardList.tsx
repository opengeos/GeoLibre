import { cn } from "@geolibre/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ZoomIn } from "lucide-react";
import { useEffect, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";

export interface AttributeCardRow {
  featureId: string;
  properties: Record<string, unknown>;
}

export interface AttributeCardListProps {
  rows: readonly AttributeCardRow[];
  columns: readonly string[];
  selectedIds: ReadonlySet<string>;
  activeFeatureId: string | null;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  sortKey: string;
  sortDirection: "asc" | "desc";
  onChangeSortKey: (key: string) => void;
  onToggleSortDirection: () => void;
  onSelectRow: (featureId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onZoomRow: (featureId: string) => void;
}

const MAX_PREVIEW_FIELDS = 4;
const SORT_BAR_HEIGHT_PX = 48;

function formatCardValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Virtualized card list alternative to the wide desktop attribute grid for
 * touch phones (GeoLibre#3537 Phase 4). Displays a compact sort control bar,
 * each feature's title and top fields as a native selectable button, and a
 * sibling 44px Zoom-to-feature button (avoiding nested interactive controls).
 */
export function AttributeCardList({
  rows,
  columns,
  selectedIds,
  activeFeatureId,
  scrollElementRef,
  sortKey,
  sortDirection,
  onChangeSortKey,
  onToggleSortDirection,
  onSelectRow,
  onZoomRow,
}: AttributeCardListProps) {
  const { t } = useTranslation();
  const titleColumn =
    columns.find((col) => /^(name|title|label|id)$/i.test(col)) ?? columns[0] ?? null;
  const previewColumns = columns.filter((col) => col !== titleColumn).slice(0, MAX_PREVIEW_FIELDS);

  const cardVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => (previewColumns.length > 0 ? 136 : 76),
    getItemKey: (index) => rows[index].featureId,
    scrollMargin: SORT_BAR_HEIGHT_PX,
    overscan: 6,
  });

  const activeIndex =
    activeFeatureId === null ? -1 : rows.findIndex((row) => row.featureId === activeFeatureId);

  useEffect(() => {
    if (activeIndex >= 0) {
      cardVirtualizer.scrollToIndex(activeIndex, { align: "auto" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, activeFeatureId]);

  if (rows.length === 0) {
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {t("mobileShell.attributeCards.empty")}
      </p>
    );
  }

  const virtualItems = cardVirtualizer.getVirtualItems();

  return (
    <div data-testid="attribute-card-list" className="w-full">
      <div className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/95 px-2.5 backdrop-blur">
        <select
          aria-label={t("mobileShell.attributeCards.sortBy")}
          value={sortKey}
          onChange={(event) => onChangeSortKey(event.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs text-foreground"
        >
          <option value="__featureId">{t("mobileShell.attributeCards.featureIdOption")}</option>
          {columns.map((col) => (
            <option key={col} value={col}>
              {col}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onToggleSortDirection}
          aria-label={
            sortDirection === "asc"
              ? t("mobileShell.attributeCards.sortDescending")
              : t("mobileShell.attributeCards.sortAscending")
          }
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground hover:bg-accent hover:text-foreground active:bg-accent"
        >
          {sortDirection === "asc" ? (
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      <div
        className="relative w-full"
        style={{ height: `${cardVirtualizer.getTotalSize() + 24}px` }}
      >
        {virtualItems.map((virtualItem) => {
          const { featureId, properties } = rows[virtualItem.index];
          const selected = selectedIds.has(featureId);
          const primaryValue = titleColumn ? properties[titleColumn] : null;
          const formattedPrimary = formatCardValue(primaryValue).trim();
          const heading =
            formattedPrimary !== "" && formattedPrimary !== "—"
              ? formattedPrimary
              : `#${featureId}`;
          return (
            <div
              key={featureId}
              data-index={virtualItem.index}
              ref={cardVirtualizer.measureElement}
              className="absolute inset-x-0 top-0 px-2.5 pb-2"
              style={{
                transform: `translateY(${virtualItem.start - cardVirtualizer.options.scrollMargin + 10}px)`,
              }}
            >
              <div
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-3 transition-colors",
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card hover:bg-accent/40",
                )}
              >
                <button
                  type="button"
                  aria-label={heading}
                  aria-pressed={selected}
                  onClick={(event) => onSelectRow(featureId, event)}
                  className="min-w-0 flex-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {heading}
                  </span>
                  {titleColumn ? (
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      #{featureId}
                    </span>
                  ) : null}
                  {previewColumns.length > 0 ? (
                    <span className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-2 text-xs">
                      {previewColumns.map((col) => (
                        <span key={col} className="block min-w-0">
                          <span className="block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                            {col}
                          </span>
                          <span className="block truncate font-medium text-foreground">
                            {formatCardValue(properties[col])}
                          </span>
                        </span>
                      ))}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-label={t("mobileShell.attributeCards.zoomToFeature")}
                  title={t("mobileShell.attributeCards.zoomToFeature")}
                  onClick={() => onZoomRow(featureId)}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
                >
                  <ZoomIn className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
