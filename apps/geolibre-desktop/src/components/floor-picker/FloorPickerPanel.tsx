import {
  applyGroupEffects,
  collectLevels,
  currentLevelChoice,
  mergeLevels,
  resolveLevelLinks,
  useAppStore,
  withoutHistory,
  type GeoLibreLayer,
  type LevelEntry,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { cn } from "@geolibre/ui";
import { Layers2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useMapPanelControl } from "../../hooks/useMapPanelControl";
import {
  MIN_ROWS,
  clampFloorListHeight,
  floorListRoom,
  mapContainerOf,
  readListHeight,
  writeListHeight,
} from "./floor-list-size";

/** Class on the floor picker's map-control host, for scoped CSS and tests. */
const FLOOR_PICKER_CLASS = "geolibre-floor-picker";

/** Floor lists per FeatureCollection and field, so re-renders do not rescan. */
const levelCache = new WeakMap<object, Map<string, LevelEntry[]>>();

/**
 * The floors one linked layer holds, memoized on its FeatureCollection.
 *
 * @param layer - A layer with a {@link GeoLibreLayer.levelFilter}.
 * @returns Its floors, top floor first.
 */
function layerLevels(layer: GeoLibreLayer): LevelEntry[] {
  const field = layer.levelFilter?.field ?? "";
  const geojson = layer.geojson;
  if (!geojson || !field) return [];
  let byField = levelCache.get(geojson);
  if (!byField) {
    byField = new Map();
    levelCache.set(geojson, byField);
  }
  let levels = byField.get(field);
  if (!levels) {
    levels = collectLevels(geojson.features, field);
    byField.set(field, levels);
  }
  return levels;
}

/**
 * The on-map floor picker (issue #3341): lists the floors of every visible
 * layer linked in its Style panel and narrows those layers to one floor, or to
 * a floor and the ones below it.
 *
 * The choice is stored on each linked layer's `levelFilter`, so it saves with
 * the project, and is compiled with the layer's other filters (expression,
 * Quick Filters, the Time Slider window) by every renderer. The panel is a map
 * control placed through {@link MapEngine.addControl}, so it works on MapLibre,
 * Mapbox, Cesium and ArcGIS alike.
 */
export function FloorPickerPanel({
  mapControllerRef,
  mapReadyGeneration,
}: {
  mapControllerRef: RefObject<MapEngine | null>;
  mapReadyGeneration: number;
}) {
  const { t } = useTranslation();
  const linked = useAppStore(
    useShallow((state) => state.layers.filter((layer) => layer.levelFilter !== undefined)),
  );
  const setLevelSelection = useAppStore((state) => state.setLevelSelection);
  const reconcileLevelLinks = useAppStore((state) => state.reconcileLevelLinks);

  const layerGroups = useAppStore((state) => state.layerGroups);
  // Effective primary-map visibility: a linked layer inside a hidden group is
  // not drawn, so it contributes no floors.
  const visibleLinked = useMemo(
    () => applyGroupEffects(linked, layerGroups).filter((layer) => layer.visible),
    [linked, layerGroups],
  );
  const levels = useMemo(() => mergeLevels(visibleLinked.map(layerLevels)), [visibleLinked]);
  const choice = useMemo(() => currentLevelChoice(linked), [linked]);

  // Keep every linked layer on the shared choice (see resolveLevelLinks).
  // This is bookkeeping, not an edit: it neither marks a freshly opened
  // project unsaved nor adds an undo step that undo would only re-trigger.
  useEffect(() => {
    const updates = resolveLevelLinks(linked, choice);
    if (updates.length > 0) withoutHistory(() => reconcileLevelLinks(updates));
  }, [linked, choice, reconcileLevelLinks]);

  const listRef = useRef<HTMLDivElement | null>(null);
  // A user-chosen list height (dragging the grip), remembered per browser;
  // `null` keeps the default min(16rem, 40vh).
  const [listHeight, setListHeight] = useState<number | null>(readListHeight);
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Stay mounted while a floor is chosen even if the data no longer lists
  // any floors, so All can still clear the filter.
  const visible = visibleLinked.length > 0 && (levels.length > 0 || choice.level !== null);
  const host = useMapPanelControl(
    mapControllerRef,
    visible,
    "top-right",
    `${FLOOR_PICKER_CLASS} maplibregl-ctrl`,
    mapReadyGeneration,
  );
  // A tall building's list scrolls; keep the chosen floor in view (also when
  // a project reopens on an upper floor, or the floor changes by keyboard).
  useEffect(() => {
    if (!host || choice.level === null) return;
    const active = listRef.current?.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [host, choice.level, levels]);

  // A height remembered on a taller window must still fit this map.
  useEffect(() => {
    if (!host || listHeight === null) return;
    const map = mapContainerOf(host);
    const fit = () => {
      const list = listRef.current;
      const panel = panelRef.current;
      if (!list || !panel) return;
      const clamped = clampFloorListHeight(listHeight, 25, floorListRoom(list, panel, map));
      if (clamped < listHeight) setListHeight(clamped);
    };
    fit();
    if (!map) return;
    const observer = new ResizeObserver(fit);
    observer.observe(map);
    return () => observer.disconnect();
  }, [host, listHeight]);

  if (!visible || !host) return null;

  const below = choice.mode === "below";
  const choose = (level: string | null) => {
    if (level === null) setLevelSelection(null, "all");
    else setLevelSelection(level, below ? "below" : "only");
  };
  // Arrow keys step one floor up or down, like a lift panel; from All they
  // start at the top or bottom floor.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const index = levels.findIndex((entry) => entry.label === choice.level);
    const up = event.key === "ArrowUp";
    const next =
      index === -1
        ? up
          ? 0
          : levels.length - 1
        : Math.max(0, Math.min(levels.length - 1, index + (up ? -1 : 1)));
    const target = levels[next];
    if (!target) return;
    choose(target.label);
    // Move focus with the choice, so Enter or Space does not re-press the
    // button that had focus (All, say). Focus whatever is chosen when the
    // frame runs, so a quicker second key press is never undone.
    requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>("[data-active='true']")
        ?.focus({ preventScroll: true });
    });
  };
  // Resizing the floor list: drag the grip, or focus it and use the arrow keys
  // (one floor per press), Home/End for the smallest/largest, Enter to reset.
  const rowHeight = () =>
    listRef.current?.querySelector<HTMLElement>("[data-testid='floor-picker-level']")
      ?.offsetHeight || 25;
  const room = () =>
    listRef.current && panelRef.current
      ? floorListRoom(listRef.current, panelRef.current, mapContainerOf(host))
      : null;
  const applyHeight = (height: number, persist: boolean) => {
    const next = clampFloorListHeight(height, rowHeight(), room());
    setListHeight(next);
    if (persist) writeListHeight(next);
  };
  const onGripPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: listRef.current?.clientHeight ?? 0,
    };
  };
  const onGripPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    applyHeight(current.startHeight + event.clientY - current.startY, false);
  };
  const onGripPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (listRef.current) writeListHeight(listRef.current.clientHeight);
  };
  const resetHeight = () => {
    setListHeight(null);
    writeListHeight(null);
  };
  const onGripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = listRef.current?.clientHeight ?? 0;
    const step = rowHeight();
    const byKey: Record<string, number> = {
      ArrowUp: current - step,
      ArrowDown: current + step,
      Home: 0,
      End: Number.POSITIVE_INFINITY,
    };
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      resetHeight();
      return;
    }
    if (!(event.key in byKey)) return;
    // Keep the arrow keys from also stepping floors (the group's handler).
    event.preventDefault();
    event.stopPropagation();
    applyHeight(byKey[event.key], true);
  };
  const toggleBelow = () => {
    if (choice.level === null) return;
    setLevelSelection(choice.level, below ? "only" : "below");
  };

  // Colors live in index.css (`.geolibre-floor-picker`), not Tailwind
  // utilities: MapLibre's `.maplibregl-ctrl button:hover` rule outranks a
  // `hover:bg-*` utility and would grey out the chosen floor's white label.
  const panel = (
    <div
      role="group"
      aria-label={t("floorPicker.title")}
      className="geolibre-floor-picker-panel flex w-14 flex-col items-stretch overflow-hidden rounded text-xs shadow"
      ref={panelRef}
      data-testid="floor-picker"
      onKeyDown={onKeyDown}
    >
      <div
        className="geolibre-floor-picker-header flex items-center justify-center gap-1 py-1 font-medium"
        title={t("floorPicker.title")}
      >
        <Layers2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{t("floorPicker.short")}</span>
      </div>
      <button
        type="button"
        className="px-1 py-1"
        data-active={choice.level === null}
        aria-pressed={choice.level === null}
        title={t("floorPicker.allTitle")}
        onClick={() => choose(null)}
        data-testid="floor-picker-all"
      >
        {t("floorPicker.all")}
      </button>
      <div
        ref={listRef}
        className={cn(
          "overflow-y-auto overscroll-contain",
          listHeight === null && "max-h-[min(16rem,40vh)]",
        )}
        style={listHeight === null ? undefined : { maxHeight: listHeight }}
        data-testid="floor-picker-list"
      >
        {levels.map((entry) => {
          const active = choice.level === entry.label;
          const shown =
            active ||
            (below &&
              choice.level !== null &&
              entry.ordinal !== null &&
              Number(choice.level) > entry.ordinal);
          return (
            <button
              key={entry.label}
              type="button"
              className={cn(
                "geolibre-floor-picker-level block w-full truncate px-1 py-1 tabular-nums",
                active && "font-semibold",
              )}
              data-active={active}
              data-shown={!active && shown}
              aria-pressed={active}
              title={t("floorPicker.levelTitle", { level: entry.label, count: entry.count })}
              onClick={() => choose(entry.label)}
              data-testid="floor-picker-level"
              data-level={entry.label}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      {levels.length > MIN_ROWS ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("floorPicker.resize")}
          title={t("floorPicker.resizeTitle")}
          tabIndex={0}
          className="geolibre-floor-picker-grip"
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerUp}
          onDoubleClick={resetHeight}
          onKeyDown={onGripKeyDown}
          data-testid="floor-picker-grip"
        >
          <span aria-hidden="true" />
        </div>
      ) : null}
      <button
        type="button"
        className={cn(
          "geolibre-floor-picker-below px-1 py-1 text-[10px] leading-tight disabled:opacity-50",
          below && "font-semibold",
        )}
        data-on={below}
        aria-pressed={below}
        disabled={choice.level === null}
        title={t("floorPicker.belowTitle")}
        onClick={toggleBelow}
        data-testid="floor-picker-below"
      >
        {t("floorPicker.below")}
      </button>
    </div>
  );
  return createPortal(panel, host);
}
