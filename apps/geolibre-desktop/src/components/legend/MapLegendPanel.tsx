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
  Check,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  buildAutoLegend,
  newCustomSectionId,
  removeLegendCustomEntry,
  setLegendCustomEntry,
  type AutoLegendEntry,
  type AutoLegendRow,
} from "../../lib/auto-legend";
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
  // Bumped when an async sprite-colormap sample resolves, so gradients rebuild.
  const [colormapGeneration, setColormapGeneration] = useState(0);

  const visible = legend.panelVisible === true;
  const position = legend.panelPosition ?? "top-left";
  const host = useMapPanelControl(
    mapControllerRef,
    visible,
    position,
    `${LEGEND_PANEL_CLASS} maplibregl-ctrl`,
    mapReadyGeneration,
  );

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

  const panel = (
    <div className="w-64 overflow-hidden rounded-lg border border-border/50 bg-background/90 text-foreground shadow-lg backdrop-blur-md">
      <div className="flex items-center gap-1 border-b border-border/50 px-3 py-2">
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
        <IconButton
          label={editing ? t("legendPanel.done") : t("legendPanel.edit")}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3 w-3" />}
        </IconButton>
        <IconButton label={t("legendPanel.close")} onClick={close}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      {displayed.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">{t("legendPanel.empty")}</p>
      ) : (
        <ul className="max-h-[min(60vh,420px)] divide-y divide-border/50 overflow-y-auto">
          {displayed.map((entry) => (
            <LegendEntryRow
              key={entry.id}
              entry={entry}
              editing={editing}
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
        <div className="space-y-2 border-t border-border/50 px-3 py-2">
          <button
            type="button"
            onClick={addSection}
            className="flex h-7 w-full items-center justify-center gap-1 rounded-md border border-input text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-3 w-3" />
            {t("legendPanel.addSection")}
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
    </div>
  );

  return createPortal(panel, host);
}

function LegendEntryRow({
  entry,
  editing,
  legend,
  entryIds,
  customEntry,
  onCommit,
  onCustomize,
  onUpdateCustom,
}: {
  entry: AutoLegendEntry;
  editing: boolean;
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

  return (
    <li className={cn("px-3 py-2", entry.hidden && "opacity-40")}>
      <div className="flex items-center gap-2">
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

      {entry.fieldLabel && (
        <div className="ms-6 mt-1 truncate text-[10px] font-medium text-muted-foreground">
          {entry.fieldLabel}
        </div>
      )}

      {editingCustom ? (
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
                className="text-xs text-muted-foreground"
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

      {entry.gradient && !editingCustom && (
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
            className="text-xs text-muted-foreground"
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
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={row.label}>
          {row.label}
        </span>
      )}
    </li>
  );
}
