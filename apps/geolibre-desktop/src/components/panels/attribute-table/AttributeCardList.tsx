import { cn } from "@geolibre/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ZoomIn } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";

export interface AttributeCardRow {
  featureId: string;
  properties: Record<string, unknown>;
}

export interface AttributeCardListProps {
  rows: readonly AttributeCardRow[];
  columns: readonly string[];
  selectedIds: ReadonlySet<string>;
  scrollElementRef: RefObject<HTMLDivElement | null>;
  onSelectRow: (featureId: string, event: ReactMouseEvent<HTMLElement>) => void;
  onZoomRow: (featureId: string) => void;
}

const MAX_PREVIEW_FIELDS = 4;

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
 * touch phones (GeoLibre#3537 Phase 4). Displays each feature's title, top
 * fields, and a 44px Zoom-to-feature action while only mounting visible cards.
 */
export function AttributeCardList({
  rows,
  columns,
  selectedIds,
  scrollElementRef,
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
    overscan: 6,
  });

  if (rows.length === 0) {
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {t("mobileShell.attributeCards.empty")}
      </p>
    );
  }

  const virtualItems = cardVirtualizer.getVirtualItems();

  return (
    <div
      data-testid="attribute-card-list"
      className="relative w-full"
      style={{ height: `${cardVirtualizer.getTotalSize() + 24}px` }}
    >
      {virtualItems.map((virtualItem) => {
        const { featureId, properties } = rows[virtualItem.index];
        const selected = selectedIds.has(featureId);
        const primaryValue = titleColumn ? properties[titleColumn] : null;
        const heading =
          primaryValue !== null && primaryValue !== undefined && String(primaryValue).trim() !== ""
            ? String(primaryValue)
            : `#${featureId}`;
        return (
          <div
            key={featureId}
            data-index={virtualItem.index}
            ref={cardVirtualizer.measureElement}
            className="absolute inset-x-0 top-0 px-2.5 pb-2"
            style={{ transform: `translateY(${virtualItem.start + 10}px)` }}
          >
            <div
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              onClick={(event) => onSelectRow(featureId, event)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRow(featureId, event as unknown as ReactMouseEvent<HTMLElement>);
                }
              }}
              className={cn(
                "rounded-xl border p-3 transition-colors active:bg-accent/70",
                selected
                  ? "border-primary bg-primary/10"
                  : "border-border bg-card hover:bg-accent/40",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-foreground">{heading}</div>
                  {titleColumn ? (
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      #{featureId}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  aria-label={t("mobileShell.attributeCards.zoomToFeature")}
                  title={t("mobileShell.attributeCards.zoomToFeature")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onZoomRow(featureId);
                  }}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border bg-background/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
                >
                  <ZoomIn className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              {previewColumns.length > 0 ? (
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t pt-2 text-xs">
                  {previewColumns.map((col) => (
                    <div key={col} className="min-w-0">
                      <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                        {col}
                      </dt>
                      <dd className="truncate font-medium text-foreground">
                        {formatCardValue(properties[col])}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
