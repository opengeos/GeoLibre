import { clearQuickFilterValues, hasActiveQuickFilter, useAppStore } from "@geolibre/core";
import type { GeoLibreLayer, LayerGroup, LayerQuickFilter } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button } from "@geolibre/ui";
import { Eye, EyeOff, Folder, Layers } from "lucide-react";
import { Fragment, useMemo, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQuickFilterProfiles } from "../../hooks/useQuickFilterProfiles";
import { QuickFilterControl } from "./QuickFilterControl";

/** Indent per group nesting level, in rem, mirroring the Layers panel's tree. */
const GROUP_INDENT_REM = 0.75;

interface ViewerLayerPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  /** Bumped when the map (re)initializes; see {@link useQuickFilterProfiles}. */
  mapReadyGeneration?: number;
}

interface ViewerQuickFiltersProps {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapController | null>;
  mapReadyGeneration?: number;
  indentRem: number;
}

/**
 * A viewer-mode layer's quick filters.
 *
 * `layout=viewer` hides the authoring surfaces, but a quick filter is a way of
 * *reading* the map, not of editing it: without these controls a shared project
 * is merely readable, and the person it was shared with cannot ask it anything.
 * Only the controls the project's author configured are shown — there is no way
 * to add or remove one here — and clearing them is one obvious action.
 */
function ViewerQuickFilters({
  layer,
  mapControllerRef,
  mapReadyGeneration,
  indentRem,
}: ViewerQuickFiltersProps) {
  const { t } = useTranslation();
  const setLayerQuickFilters = useAppStore((s) => s.setLayerQuickFilters);
  const { byField } = useQuickFilterProfiles(layer, mapControllerRef, mapReadyGeneration);
  const filters = useMemo(() => layer.quickFilters ?? [], [layer.quickFilters]);
  const active = hasActiveQuickFilter(layer);

  const update = (next: LayerQuickFilter[]): void => setLayerQuickFilters(layer.id, next);

  return (
    <div className="space-y-1.5 pb-1" style={{ marginInlineStart: `${indentRem}rem` }}>
      {filters.map((filter) => (
        <QuickFilterControl
          key={filter.id}
          filter={filter}
          profile={byField.get(filter.field)}
          idPrefix={`viewer-${layer.id}`}
          onChange={(next) =>
            update(filters.map((current) => (current.id === filter.id ? next : current)))
          }
        />
      ))}
      {active && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-full justify-start px-2 text-xs"
          onClick={() => update(clearQuickFilterValues(filters))}
        >
          {t("quickFilters.clearAll")}
        </Button>
      )}
    </div>
  );
}

/**
 * Read-only layer legend used by the viewer embed preset.
 *
 * Layers are listed top-most first and grouped the way the authoring Layers
 * panel groups them, so a project whose folders carry meaning ("Basemaps" vs
 * "Overlays") reads the same in the viewer. Group members are kept contiguous
 * in the store's layer order, so each folder header is drawn inline above its
 * first member. Unlike the Layers panel this is a legend: folders are labels,
 * not drop targets, and the per-layer controls are limited to the visibility
 * toggle and whatever quick filters the project's author configured (see
 * {@link ViewerQuickFilters}).
 */
export function ViewerLayerPanel({ mapControllerRef, mapReadyGeneration }: ViewerLayerPanelProps) {
  const { t } = useTranslation();
  const layers = useAppStore((state) => state.layers);
  const layerGroups = useAppStore((state) => state.layerGroups);
  const setLayerVisibility = useAppStore((state) => state.setLayerVisibility);

  const groupById = useMemo(
    () => new Map(layerGroups.map((group) => [group.id, group] as const)),
    [layerGroups],
  );

  // Each layer paired with the folder headers to draw above it: the chain from
  // the outermost ancestor down to its own group, emitted once, at the group's
  // first member. `visited` guards a parent cycle in a hand-edited project.
  const rows = useMemo(() => {
    const emitted = new Set<string>();
    return [...layers].reverse().map((layer) => {
      const chain: LayerGroup[] = [];
      let groupId = layer.groupId;
      const visited = new Set<string>();
      while (groupId && !visited.has(groupId)) {
        visited.add(groupId);
        const group = groupById.get(groupId);
        if (!group) break;
        chain.unshift(group);
        groupId = group.parentId;
      }
      const headers = chain.filter((group) => !emitted.has(group.id));
      for (const group of headers) emitted.add(group.id);
      return { layer, headers, depth: chain.length };
    });
  }, [groupById, layers]);

  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-e bg-card p-3">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Layers className="h-4 w-4" />
        {t("sharedRail.layers")}
      </h2>
      <div className="space-y-1">
        {rows.map(({ layer, headers, depth }) => (
          <Fragment key={layer.id}>
            {headers.map((group, index) => (
              <div
                key={group.id}
                className="flex items-center gap-2 px-2 py-1.5 text-xs font-medium text-muted-foreground"
                style={{
                  marginInlineStart: `${(depth - headers.length + index) * GROUP_INDENT_REM}rem`,
                }}
              >
                <Folder className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{group.name}</span>
              </div>
            ))}
            <label
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted focus-within:outline-none focus-within:ring-2 focus-within:ring-ring"
              style={{ marginInlineStart: `${depth * GROUP_INDENT_REM}rem` }}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={layer.visible}
                onChange={(event) => setLayerVisibility(layer.id, event.target.checked)}
              />
              {layer.visible ? (
                <Eye className="h-4 w-4 text-primary" />
              ) : (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="truncate">{layer.name}</span>
            </label>
            {(layer.quickFilters?.length ?? 0) > 0 && (
              <ViewerQuickFilters
                layer={layer}
                mapControllerRef={mapControllerRef}
                mapReadyGeneration={mapReadyGeneration}
                indentRem={depth * GROUP_INDENT_REM}
              />
            )}
          </Fragment>
        ))}
      </div>
    </aside>
  );
}
