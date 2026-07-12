import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Input, ScrollArea } from "@geolibre/ui";
import { Search } from "lucide-react";
import { useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useProjectFileActions } from "../../hooks/useProjectFileActions";
import { useBrowserTree } from "../../hooks/useBrowserTree";
import { filterBrowserTree, type BrowserNode } from "../../lib/browser-tree";
import { applyServiceEntry } from "../layout/add-data/apply-service";
import { BrowserTreeNode } from "./BrowserTreeNode";

interface BrowserPanelProps {
  mapControllerRef: RefObject<MapController | null>;
}

/** The section nodes are expanded by default so their contents are visible. */
const DEFAULT_EXPANDED = new Set(["section:services", "section:recent"]);

/** Collects every group node id in a tree (used to expand-all while searching). */
function collectGroupIds(nodes: readonly BrowserNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.children) {
      into.add(node.id);
      collectGroupIds(node.children, into);
    }
  }
}

/**
 * The Browser (Data Source Manager) panel — a QGIS-style tree that unifies the
 * app's data entry points into one navigable surface. This MVP lists the
 * saved-service library (grouped by kind) and recent projects; clicking a
 * service adds it to the map via {@link applyServiceEntry}, and clicking a
 * recent project opens it.
 *
 * Registered as a first-class dockable right panel (see useRegisterBrowserPanel),
 * so the shell owns the panel chrome — title, move/merge/collapse/close buttons,
 * and the left/right dock (defaulting to the shared Layers rail). This component
 * renders only the panel body (search + tree).
 */
export function BrowserPanel({ mapControllerRef }: BrowserPanelProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((s) => s.addLayer);
  const { tree, serviceById } = useBrowserTree();
  const projectFiles = useProjectFileActions(mapControllerRef);

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ref mirror of busyId for the re-entrancy guard: two clicks dispatched
  // back-to-back (before React commits the state update and the button's
  // disabled prop) would both read a stale `busyId === null`, so the guard
  // checks the ref, which is set synchronously (cf. isSavingRef in
  // useProjectFileActions). The state drives the spinner/disabled UI.
  const busyRef = useRef<string | null>(null);
  const beginBusy = (id: string) => {
    busyRef.current = id;
    setBusyId(id);
  };
  const endBusy = () => {
    busyRef.current = null;
    setBusyId(null);
  };

  const filtered = useMemo(
    () => filterBrowserTree(tree, query),
    [tree, query],
  );

  // While searching, expand every group so matches deep in the tree are
  // visible without the user hunting for them; otherwise use their choices.
  const effectiveExpanded = useMemo(() => {
    if (!query.trim()) return expanded;
    const all = new Set(expanded);
    collectGroupIds(filtered, all);
    return all;
  }, [query, expanded, filtered]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const activate = async (node: BrowserNode) => {
    // Ignore a second activation while one is still resolving (a fast
    // double-click, or clicking another entry mid-fetch), so an async add
    // cannot run twice and duplicate the layer.
    if (busyRef.current != null) return;
    setError(null);
    // Also clear any prior recent-open failure: handleOpenRecent sets
    // projectFiles.actionError but this panel owns an isolated hook instance
    // with no other reset path, so a stale banner would otherwise persist.
    projectFiles.setActionError(null);
    if (node.kind === "service" && node.serviceId) {
      const entry = serviceById(node.serviceId);
      if (!entry) {
        // The saved-service list is read when the panel opens, so an entry can
        // vanish (removed via the Add Data dialog, or in another tab) between
        // the tree being built and this click; surface it rather than silently
        // doing nothing.
        setError(t("browser.addFailed"));
        return;
      }
      beginBusy(node.id);
      try {
        await applyServiceEntry(entry, { addLayer, mapControllerRef });
      } catch (err) {
        // applyServiceEntry's thrown messages are developer-facing fallbacks
        // (see its JSDoc), so show the translated generic message to the user
        // and keep the detail in the console for debugging.
        console.error("Failed to add service", err);
        setError(t("browser.addFailed"));
      } finally {
        endBusy();
      }
    } else if (node.kind === "recent-project" && node.projectPath) {
      // Keep the panel open until the open settles: handleOpenRecent never
      // throws (it records a failure in projectFiles.actionError, surfaced
      // below), so closing early would hide that error from the user.
      beginBusy(node.id);
      try {
        await projectFiles.handleOpenRecent(node.projectPath);
      } finally {
        endBusy();
      }
    }
  };

  const hasContent = filtered.some((section) => section.children?.length);

  return (
    // Body only: the shell (PluginRightPanel / SharedSidebar) renders the header,
    // move/merge/collapse/close controls, and the dock rail around this.
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b px-2 py-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 pl-7 text-sm"
          placeholder={t("browser.searchPlaceholder")}
          value={query}
          aria-label={t("browser.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error ?? projectFiles.actionError ? (
        <p className="border-b px-3 py-2 text-xs text-destructive">
          {error ?? projectFiles.actionError}
        </p>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {hasContent ? (
          <ul className="py-1" aria-busy={busyId != null}>
            {filtered.map((section) => (
              <BrowserTreeNode
                key={section.id}
                node={section}
                depth={0}
                expanded={effectiveExpanded}
                busyId={busyId}
                onToggle={toggle}
                onActivate={activate}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {query.trim()
              ? t("browser.noMatches")
              : t("browser.empty")}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}
