import { Button, Input, cn } from "@geolibre/ui";
import { Globe2, Search } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CrsEntry,
  crsEntryForCode,
  formatCrsLabel,
  searchCrsCatalog,
} from "../../lib/crs-catalog";

export interface CrsPickerInputProps {
  id: string;
  /** The parameter's current value: an EPSG code as typed, or blank. */
  value: string;
  onChange: (value: unknown) => void;
}

/**
 * An EPSG-code field with a searchable CRS list beside it (GeoLibre#1538).
 *
 * The text box remains the source of truth and accepts any code, so a system the
 * curated catalog omits can still be typed; the picker is a shortcut that
 * searches by name or code and separates geographic from projected systems, the
 * way QGIS does. Whenever the typed code names a catalog entry, its name is
 * shown under the field, which also confirms that a remembered code is the CRS
 * the user meant.
 *
 * @param props - The field id, its current value, and an onChange callback.
 */
export function CrsPickerInput({ id, value, onChange }: CrsPickerInputProps): ReactElement {
  const { t } = useTranslation();
  const listId = `${useId()}-crs-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const matches = useMemo(() => searchCrsCatalog(query), [query]);
  // Group before ranking is applied to the display: the request was for the list
  // to be split by type, so all geographic hits precede the projected ones while
  // each group keeps the search's own ordering.
  const geographic = useMemo(() => matches.filter((m) => m.kind === "geographic"), [matches]);
  const projected = useMemo(() => matches.filter((m) => m.kind === "projected"), [matches]);
  // Flat, visual-order list so arrow keys walk the rows as they are rendered.
  const ordered = useMemo(() => [...geographic, ...projected], [geographic, projected]);
  const selected = crsEntryForCode(value);

  // Every way of leaving the panel clears the search, so reopening it starts on
  // the curated default list rather than resuming a search the user dismissed.
  //
  // `restoreFocus` is for the deliberate dismissals (Escape, picking a row, the
  // toggle): the focused element unmounts with the panel, so without this focus
  // would land on <body> and the keyboard flow would be lost. It stays off when
  // focus has already left the control or the user clicked elsewhere, where
  // pulling focus back to the trigger would fight them.
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Close on a click anywhere outside the control (the panel floats over the
  // tool form, so there is no backdrop to catch the click).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    // The panel floats inside the tool form's scroll container, which clips it
    // when the field sits low in a long form. Reveal the whole panel, not just
    // the field the focus above scrolled to.
    panelRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);

  // Keep the arrow-key highlight visible. DOM focus stays on the search box, so
  // the list never scrolls on its own, and a broad query ("utm") returns far
  // more rows than the capped list shows.
  useEffect(() => {
    if (!open || ordered.length === 0) return;
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeIndex, listId, open, ordered.length]);

  const choose = (entry: CrsEntry) => {
    onChange(String(entry.code));
    close(true);
  };

  // A named `group` inside the listbox, the ARIA shape for a split option list:
  // the group carries the name, so a screen reader announces "Geographic" or
  // "Projected" as the virtual cursor crosses into it, and the sticky heading
  // that shows the same word visually is hidden from the tree so it is not read
  // twice. `presentation` on the heading alone would leave the split silent.
  const renderGroup = (label: string, entries: CrsEntry[], offset: number) =>
    entries.length === 0 ? null : (
      <div key={label} role="group" aria-label={label}>
        <div
          aria-hidden="true"
          className="sticky top-0 bg-popover px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          {label}
        </div>
        {entries.map((entry, index) => {
          const position = offset + index;
          return (
            <button
              key={entry.code}
              type="button"
              role="option"
              aria-selected={position === activeIndex}
              id={`${listId}-option-${position}`}
              // Out of the tab order: with `aria-activedescendant` on the search
              // box, DOM focus stays there and the arrow keys move a virtual
              // highlight. Leaving 300 rows as tab stops would also bury the
              // rest of the form behind them.
              tabIndex={-1}
              className={cn(
                "flex w-full items-baseline justify-between gap-2 px-2 py-1 text-start text-xs hover:bg-accent",
                position === activeIndex && "bg-accent",
              )}
              onMouseEnter={() => setActiveIndex(position)}
              // click, not mousedown: nothing closes the panel on pointerdown
              // inside it, so the click lands, and a click is what a row reached
              // by any means fires.
              onClick={() => choose(entry)}
              onFocus={() => setActiveIndex(position)}
            >
              <span>{entry.name}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{entry.code}</span>
            </button>
          );
        })}
      </div>
    );

  return (
    <div
      className="grid gap-1"
      ref={containerRef}
      // Tabbing (or clicking) out of the control entirely dismisses the panel.
      // The rows are not tab stops, so without this a keyboard user who tabs
      // past the search box would leave an open panel behind with no way to
      // close it. onBlur is React's focusout, so it fires for focus leaving any
      // descendant; a relatedTarget still inside the control is not a departure.
      onBlur={(event) => {
        if (open && !containerRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      {/* The panel's positioning context is this row alone, not the outer
          container: `top-full` against the container would resolve past the
          selected-CRS label below, detaching the panel from the button. */}
      <div className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          value={value}
          placeholder={t("processing.whitebox.crs.codePlaceholder")}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => (open ? close(true) : setOpen(true))}
        >
          <Globe2 className="h-3.5 w-3.5" aria-hidden="true" />
          {t("processing.whitebox.crs.browse")}
        </Button>

        {open ? (
          <div
            ref={panelRef}
            className="absolute top-full z-30 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
            // On the panel rather than the search box, so Escape dismisses it
            // from anywhere inside it.
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              }
            }}
          >
            <div className="relative border-b p-1.5">
              <Search
                className="pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                ref={searchRef}
                type="text"
                role="combobox"
                aria-expanded
                // Only while the list is actually rendered: with no matches the
                // listbox is replaced by the "no results" message, and pointing at an
                // id that is not in the DOM tells a screen reader nothing.
                aria-controls={ordered.length > 0 ? listId : undefined}
                aria-activedescendant={
                  ordered.length > 0 ? `${listId}-option-${activeIndex}` : undefined
                }
                aria-label={t("processing.whitebox.crs.searchLabel")}
                placeholder={t("processing.whitebox.crs.searchPlaceholder")}
                className="h-8 ps-7 text-xs"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    // Floor the ceiling at 0 so an empty result set leaves the
                    // index at 0 rather than walking it negative.
                    setActiveIndex((index) => Math.min(index + 1, Math.max(ordered.length - 1, 0)));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((index) => Math.max(index - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const entry = ordered[activeIndex];
                    if (entry) choose(entry);
                  }
                }}
              />
            </div>
            {ordered.length === 0 ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {t("processing.whitebox.crs.noResults")}
              </p>
            ) : (
              <div id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
                {renderGroup(t("processing.whitebox.crs.geographic"), geographic, 0)}
                {renderGroup(t("processing.whitebox.crs.projected"), projected, geographic.length)}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {selected ? (
        <p className="text-xs text-muted-foreground">{formatCrsLabel(selected)}</p>
      ) : null}
    </div>
  );
}
