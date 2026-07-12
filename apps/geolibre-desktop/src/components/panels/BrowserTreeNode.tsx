import { cn } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  FolderOpen,
  Globe2,
  Loader2,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ServiceLibraryKind } from "../layout/add-data/service-library";
import type { BrowserNode } from "../../lib/browser-tree";

interface BrowserTreeNodeProps {
  node: BrowserNode;
  /** Nesting depth, for the row's left indent. */
  depth: number;
  /** Ids of the currently expanded group nodes. */
  expanded: ReadonlySet<string>;
  /** Id of the leaf whose activation is in flight, or null when idle. */
  busyId: string | null;
  /** Toggle a group node's expanded state. */
  onToggle: (id: string) => void;
  /** Activate a leaf (add a service layer, or open a recent project). */
  onActivate: (node: BrowserNode) => void;
  /** Add a new connection for a service-kind group (opens Add Data at it). */
  onNewConnection: (kind: ServiceLibraryKind) => void;
}

/** The leading icon for a node, chosen by kind (and expanded state for groups). */
function nodeIcon(node: BrowserNode, isExpanded: boolean): LucideIcon {
  switch (node.kind) {
    case "recent-project":
      return Clock;
    case "service":
      return Globe2;
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
  onToggle,
  onActivate,
  onNewConnection,
}: BrowserTreeNodeProps) {
  const { t } = useTranslation();
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
  // The kind group's service kind (or undefined). Captured as a const so its
  // non-undefined narrowing survives into the button's onClick closure — a
  // property access (node.serviceKind) would not, which is why a cast would
  // otherwise be needed there.
  const categoryKind =
    node.kind === "category" ? node.serviceKind : undefined;

  return (
    <li>
      <div className="flex items-center">
        <button
          type="button"
          disabled={isDisabled}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded px-2 py-1 text-left text-sm",
            "hover:bg-accent hover:text-accent-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
            node.kind === "section" && "font-semibold",
          )}
          style={{ paddingLeft }}
          aria-expanded={isGroup ? isExpanded : undefined}
          aria-busy={isBusy || undefined}
          onClick={() => (isGroup ? onToggle(node.id) : onActivate(node))}
        >
          {isGroup ? (
            isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
            <span className="ml-1 shrink-0 rounded border px-1 text-[10px] uppercase leading-tight text-muted-foreground">
              {t("browser.builtinBadge")}
            </span>
          ) : null}
          {typeof node.count === "number" && node.count > 0 ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {node.count}
            </span>
          ) : null}
        </button>
        {categoryKind ? (
          <button
            type="button"
            className="mr-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t("browser.newConnection", { kind: node.label })}
            aria-label={t("browser.newConnection", { kind: node.label })}
            onClick={() => onNewConnection(categoryKind)}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {isGroup && isExpanded ? (
        node.children && node.children.length > 0 ? (
          <ul>
            {node.children.map((child) => (
              <BrowserTreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                busyId={busyId}
                onToggle={onToggle}
                onActivate={onActivate}
                onNewConnection={onNewConnection}
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
