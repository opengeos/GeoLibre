import { BottomSheet, type BottomSheetDetent, cn } from "@geolibre/ui";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  filterTouchMenuItems,
  pruneEmptyTouchMenuItems,
  resolveTouchMenuPage,
  type TouchMenuActionItem,
  type TouchMenuItem,
} from "../../../lib/touch-menu-nav";

export interface TouchMenuSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  items: readonly TouchMenuItem[];
  defaultDetent?: BottomSheetDetent;
  modal?: boolean;
  /** Show a sticky search input that searches across all nested pages. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Optional content pinned at the top of the root page (e.g. a layer opacity slider). */
  headerContent?: ReactNode;
  "data-testid"?: string;
}

function TouchActionRow({
  item,
  trail,
  onRun,
}: {
  item: TouchMenuActionItem;
  trail?: string[];
  onRun: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={item.active}
      disabled={item.disabled}
      onClick={onRun}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 active:bg-accent",
        item.destructive
          ? "text-destructive hover:bg-destructive/10"
          : item.active
            ? "bg-primary/10 text-primary"
            : "text-foreground hover:bg-accent/60",
      )}
    >
      {item.icon ? (
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center",
            item.destructive
              ? "text-destructive"
              : item.active
                ? "text-primary"
                : "text-muted-foreground",
          )}
        >
          {item.icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.label}</span>
        {trail && trail.length > 0 ? (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {trail.join(" / ")}
          </span>
        ) : item.description ? (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {item.description}
          </span>
        ) : null}
      </span>
      {item.badge ? (
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {item.badge}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Hierarchical single-column drill-down navigation sheet for touch devices
 * (GeoLibre#3537 Phase 2). Replaces nested cascading dropdown submenus with
 * 48px rows, a Back header, and full-tree search.
 */
export function TouchMenuSheet({
  open,
  onOpenChange,
  title,
  items,
  defaultDetent = "full",
  modal = true,
  searchable = true,
  searchPlaceholder,
  headerContent,
  "data-testid": testId,
}: TouchMenuSheetProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState<string[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setPath([]);
      setQuery("");
    }
  }, [open]);

  const prunedItems = useMemo(() => pruneEmptyTouchMenuItems(items), [items]);
  const page = useMemo(
    () => resolveTouchMenuPage(title, prunedItems, path),
    [title, prunedItems, path],
  );
  const searchMatches = useMemo(
    () => (searchable ? filterTouchMenuItems(prunedItems, query) : []),
    [searchable, prunedItems, query],
  );
  const isSearching = searchable && query.trim().length > 0;
  const isNested = !isSearching && page.path.length > 0;

  const runAction = (item: TouchMenuActionItem) => {
    onOpenChange(false);
    item.onSelect();
  };

  const renderNode = (node: TouchMenuItem) => {
    if (node.kind === "action") {
      return <TouchActionRow key={node.id} item={node} onRun={() => runAction(node)} />;
    }
    if (node.kind === "submenu") {
      return (
        <button
          key={node.id}
          type="button"
          disabled={node.disabled}
          onClick={() => setPath([...page.path, node.id])}
          className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm font-medium text-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 active:bg-accent"
        >
          {node.icon ? (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
              {node.icon}
            </span>
          ) : null}
          <span className="min-w-0 flex-1">
            <span className="block truncate">{node.label}</span>
            {node.description ? (
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {node.description}
              </span>
            ) : null}
          </span>
          {node.badge ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {node.badge}
            </span>
          ) : null}
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70 rtl:rotate-180" />
        </button>
      );
    }
    return (
      <section key={node.id} className="space-y-1">
        <h3 className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {node.label}
        </h3>
        <div className="space-y-1">{node.items.map(renderNode)}</div>
      </section>
    );
  };

  const sheetHeaderTitle = isNested ? (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        data-testid="touch-menu-back"
        aria-label={t("mobileShell.menu.backTo", { title: page.parentTitle ?? title })}
        onClick={() => setPath((prev) => prev.slice(0, -1))}
        className="-ms-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
      >
        <ChevronLeft className="h-5 w-5 rtl:rotate-180" />
      </button>
      <span className="truncate">{page.title}</span>
    </span>
  ) : (
    page.title
  );

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      modal={modal}
      defaultDetent={defaultDetent}
      title={sheetHeaderTitle}
      ariaLabel={page.title}
      closeLabel={t("common.close")}
      dragHandleLabel={t("mobileShell.resizeSheet")}
      bodyClassName="flex flex-col overflow-hidden"
      data-testid={testId}
    >
      {searchable ? (
        <div className="shrink-0 border-b px-3 py-2">
          <div className="relative flex items-center">
            <Search
              className="pointer-events-none absolute start-3 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              data-testid="touch-menu-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder ?? t("mobileShell.menu.searchPlaceholder")}
              className="h-11 w-full rounded-lg border bg-muted/40 ps-9 pe-10 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {query ? (
              <button
                type="button"
                aria-label={t("mobileShell.menu.clearSearch")}
                onClick={() => setQuery("")}
                className="absolute end-1 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2 pb-4">
        {!isSearching && !isNested && headerContent ? (
          <div className="px-1">{headerContent}</div>
        ) : null}
        {isSearching ? (
          searchMatches.length > 0 ? (
            <div className="space-y-1">
              {searchMatches.map((match) => (
                <TouchActionRow
                  key={`${match.trail.join("/")}/${match.item.id}`}
                  item={match.item}
                  trail={match.trail}
                  onRun={() => runAction(match.item)}
                />
              ))}
            </div>
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("mobileShell.menu.noResults")}
            </p>
          )
        ) : (
          page.items.map(renderNode)
        )}
      </div>
    </BottomSheet>
  );
}
