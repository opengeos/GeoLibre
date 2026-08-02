import { useAppStore } from "@geolibre/core";
import type { LayerGroup } from "@geolibre/core";
import { Eye, EyeOff, Folder, Layers } from "lucide-react";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";

/** Indent per group nesting level, in rem, mirroring the Layers panel's tree. */
const GROUP_INDENT_REM = 0.75;

/**
 * Read-only layer legend used by the viewer embed preset.
 *
 * Layers are listed top-most first and grouped the way the authoring Layers
 * panel groups them, so a project whose folders carry meaning ("Basemaps" vs
 * "Overlays") reads the same in the viewer. Group members are kept contiguous
 * in the store's layer order, so each folder header is drawn inline above its
 * first member. Unlike the Layers panel this is a legend: folders are labels,
 * not drop targets, and only the per-layer visibility toggle is offered.
 */
export function ViewerLayerPanel() {
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
          </Fragment>
        ))}
      </div>
    </aside>
  );
}
