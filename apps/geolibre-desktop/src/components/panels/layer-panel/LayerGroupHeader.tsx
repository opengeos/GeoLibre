import { type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@geolibre/core";
import type { LayerGroup } from "@geolibre/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import {
  ArrowDownAZ,
  ArrowDownZA,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { openAddData } from "../../layout/add-data/open-add-data";
import type { ADD_DATA_DIALOG_SOURCES } from "./layer-panel-utils";
import { LayerOpacitySlider } from "./LayerOpacitySlider";
import type { LayerRename } from "./useLayerRename";

interface LayerGroupHeaderProps {
  group: LayerGroup;
  /** Nesting depth of the group, in rem of inline-start indent. */
  depth: number;
  /** Whether a dragged layer is hovering this header. */
  isDropTarget: boolean;
  moveability: { up: boolean; down: boolean } | undefined;
  sortability: { asc: boolean; desc: boolean } | undefined;
  /** Groups this one can be moved into (not itself or a descendant). */
  moveTargets: LayerGroup[];
  /** The Add Data sources offered by "Add data to group". */
  addDataGroupSources: typeof ADD_DATA_DIALOG_SOURCES;
  rename: Pick<
    LayerRename,
    | "editingGroupId"
    | "editingGroupName"
    | "setEditingGroupName"
    | "beginGroupRename"
    | "commitGroupRename"
    | "cancelGroupRename"
  >;
  onDragOver: (event: ReactDragEvent<HTMLDivElement>, groupId: string) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>, groupId: string) => void;
}

/** A group (folder) header row in the layer list, with its actions menu. */
export function LayerGroupHeader({
  group,
  depth,
  isDropTarget,
  moveability,
  sortability,
  moveTargets,
  addDataGroupSources,
  rename,
  onDragOver,
  onDrop,
}: LayerGroupHeaderProps) {
  const { i18n, t } = useTranslation();
  const removeLayerGroup = useAppStore((s) => s.removeLayerGroup);
  const setLayerGroupVisibility = useAppStore((s) => s.setLayerGroupVisibility);
  const setLayerGroupOpacity = useAppStore((s) => s.setLayerGroupOpacity);
  const toggleLayerGroupCollapsed = useAppStore((s) => s.toggleLayerGroupCollapsed);
  const moveLayerGroupToGroup = useAppStore((s) => s.moveLayerGroupToGroup);
  const reorderLayerGroup = useAppStore((s) => s.reorderLayerGroup);
  const sortLayerGroup = useAppStore((s) => s.sortLayerGroup);
  const {
    editingGroupId,
    editingGroupName,
    setEditingGroupName,
    beginGroupRename,
    commitGroupRename,
    cancelGroupRename,
  } = rename;
  return (
    <div
      data-group-header=""
      data-testid="layer-group-header"
      data-group-name={group.name}
      className={`w-full min-w-0 max-w-full rounded-md border p-2 transition-colors ${
        isDropTarget
          ? "border-primary bg-primary/10"
          : "border-border bg-muted/30 hover:border-muted-foreground/40"
      }`}
      style={{
        marginInlineStart: `${depth}rem`,
        width: `calc(100% - ${depth}rem)`,
      }}
      onDragOver={(e) => onDragOver(e, group.id)}
      onDrop={(e) => onDrop(e, group.id)}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          title={group.collapsed ? t("layers.expandGroup") : t("layers.collapseGroup")}
          aria-label={group.collapsed ? t("layers.expandGroup") : t("layers.collapseGroup")}
          aria-expanded={!group.collapsed}
          onClick={(e) => {
            e.stopPropagation();
            toggleLayerGroupCollapsed(group.id);
          }}
        >
          {group.collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          type="button"
          className="rounded p-0.5 hover:bg-muted"
          title={group.visible ? t("layers.hideGroup") : t("layers.showGroup")}
          aria-label={group.visible ? t("layers.hideGroup") : t("layers.showGroup")}
          onClick={(e) => {
            e.stopPropagation();
            setLayerGroupVisibility(group.id, !group.visible);
          }}
        >
          {group.visible ? (
            <Eye className="h-3.5 w-3.5" />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
        {group.collapsed ? (
          <Folder className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        {editingGroupId === group.id ? (
          <input
            autoFocus
            type="text"
            className="flex-1 min-w-0 rounded border border-input bg-background px-1 py-0.5 text-sm font-semibold outline-none focus:ring-1 focus:ring-ring"
            value={editingGroupName}
            aria-label={t("layers.renameNamed", { name: group.name })}
            onChange={(e) => setEditingGroupName(e.target.value)}
            onClick={(e: ReactMouseEvent) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitGroupRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                commitGroupRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelGroupRename();
              }
            }}
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-sm font-semibold"
            title={t("layers.doubleClickToRename")}
            onDoubleClick={(e: ReactMouseEvent) => {
              e.stopPropagation();
              beginGroupRename(group);
            }}
          >
            {group.name}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t("layers.groupActions")}
              aria-label={t("layers.groupActions")}
              onClick={(e: ReactMouseEvent) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e: ReactMouseEvent) => e.stopPropagation()}>
            <DropdownMenuItem
              onSelect={(e: Event) => {
                e.preventDefault();
                beginGroupRename(group);
              }}
            >
              <Pencil className="me-2 h-3.5 w-3.5" />
              {t("layers.renameGroup")}
            </DropdownMenuItem>
            {addDataGroupSources.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderPlus className="h-3.5 w-3.5" />
                  {t("layers.addDataToGroup")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {addDataGroupSources.map((entry) => (
                    <DropdownMenuItem
                      key={entry.id}
                      onSelect={() => openAddData(entry.id, { groupId: group.id })}
                    >
                      {t(entry.labelKey)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {moveTargets.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Folder className="h-3.5 w-3.5" />
                  {t("layers.moveToGroup")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {moveTargets.map((target) => (
                    <DropdownMenuItem
                      key={target.id}
                      disabled={group.parentId === target.id}
                      onSelect={() => moveLayerGroupToGroup(group.id, target.id)}
                    >
                      {target.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {group.parentId && (
              <DropdownMenuItem onSelect={() => moveLayerGroupToGroup(group.id, null)}>
                <FolderMinus className="me-2 h-3.5 w-3.5" />
                {t("layers.removeFromGroup")}
              </DropdownMenuItem>
            )}
            {/* Action items below omit preventDefault so Radix dismisses the
                menu on select; only the rename item above keeps it, so the
                menu's close does not race its input autofocus. */}
            <DropdownMenuItem
              disabled={!moveability?.up}
              onSelect={() => {
                reorderLayerGroup(group.id, "up");
              }}
            >
              <ChevronUp className="me-2 h-3.5 w-3.5" />
              {t("layers.moveGroupUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!moveability?.down}
              onSelect={() => {
                reorderLayerGroup(group.id, "down");
              }}
            >
              <ChevronDown className="me-2 h-3.5 w-3.5" />
              {t("layers.moveGroupDown")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!sortability?.asc}
              onSelect={() => {
                sortLayerGroup(group.id, "asc", i18n.language);
              }}
            >
              <ArrowDownAZ className="me-2 h-3.5 w-3.5" />
              {t("layers.sortGroupAscending")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!sortability?.desc}
              onSelect={() => {
                sortLayerGroup(group.id, "desc", i18n.language);
              }}
            >
              <ArrowDownZA className="me-2 h-3.5 w-3.5" />
              {t("layers.sortGroupDescending")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                removeLayerGroup(group.id);
              }}
            >
              <FolderMinus className="me-2 h-3.5 w-3.5" />
              {t("layers.ungroupKeepLayers")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => {
                removeLayerGroup(group.id, { removeChildren: true });
              }}
            >
              <Trash2 className="me-2 h-3.5 w-3.5" />
              {t("layers.deleteGroupAndLayers")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!group.collapsed && (
        <LayerOpacitySlider
          label={t("layers.groupOpacity")}
          ariaLabel={t("layers.groupOpacityAria", { name: group.name })}
          value={group.opacity}
          onChange={(v) => setLayerGroupOpacity(group.id, v)}
        />
      )}
    </div>
  );
}
