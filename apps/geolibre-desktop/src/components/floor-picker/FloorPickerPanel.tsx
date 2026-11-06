import {
  collectLevels,
  mergeLevels,
  selectLevel,
  useAppStore,
  type GeoLibreLayer,
  type LayerLevelFilter,
  type LevelEntry,
  type LevelFilterMode,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { cn } from "@geolibre/ui";
import { Layers2 } from "lucide-react";
import { useEffect, useMemo, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useMapPanelControl } from "../../hooks/useMapPanelControl";

/** Class on the floor picker's map-control host, for scoped CSS and tests. */
export const FLOOR_PICKER_CLASS = "geolibre-floor-picker";

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
 * Whether two links store the same choice, independent of key order (a
 * project written by the Python API may order the keys differently).
 */
export function sameLevelLink(a: LayerLevelFilter, b: LayerLevelFilter): boolean {
  if (a.field !== b.field) return false;
  if ((a.mode ?? "all") !== (b.mode ?? "all")) return false;
  if ((a.level ?? null) !== (b.level ?? null)) return false;
  const av = a.values;
  const bv = b.values;
  if (av === undefined || bv === undefined) return av === bv;
  return av.length === bv.length && av.every((value, index) => value === bv[index]);
}

/**
 * The shared floor choice the picker shows: the first linked layer that has a
 * floor chosen, so a layer linked later (still on `all`) does not reset the
 * display.
 *
 * @param linked - The linked layers.
 * @returns The chosen level (`null` for every floor) and mode.
 */
export function currentLevelChoice(linked: readonly GeoLibreLayer[]): {
  level: string | null;
  mode: LevelFilterMode;
} {
  for (const layer of linked) {
    const link = layer.levelFilter;
    if (link && link.mode && link.mode !== "all" && typeof link.level === "string") {
      return { level: link.level, mode: link.mode };
    }
  }
  return { level: null, mode: "all" };
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
  const updateLayer = useAppStore((state) => state.updateLayer);

  const visibleLinked = useMemo(() => linked.filter((layer) => layer.visible), [linked]);
  const levels = useMemo(() => mergeLevels(visibleLinked.map(layerLevels)), [visibleLinked]);
  const choice = useMemo(() => currentLevelChoice(linked), [linked]);

  // Keep every linked layer on the shared choice, with its matching values
  // resolved from its own features: a layer linked after a floor was chosen,
  // a project authored without the values (the Python API without inline
  // data), or data that changed since the choice was made.
  useEffect(() => {
    for (const layer of linked) {
      const link = layer.levelFilter;
      if (!link || !layer.geojson) continue;
      const next = selectLevel(link, layer.geojson.features, choice.level, choice.mode);
      if (!sameLevelLink(link, next)) updateLayer(layer.id, { levelFilter: next });
    }
  }, [linked, choice, updateLayer]);

  const visible = visibleLinked.length > 0 && levels.length > 0;
  const host = useMapPanelControl(
    mapControllerRef,
    visible,
    "top-right",
    `${FLOOR_PICKER_CLASS} maplibregl-ctrl`,
    mapReadyGeneration,
  );
  if (!visible || !host) return null;

  const below = choice.mode === "below";
  const choose = (level: string | null) => {
    if (level === null) setLevelSelection(null, "all");
    else setLevelSelection(level, below ? "below" : "only");
  };
  const toggleBelow = () => {
    if (choice.level === null) return;
    setLevelSelection(choice.level, below ? "only" : "below");
  };

  // A fixed light palette, not theme tokens: GeoLibre keeps the map chrome
  // (zoom, compass, layer controls) white in both themes, and the theme's
  // primary turns pale in dark mode, which would hide the chosen floor.
  const panel = (
    <div
      role="group"
      aria-label={t("floorPicker.title")}
      className="geolibre-floor-picker-panel flex w-14 flex-col items-stretch overflow-hidden rounded bg-white text-xs text-neutral-800 shadow"
      data-testid="floor-picker"
    >
      <div
        className="flex items-center justify-center gap-1 border-b border-neutral-200 py-1 font-medium"
        title={t("floorPicker.title")}
      >
        <Layers2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{t("floorPicker.short")}</span>
      </div>
      <button
        type="button"
        className={cn(
          "px-1 py-1 hover:bg-neutral-100",
          choice.level === null && "bg-blue-600 text-white hover:bg-blue-600",
        )}
        aria-pressed={choice.level === null}
        title={t("floorPicker.allTitle")}
        onClick={() => choose(null)}
        data-testid="floor-picker-all"
      >
        {t("floorPicker.all")}
      </button>
      <div className="max-h-64 overflow-y-auto">
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
                "block w-full truncate border-t border-neutral-100 px-1 py-1 tabular-nums hover:bg-neutral-100",
                active && "bg-blue-600 font-semibold text-white hover:bg-blue-600",
                !active && shown && "bg-neutral-100",
              )}
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
      <button
        type="button"
        className={cn(
          "border-t border-neutral-200 px-1 py-1 text-[10px] leading-tight hover:bg-neutral-100 disabled:opacity-50",
          below && "font-semibold text-blue-700",
        )}
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
