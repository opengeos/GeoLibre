/**
 * The on-map Legend panel: an auto-generated, geolens-style legend derived
 * from the visible layers' symbology, with an edit mode for the cases where
 * automatic derivation is not what the user wants (rename / hide / reorder
 * entries, replace a layer's classes with hand-authored items — e.g. NLCD
 * land-cover names — or add standalone custom sections).
 *
 * Mounted as a MapLibre control (see useMapPanelControl) so it stacks with
 * the other corner controls and is captured by Record Video. All state lives
 * in the store's LegendConfig, so edits persist in the project and are shared
 * with the Print Layout legend.
 */
import {
  normalizeHexColor,
  useAppStore,
  type LegendConfig,
  type LegendCustomEntry,
  type LegendPanelPosition,
} from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { colormapColors, warmColormapColors } from "@geolibre/plugins";
import { cn } from "@geolibre/ui";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  buildAutoLegend,
  newCustomSectionId,
  parseLegendDictionary,
  removeLegendCustomEntry,
  serializeLegend,
  setLegendCustomEntry,
  type AutoLegendEntry,
  type AutoLegendRow,
} from "../../lib/auto-legend";
import { saveBinaryFileWithFallback } from "../../lib/tauri-io";
import { sanitizeExportFileName } from "../../lib/vector-export";
import {
  reorderLegendEntry,
  setLegendItemLabel,
  toggleLegendItemHidden,
} from "../../lib/print-legend";
import { useMapPanelControl } from "../../hooks/useMapPanelControl";
import { GeometrySwatch, GradientBar, MarkerSwatch } from "./LegendSwatch";

/** Class the recorder's MAP_PANEL_SELECTOR matches to burn the panel into videos. */
export const LEGEND_PANEL_CLASS = "geolibre-legend-panel";

const POSITIONS: LegendPanelPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Manual-resize clamps (px). Height is further capped to the map's height. */
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = 520;
const MIN_PANEL_HEIGHT = 140;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Uncontrolled inline text editor committing on blur / Enter. */
function InlineEdit({
  value,
  placeholder,
  ariaLabel,
  className,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  onCommit: (next: string) => void;
}) {
  return (
    <input
      // Remount when the committed value changes so the draft resets.
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0.5 focus:border-input focus:bg-background focus:outline-none",
        className,
      )}
      onBlur={(event) => onCommit(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        // Keep Escape local to the input (revert the draft) instead of closing
        // the whole panel via the document-level handler.
        if (event.key === "Escape") {
          event.stopPropagation();
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** A compact ghost icon button for the panel header / entry controls. */
function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

/** The heading chip for an entry: marker, single-symbol swatch, or glyph. */
function EntryChip({ entry }: { entry: AutoLegendEntry }) {
  if (entry.headerSwatch?.marker) {
    return <MarkerSwatch marker={entry.headerSwatch.marker} opacity={entry.opacity} />;
  }
  if (entry.headerSwatch) {
    return (
      <GeometrySwatch
        shape={entry.shape}
        color={entry.headerSwatch.color}
        opacity={entry.opacity}
      />
    );
  }
  if (entry.shape === "raster") {
    return <GeometrySwatch shape="raster" color="" />;
  }
  // Classed entries: a muted chip in the first visible class color.
  const first = entry.rows.find((row) => !row.hidden) ?? entry.rows[0];
  return (
    <GeometrySwatch shape={entry.shape} color={first?.color ?? "#94a3b8"} opacity={entry.opacity} />
  );
}

export function MapLegendPanel({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapController | null>;
  mapReadyGeneration: number;
}) {
  const { t, i18n } = useTranslation();
  const layers = useAppStore((state) => state.layers);
  const legend = useAppStore((state) => state.legend);
  const setLegend = useAppStore((state) => state.setLegend);
  const [editing, setEditing] = useState(false);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [dictionaryText, setDictionaryText] = useState("");
  // Sections the user folded while editing (session-local, not persisted).
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  // Bumped when an async sprite-colormap sample resolves, so gradients rebuild.
  const [colormapGeneration, setColormapGeneration] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Vertical space available inside the map for the auto-fitting panel.
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const maxHeightRef = useRef<number | null>(null);
  // Live size while a corner handle is being dragged (committed on release).
  const [dragSize, setDragSize] = useState<{ width: number; height: number } | null>(null);

  const visible = legend.panelVisible === true;
  const position = legend.panelPosition ?? "top-left";
  const host = useMapPanelControl(
    mapControllerRef,
    visible,
    position,
    `${LEGEND_PANEL_CLASS} maplibregl-ctrl`,
    mapReadyGeneration,
  );

  // Track the map's height so the panel can auto-expand to its content but
  // never past the map (minus a margin for the corner controls' spacing).
  useEffect(() => {
    if (!host) return;
    const mapElement = host.closest(".maplibregl-map");
    if (!mapElement) return;
    const update = () => {
      const available = Math.max(MIN_PANEL_HEIGHT, mapElement.clientHeight - 24);
      maxHeightRef.current = available;
      setMaxHeight(available);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(mapElement);
    return () => observer.disconnect();
  }, [host]);

  // Warm named raster colormaps (sprite-sampled, async) referenced by layers so
  // colormapColors resolves synchronously inside the derivation.
  useEffect(() => {
    if (!visible) return;
    const names = new Set<string>();
    for (const layer of layers) {
      const state = layer.metadata.rasterState;
      if (state && typeof state === "object" && !Array.isArray(state)) {
        const colormap = (state as Record<string, unknown>).colormap;
        if (typeof colormap === "string" && colormap && colormap !== "palette") {
          names.add(colormap);
        }
      }
      const symbology = layer.metadata.rasterSymbology;
      if (symbology && typeof symbology === "object" && !Array.isArray(symbology)) {
        const ramp = (symbology as Record<string, unknown>).ramp;
        if (typeof ramp === "string" && ramp) names.add(ramp);
      }
    }
    let cancelled = false;
    for (const name of names) {
      if (colormapColors(name)) continue;
      void warmColormapColors(name).then((resolved) => {
        if (!cancelled && resolved) setColormapGeneration((generation) => generation + 1);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [visible, layers]);

  const entries = useMemo(
    () =>
      buildAutoLegend(layers, legend, {
        locale: i18n.language,
        resolveColormapColors: colormapColors,
      }),
    // colormapGeneration re-derives once an async colormap sample lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, legend, i18n.language, colormapGeneration],
  );

  const close = () => setLegend({ ...legend, panelVisible: false });

  // Escape closes the panel (leaving edit mode first, like a nested dismiss),
  // matching the other map panels.
  useEffect(() => {
    if (!visible) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (editing) {
        setEditing(false);
      } else {
        setLegend({ ...legend, panelVisible: false });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [visible, editing, legend, setLegend]);

  if (!visible || !host) return null;

  const displayed = editing ? entries : entries.filter((entry) => !entry.hidden);
  const entryIds = entries.map((entry) => entry.id);

  const commit = (next: LegendConfig) => setLegend(next);

  /** Replace a layer's derived rows with an editable copy of them. */
  const customizeEntry = (entry: AutoLegendEntry) => {
    const items =
      entry.rows.length > 0
        ? entry.rows.map((row) => ({
            label: row.label,
            color: normalizeHexColor(row.color) ?? row.color,
            ...(row.shape === "circle" || row.shape === "line" ? { shape: row.shape } : {}),
          }))
        : [
            {
              label: entry.name,
              color: normalizeHexColor(entry.headerSwatch?.color ?? "") ?? "#3b82f6",
              ...(entry.shape === "circle" || entry.shape === "line" ? { shape: entry.shape } : {}),
            },
          ];
    commit(setLegendCustomEntry(legend, entry.id, { title: entry.name, items }));
  };

  const updateCustom = (id: string, updater: (entry: LegendCustomEntry) => LegendCustomEntry) => {
    const current = legend.customEntries?.[id];
    if (!current) return;
    commit(setLegendCustomEntry(legend, id, updater(current)));
  };

  const addSection = () => {
    const id = newCustomSectionId(legend);
    commit(
      setLegendCustomEntry(legend, id, {
        title: t("legendPanel.newSectionTitle"),
        items: [{ label: t("legendPanel.newItemLabel"), color: "#3b82f6" }],
      }),
    );
  };

  /**
   * Drag a bottom corner handle to resize. Tracked on window so the pointer
   * can leave the small handle mid-drag; the final size is committed to the
   * (project-persisted) LegendConfig on release only.
   */
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, edge: "left" | "right") => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = panel.getBoundingClientRect();
    let last: { width: number; height: number } | null = null;
    const onMove = (move: globalThis.PointerEvent) => {
      const deltaX = move.clientX - startX;
      const deltaY = move.clientY - startY;
      last = {
        // Handles work in physical directions: the right handle widens when
        // dragged right, the left handle when dragged left.
        width: clamp(
          edge === "right" ? rect.width + deltaX : rect.width - deltaX,
          MIN_PANEL_WIDTH,
          MAX_PANEL_WIDTH,
        ),
        height: clamp(
          rect.height + deltaY,
          MIN_PANEL_HEIGHT,
          maxHeightRef.current ?? MIN_PANEL_HEIGHT,
        ),
      };
      setDragSize(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (last) {
        const { legend: current, setLegend: commitLegend } = useAppStore.getState();
        commitLegend({
          ...current,
          panelWidth: Math.round(last.width),
          panelHeight: Math.round(last.height),
        });
      }
      setDragSize(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  /** Back to the default width and auto-fit height (double-click a grip). */
  const resetSize = () => {
    const { legend: current, setLegend: commitLegend } = useAppStore.getState();
    const next = { ...current };
    delete next.panelWidth;
    delete next.panelHeight;
    commitLegend(next);
  };

  /**
   * Keyboard alternative to dragging (WCAG 2.5.7): arrow keys on a focused
   * grip step the size. Left/right follow the grip's physical direction, like
   * the drag. Returns whether the key was handled.
   */
  const stepResize = (edge: "left" | "right", key: string): boolean => {
    const panel = panelRef.current;
    if (!panel) return false;
    const STEP = 16;
    const rect = panel.getBoundingClientRect();
    let width = rect.width;
    let height = rect.height;
    if (key === "ArrowUp") height -= STEP;
    else if (key === "ArrowDown") height += STEP;
    else if (key === "ArrowLeft") width += edge === "left" ? STEP : -STEP;
    else if (key === "ArrowRight") width += edge === "left" ? -STEP : STEP;
    else return false;
    const { legend: current, setLegend: commitLegend } = useAppStore.getState();
    commitLegend({
      ...current,
      panelWidth: Math.round(clamp(width, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH)),
      panelHeight: Math.round(
        clamp(height, MIN_PANEL_HEIGHT, maxHeightRef.current ?? MIN_PANEL_HEIGHT),
      ),
    });
    return true;
  };

  const dictionaryItems = parseLegendDictionary(dictionaryText);
  const addDictionarySection = () => {
    if (!dictionaryItems) return;
    const id = newCustomSectionId(legend);
    commit(
      setLegendCustomEntry(legend, id, {
        title: t("legendPanel.newSectionTitle"),
        items: dictionaryItems,
      }),
    );
    setDictionaryOpen(false);
    setDictionaryText("");
  };

  /** Save the rendered legend (override-applied, visible items) as JSON. */
  const exportLegendJson = async () => {
    const json = serializeLegend(entries, legend.title);
    try {
      await saveBinaryFileWithFallback(new TextEncoder().encode(json), {
        defaultName: `${sanitizeExportFileName(legend.title || "legend")}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
        browserTypes: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        mimeType: "application/json",
      });
    } catch {
      // Cancelled or unwritable target; nothing to roll back.
    }
  };

  const toggleSectionCollapsed = (id: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const panelCollapsed = legend.panelCollapsed === true;
  const togglePanelCollapsed = () => {
    commit({ ...legend, panelCollapsed: !panelCollapsed });
    // A collapsed panel shows only its header; leave edit mode so reopening
    // doesn't land in a hidden editing session.
    setEditing(false);
    setDictionaryOpen(false);
  };

  const width = dragSize?.width ?? legend.panelWidth;
  const height = dragSize?.height ?? legend.panelHeight;
  const panel = (
    // /95 rather than the geolens /90: bright map content bleeding through the
    // translucent panel washed the item text out in dark theme. Height is
    // auto (fit to content) up to the map's height unless the user resized;
    // a flex column keeps header/footer fixed while the entry list scrolls.
    <div
      ref={panelRef}
      className="relative flex w-64 flex-col overflow-hidden rounded-lg border border-border/50 bg-background/95 text-foreground shadow-lg backdrop-blur-md"
      style={{
        maxHeight: maxHeight ?? undefined,
        ...(width !== undefined ? { width: clamp(width, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH) } : {}),
        // A collapsed panel hugs its header; the resized height only applies
        // when expanded.
        ...(height !== undefined && !panelCollapsed
          ? { height: clamp(height, MIN_PANEL_HEIGHT, maxHeight ?? height) }
          : {}),
      }}
    >
      {/* `group` reveals the edit/close buttons on hover or keyboard focus,
          keeping the header quiet while reading the legend. */}
      <div
        className={cn(
          "group flex shrink-0 items-center gap-1 px-3 py-2",
          !panelCollapsed && "border-b border-border/50",
        )}
      >
        <IconButton
          label={panelCollapsed ? t("legendPanel.expandPanel") : t("legendPanel.collapsePanel")}
          onClick={togglePanelCollapsed}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", !panelCollapsed && "rotate-90")}
          />
        </IconButton>
        {editing ? (
          <InlineEdit
            value={legend.title}
            ariaLabel={t("legendPanel.renameTitle")}
            className="text-sm font-semibold"
            onCommit={(next) => commit({ ...legend, title: next.trim() || legend.title })}
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{legend.title}</h2>
        )}
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
            editing && "opacity-100",
          )}
        >
          {!panelCollapsed && (
            <IconButton
              label={editing ? t("legendPanel.done") : t("legendPanel.edit")}
              onClick={() => {
                setEditing((value) => !value);
                setDictionaryOpen(false);
              }}
            >
              {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3 w-3" />}
            </IconButton>
          )}
          <IconButton label={t("legendPanel.close")} onClick={close}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </span>
      </div>

      {panelCollapsed ? null : displayed.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">{t("legendPanel.empty")}</p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border/50 overflow-y-auto">
          {displayed.map((entry) => (
            <LegendEntryRow
              key={entry.id}
              entry={entry}
              editing={editing}
              collapsed={collapsedIds.has(entry.id)}
              onToggleCollapsed={() => toggleSectionCollapsed(entry.id)}
              legend={legend}
              entryIds={entryIds}
              customEntry={legend.customEntries?.[entry.id]}
              onCommit={commit}
              onCustomize={() => customizeEntry(entry)}
              onUpdateCustom={(updater) => updateCustom(entry.id, updater)}
            />
          ))}
        </ul>
      )}

      {editing && (
        <div className="shrink-0 space-y-2 overflow-y-auto border-t border-border/50 px-3 py-2">
          <button
            type="button"
            onClick={addSection}
            className="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-input text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-3 w-3" />
            {t("legendPanel.addSection")}
          </button>
          <button
            type="button"
            aria-expanded={dictionaryOpen}
            onClick={() => setDictionaryOpen((value) => !value)}
            className="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-input text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BookOpen className="h-3 w-3" />
            {t("legendPanel.addFromDictionary")}
          </button>
          {dictionaryOpen && (
            <div className="space-y-1">
              <textarea
                value={dictionaryText}
                onChange={(event) => setDictionaryText(event.target.value)}
                rows={4}
                aria-label={t("legendPanel.addFromDictionary")}
                placeholder={'{"Open Water": "#466b9f", "Forest": "#1c6330"}'}
                className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onKeyDown={(event) => {
                  // Keep Escape local: close the form, not edit mode / the panel.
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setDictionaryOpen(false);
                  }
                }}
              />
              <p className="text-[10px] text-muted-foreground">{t("legendPanel.dictionaryHint")}</p>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={!dictionaryItems}
                  onClick={addDictionarySection}
                  className="h-6 flex-1 rounded-md bg-primary text-xs text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  {t("legendPanel.dictionaryAdd")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDictionaryOpen(false);
                    setDictionaryText("");
                  }}
                  className="h-6 flex-1 rounded-md border border-input text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t("legendPanel.cancel")}
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => void exportLegendJson()}
            className="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-input text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Download className="h-3 w-3" />
            {t("legendPanel.exportJson")}
          </button>
          <label className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {t("legendPanel.position")}
            <select
              value={position}
              onChange={(event) =>
                commit({ ...legend, panelPosition: event.target.value as LegendPanelPosition })
              }
              className="h-6 flex-1 rounded-sm border border-input bg-background px-1 text-xs text-foreground focus-visible:outline-none"
            >
              {POSITIONS.map((corner) => (
                <option key={corner} value={corner}>
                  {t(`legendPanel.positions.${corner}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Bottom-corner resize grips. Physical left/right (not logical): the
          drag math above works in physical screen directions. Double-click
          resets to the default width and auto-fit height; arrow keys resize
          when a grip is focused (keyboard alternative to dragging). Hidden
          while collapsed — a header-only bar has nothing to resize. */}
      {panelCollapsed ? null : (
        <>
          <div
            role="button"
            tabIndex={0}
            aria-label={t("legendPanel.resize")}
            title={t("legendPanel.resize")}
            onPointerDown={(event) => beginResize(event, "right")}
            onDoubleClick={resetSize}
            onKeyDown={(event) => {
              if (stepResize("right", event.key)) event.preventDefault();
            }}
            className="absolute bottom-0 right-0 z-10 h-6 w-6 cursor-nwse-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="absolute bottom-1 right-1 h-2 w-2 border-b-2 border-r-2 border-muted-foreground/60" />
          </div>
          <div
            role="button"
            tabIndex={0}
            aria-label={t("legendPanel.resize")}
            title={t("legendPanel.resize")}
            onPointerDown={(event) => beginResize(event, "left")}
            onDoubleClick={resetSize}
            onKeyDown={(event) => {
              if (stepResize("left", event.key)) event.preventDefault();
            }}
            className="absolute bottom-0 left-0 z-10 h-6 w-6 cursor-nesw-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="absolute bottom-1 left-1 h-2 w-2 border-b-2 border-l-2 border-muted-foreground/60" />
          </div>
        </>
      )}
    </div>
  );

  return createPortal(panel, host);
}

function LegendEntryRow({
  entry,
  editing,
  collapsed,
  onToggleCollapsed,
  legend,
  entryIds,
  customEntry,
  onCommit,
  onCustomize,
  onUpdateCustom,
}: {
  entry: AutoLegendEntry;
  editing: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  legend: LegendConfig;
  entryIds: string[];
  customEntry: LegendCustomEntry | undefined;
  onCommit: (next: LegendConfig) => void;
  onCustomize: () => void;
  onUpdateCustom: (updater: (entry: LegendCustomEntry) => LegendCustomEntry) => void;
}) {
  const { t } = useTranslation();
  const index = entryIds.indexOf(entry.id);
  const visibleRows = editing ? entry.rows : entry.rows.filter((row) => !row.hidden);
  const editingCustom = editing && entry.custom && customEntry;
  const hasBody = Boolean(
    entry.fieldLabel || entry.gradient || editingCustom || visibleRows.length > 0,
  );
  // Sections collapse in edit mode only, to keep long legends manageable
  // while rearranging; display mode always shows everything.
  const bodyCollapsed = editing && collapsed;

  return (
    <li className={cn("px-3 py-2", entry.hidden && "opacity-40")}>
      <div className="flex items-center gap-2">
        {editing && (
          <IconButton
            label={collapsed ? t("legendPanel.expandEntry") : t("legendPanel.collapseEntry")}
            disabled={!hasBody}
            onClick={onToggleCollapsed}
          >
            <ChevronRight
              className={cn("h-3 w-3 transition-transform", !bodyCollapsed && "rotate-90")}
            />
          </IconButton>
        )}
        <EntryChip entry={entry} />
        {editing ? (
          <InlineEdit
            value={entry.name}
            placeholder={entry.defaultName}
            ariaLabel={t("legendPanel.renameEntry", { name: entry.defaultName })}
            className="text-sm"
            onCommit={(next) => {
              if (entry.custom && customEntry) {
                // A custom entry's name lives on the entry itself.
                onUpdateCustom((current) => ({ ...current, title: next.trim() || undefined }));
              } else {
                onCommit(setLegendItemLabel(legend, entry.id, next, entry.defaultName));
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 text-sm leading-tight line-clamp-2" title={entry.name}>
            {entry.name}
          </span>
        )}
        {editing && (
          <span className="flex shrink-0 items-center gap-0.5">
            <IconButton
              label={t("legendPanel.moveUp")}
              disabled={index <= 0}
              onClick={() => onCommit(reorderLegendEntry(legend, entryIds, entry.id, "up"))}
            >
              <ArrowUp className="h-3 w-3" />
            </IconButton>
            <IconButton
              label={t("legendPanel.moveDown")}
              disabled={index < 0 || index >= entryIds.length - 1}
              onClick={() => onCommit(reorderLegendEntry(legend, entryIds, entry.id, "down"))}
            >
              <ArrowDown className="h-3 w-3" />
            </IconButton>
            <IconButton
              label={entry.hidden ? t("legendPanel.showEntry") : t("legendPanel.hideEntry")}
              onClick={() => onCommit(toggleLegendItemHidden(legend, entry.id))}
            >
              {entry.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </IconButton>
            {entry.custom ? (
              <IconButton
                label={
                  entry.standalone ? t("legendPanel.removeSection") : t("legendPanel.resetEntry")
                }
                onClick={() => onCommit(removeLegendCustomEntry(legend, entry.id))}
              >
                {entry.standalone ? (
                  <Trash2 className="h-3 w-3" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
              </IconButton>
            ) : (
              <IconButton label={t("legendPanel.customizeEntry")} onClick={onCustomize}>
                <Pencil className="h-3 w-3" />
              </IconButton>
            )}
          </span>
        )}
      </div>

      {!bodyCollapsed && entry.fieldLabel && (
        <div className="ms-6 mt-1 truncate text-[10px] font-medium text-muted-foreground">
          {entry.fieldLabel}
        </div>
      )}

      {bodyCollapsed ? null : editingCustom ? (
        <ul className="ms-6 mt-1.5 space-y-1">
          {customEntry.items.map((item, itemIndex) => (
            <li key={itemIndex} className="flex items-center gap-1.5">
              <input
                type="color"
                value={normalizeHexColor(item.color) ?? "#888888"}
                aria-label={t("legendPanel.itemColor")}
                className="h-5 w-6 shrink-0 cursor-pointer rounded-sm border border-input bg-transparent p-0"
                onChange={(event) =>
                  onUpdateCustom((current) => ({
                    ...current,
                    items: current.items.map((existing, i) =>
                      i === itemIndex ? { ...existing, color: event.target.value } : existing,
                    ),
                  }))
                }
              />
              <InlineEdit
                value={item.label}
                placeholder={t("legendPanel.newItemLabel")}
                ariaLabel={t("legendPanel.renameItem", { name: item.label })}
                className="text-xs text-foreground/80"
                onCommit={(next) =>
                  onUpdateCustom((current) => ({
                    ...current,
                    items: current.items.map((existing, i) =>
                      i === itemIndex ? { ...existing, label: next } : existing,
                    ),
                  }))
                }
              />
              <IconButton
                label={t("legendPanel.removeItem")}
                disabled={customEntry.items.length <= 1}
                onClick={() =>
                  onUpdateCustom((current) => ({
                    ...current,
                    items: current.items.filter((_, i) => i !== itemIndex),
                  }))
                }
              >
                <Trash2 className="h-3 w-3" />
              </IconButton>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() =>
                onUpdateCustom((current) => ({
                  ...current,
                  items: [
                    ...current.items,
                    { label: t("legendPanel.newItemLabel"), color: "#3b82f6" },
                  ],
                }))
              }
              className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-3 w-3" />
              {t("legendPanel.addItem")}
            </button>
          </li>
        </ul>
      ) : (
        visibleRows.length > 0 && (
          <ul className="ms-6 mt-1.5 space-y-0.5">
            {visibleRows.map((row) => (
              <LegendClassRow
                key={row.key}
                row={row}
                entry={entry}
                editing={editing && !entry.custom}
                legend={legend}
                onCommit={onCommit}
              />
            ))}
          </ul>
        )
      )}

      {!bodyCollapsed && entry.gradient && !editingCustom && (
        <div className="ms-6 mt-1.5">
          <GradientBar
            colors={entry.gradient.colors}
            minLabel={entry.gradient.minLabel ?? t("legendPanel.low")}
            maxLabel={entry.gradient.maxLabel ?? t("legendPanel.high")}
            opacity={entry.opacity}
          />
        </div>
      )}
    </li>
  );
}

function LegendClassRow({
  row,
  entry,
  editing,
  legend,
  onCommit,
}: {
  row: AutoLegendRow;
  entry: AutoLegendEntry;
  editing: boolean;
  legend: LegendConfig;
  onCommit: (next: LegendConfig) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className={cn("flex items-center gap-1.5", row.hidden && "opacity-40")}>
      {row.marker ? (
        <MarkerSwatch marker={row.marker} opacity={entry.opacity} />
      ) : (
        <GeometrySwatch
          shape={row.shape}
          color={row.color}
          size={row.size}
          opacity={entry.opacity}
        />
      )}
      {editing ? (
        <>
          <InlineEdit
            value={row.label}
            ariaLabel={t("legendPanel.renameItem", { name: row.label })}
            className="text-xs text-foreground/80"
            onCommit={(next) =>
              onCommit(setLegendItemLabel(legend, row.key, next, row.defaultLabel))
            }
          />
          <IconButton
            label={row.hidden ? t("legendPanel.showItem") : t("legendPanel.hideItem")}
            onClick={() => onCommit(toggleLegendItemHidden(legend, row.key))}
          >
            {row.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          </IconButton>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-foreground/80" title={row.label}>
          {row.label}
        </span>
      )}
    </li>
  );
}
