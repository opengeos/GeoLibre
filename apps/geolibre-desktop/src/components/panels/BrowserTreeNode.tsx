import { cn } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  File,
  Folder,
  FolderOpen,
  Globe2,
  Loader2,
  Plus,
  Star,
  Table,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AddDataKind } from "../layout/AddDataDialog";
import { isFavoritableKind } from "../../lib/browser-favorites";
import type { BrowserNode } from "../../lib/browser-tree";

interface BrowserTreeNodeProps {
  node: BrowserNode;
  /** Nesting depth, for the row's left indent. */
  depth: number;
  /** Ids of the currently expanded group nodes. */
  expanded: ReadonlySet<string>;
  /** Id of the leaf whose activation is in flight, or null when idle. */
  busyId: string | null;
  /** Id of the row that is the tree's single tab stop (roving tabindex). */
  activeRowId: string | null;
  /** Sync the active row when a row receives focus (mouse click or Tab). */
  onRowFocus: (id: string) => void;
  /** Toggle a group node's expanded state. */
  onToggle: (id: string) => void;
  /** Activate a leaf (add a service/file layer, or open a recent project). */
  onActivate: (node: BrowserNode) => void;
  /** Open Add Data at `kind` for a group's "New connection" (＋) action. */
  onNewConnection: (kind: AddDataKind) => void;
  /** Pick a folder to pin, for the Files section's "Add folder" (＋) action. */
  onAddFolder: () => void;
  /** Unpin a pinned root folder (its ×), by path. */
  onRemoveFolder: (path: string) => void;
  /** Ids of currently-favorited nodes, for the star fill state. */
  favoriteIds: ReadonlySet<string>;
  /** Toggle a favoritable node's favorite state (its ☆/★). */
  onToggleFavorite: (node: BrowserNode) => void;
}

/** The leading icon for a node, chosen by kind (and expanded state for groups). */
function nodeIcon(node: BrowserNode, isExpanded: boolean): LucideIcon {
  switch (node.kind) {
    case "recent-project":
      return Clock;
    case "service":
      return Globe2;
    case "connection":
      return Database;
    case "table":
      return Table;
    case "file":
      return File;
    default:
      return isExpanded ? FolderOpen : Folder;
  }
}

/**
 * One row in the Browser tree, rendered recursively. Group nodes
 * (section/category) toggle their children; leaf nodes (service/recent-project)
 * activate on click. Indentation reflects depth.
 */
export function BrowserTreeNode({
  node,
  depth,
  expanded,
  busyId,
  activeRowId,
  onRowFocus,
  onToggle,
  onActivate,
  onNewConnection,
  onAddFolder,
  onRemoveFolder,
  favoriteIds,
  onToggleFavorite,
}: BrowserTreeNodeProps) {
  const { t } = useTranslation();
  // A status row (loading / error) is non-interactive text, not a tree control.
  if (node.kind === "info") {
    return (
      // role="none" so the status row isn't an extra listitem in the tree.
      <li role="none">
        <p
          className="truncate py-1 text-xs text-muted-foreground"
          style={{ paddingLeft: 8 + depth * 14 }}
          title={node.label}
          // Announce the loading→tables/error transition to screen readers.
          role="status"
          aria-live="polite"
        >
          {node.label}
        </p>
      </li>
    );
  }
  const isGroup = Boolean(node.children);
  const isExpanded = expanded.has(node.id);
  const Icon = nodeIcon(node, isExpanded);
  const isBusy = busyId === node.id;
  // A leaf is disabled while any activation is in flight (matching the guard in
  // BrowserPanel.activate), so a click on a busy panel gives visible feedback
  // rather than being silently swallowed.
  const isDisabled = !isGroup && busyId != null;
  // Indent by depth; groups reserve room for the chevron, leaves align to it.
  const paddingLeft = 8 + depth * 14;
  // The Add Data source this node's ＋ opens (or undefined). Captured as a const
  // so its non-undefined narrowing survives into the onClick closure — a
  // property access (node.newConnectionKind) would not, forcing a cast.
  const newConnectionKind = node.newConnectionKind;
  // The Databases section's ＋ (which opens the "postgres" source) reads "New
  // database connection"; a service-kind group's reads e.g. "New WMS
  // connection" (distinguishable per group for screen-reader users). Keyed off
  // the source it opens rather than node.kind, so a future section with a
  // different ＋ source gets the right label.
  const newConnectionLabel =
    newConnectionKind === "postgres"
      ? t("browser.newDatabaseConnection")
      : t("browser.newConnection", { kind: node.label });
  // The trailing ＋ affordance: a service/database group opens Add Data; the
  // Files section opens a folder picker. At most one applies per node.
  const plusAction = newConnectionKind
    ? { label: newConnectionLabel, run: () => onNewConnection(newConnectionKind) }
    : node.addFolderAction
      ? { label: t("browser.addFolder"), run: onAddFolder }
      : null;
  // Pinned root folders show a × to unpin them from the Files section.
  const removePath = node.removable ? node.path : undefined;
  // Favoritable nodes (services, connections, folders, files) show a star to
  // pin/unpin them to the Favorites section.
  const favoritable = isFavoritableKind(node.kind);
  const favorited = favoritable && favoriteIds.has(node.id);

  return (
    // role="none": the treeitem role lives on the inner button, so the <li>
    // must not add a listitem role to the tree/group.
    <li role="none">
      <div className="group flex items-center">
        <button
          type="button"
          disabled={isDisabled}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-start text-sm",
            "hover:bg-accent hover:text-accent-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
            node.kind === "section" && "font-semibold",
          )}
          style={{ paddingLeft }}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isGroup ? isExpanded : undefined}
          aria-busy={isBusy || undefined}
          // Roving tabindex: only the active row is a tab stop; the panel's
          // Arrow-key handler moves the active row and focuses it.
          tabIndex={node.id === activeRowId ? 0 : -1}
          data-browser-row={node.id}
          onFocus={() => onRowFocus(node.id)}
          onClick={() => {
            // Also sync from onClick: some browsers (WebKit) don't focus a
            // button on mouse click, so onFocus alone would leave the roving
            // active row stale after a click.
            onRowFocus(node.id);
            if (isGroup) onToggle(node.id);
            else onActivate(node);
          }}
        >
          {isGroup ? (
            isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground rtl:rotate-180" />
            )
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.label}</span>
          {node.builtin ? (
            <span className="ms-1 shrink-0 rounded border px-1 text-[10px] uppercase leading-tight text-muted-foreground">
              {t("browser.builtinBadge")}
            </span>
          ) : null}
          {typeof node.count === "number" && node.count > 0 ? (
            <span className="ms-auto shrink-0 text-xs text-muted-foreground">{node.count}</span>
          ) : null}
        </button>
        {favoritable ? (
          <button
            type="button"
            className={cn(
              "me-1 shrink-0 rounded p-1 hover:bg-accent hover:text-accent-foreground",
              favorited
                ? "text-amber-500"
                : // Unpinned: reveal on row hover / keyboard focus to reduce clutter.
                  "text-muted-foreground opacity-0 focus:opacity-100 group-hover:opacity-100",
            )}
            title={
              favorited
                ? t("browser.unfavorite", { name: node.label })
                : t("browser.favorite", { name: node.label })
            }
            aria-label={
              favorited
                ? t("browser.unfavorite", { name: node.label })
                : t("browser.favorite", { name: node.label })
            }
            aria-pressed={favorited}
            tabIndex={node.id === activeRowId ? 0 : -1}
            onClick={() => onToggleFavorite(node)}
          >
            <Star className={cn("h-3.5 w-3.5", favorited && "fill-current")} />
          </button>
        ) : null}
        {removePath ? (
          <button
            type="button"
            className="me-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t("browser.unpinFolder", { name: node.label })}
            aria-label={t("browser.unpinFolder", { name: node.label })}
            tabIndex={node.id === activeRowId ? 0 : -1}
            onClick={() => onRemoveFolder(removePath)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
        {plusAction ? (
          <button
            type="button"
            className="me-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={plusAction.label}
            aria-label={plusAction.label}
            tabIndex={node.id === activeRowId ? 0 : -1}
            onClick={plusAction.run}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {isGroup && isExpanded ? (
        node.children && node.children.length > 0 ? (
          <ul role="group">
            {node.children.map((child) => (
              <BrowserTreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                busyId={busyId}
                activeRowId={activeRowId}
                onRowFocus={onRowFocus}
                onToggle={onToggle}
                onActivate={onActivate}
                onNewConnection={onNewConnection}
                onAddFolder={onAddFolder}
                onRemoveFolder={onRemoveFolder}
                favoriteIds={favoriteIds}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </ul>
        ) : (
          // An expanded group with no children (e.g. Recent before any project
          // is opened) shows a hint instead of a bare gap.
          <p
            className="truncate py-1 text-xs text-muted-foreground"
            style={{ paddingLeft: paddingLeft + 14 }}
          >
            {t("browser.emptyGroup")}
          </p>
        )
      ) : null}
    </li>
  );
}
