import { cn } from "@geolibre/ui";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  FolderOpen,
  Globe2,
  type LucideIcon,
} from "lucide-react";
import type { BrowserNode } from "../../lib/browser-tree";

interface BrowserTreeNodeProps {
  node: BrowserNode;
  /** Nesting depth, for the row's left indent. */
  depth: number;
  /** Ids of the currently expanded group nodes. */
  expanded: ReadonlySet<string>;
  /** Toggle a group node's expanded state. */
  onToggle: (id: string) => void;
  /** Activate a leaf (add a service layer, or open a recent project). */
  onActivate: (node: BrowserNode) => void;
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
  onToggle,
  onActivate,
}: BrowserTreeNodeProps) {
  const isGroup = Boolean(node.children);
  const isExpanded = expanded.has(node.id);
  const Icon = nodeIcon(node, isExpanded);
  // Indent by depth; groups reserve room for the chevron, leaves align to it.
  const paddingLeft = 8 + depth * 14;

  return (
    <li>
      <button
        type="button"
        className={cn(
          "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm",
          "hover:bg-accent hover:text-accent-foreground",
          node.kind === "section" && "font-semibold",
        )}
        style={{ paddingLeft }}
        aria-expanded={isGroup ? isExpanded : undefined}
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
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.label}</span>
        {typeof node.count === "number" && node.count > 0 ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {node.count}
          </span>
        ) : null}
      </button>
      {isGroup && isExpanded ? (
        <ul>
          {node.children?.map((child) => (
            <BrowserTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onActivate={onActivate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
