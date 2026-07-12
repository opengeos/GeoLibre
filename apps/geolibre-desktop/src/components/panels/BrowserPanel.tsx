import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { Button, Input, ScrollArea } from "@geolibre/ui";
import { FolderTree, Search, X } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
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
 * saved-service library (grouped by category) and recent projects; clicking a
 * service adds it to the map via {@link applyServiceEntry}, and clicking a
 * recent project opens it.
 *
 * Docked in the left rail by {@link DesktopShell}; it reads its own open flag
 * from the store, so closing it flips `browserPanelOpen`.
 */
export function BrowserPanel({ mapControllerRef }: BrowserPanelProps) {
  const { t } = useTranslation();
  const setBrowserPanelOpen = useAppStore((s) => s.setBrowserPanelOpen);
  const addLayer = useAppStore((s) => s.addLayer);
  const { tree, serviceById } = useBrowserTree();
  const projectFiles = useProjectFileActions(mapControllerRef);

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(DEFAULT_EXPANDED),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (busyId != null) return;
    setError(null);
    // Also clear any prior recent-open failure: handleOpenRecent sets
    // projectFiles.actionError but this panel owns an isolated hook instance
    // with no other reset path, so a stale banner would otherwise persist.
    projectFiles.setActionError(null);
    if (node.kind === "service" && node.serviceId) {
      const entry = serviceById(node.serviceId);
      if (!entry) return;
      setBusyId(node.id);
      try {
        await applyServiceEntry(entry, { addLayer, mapControllerRef });
      } catch (err) {
        // applyServiceEntry's thrown messages are developer-facing fallbacks
        // (see its JSDoc), so show the translated generic message to the user
        // and keep the detail in the console for debugging.
        console.error("Failed to add service", err);
        setError(t("browser.addFailed"));
      } finally {
        setBusyId(null);
      }
    } else if (node.kind === "recent-project" && node.projectPath) {
      // Keep the panel open until the open settles: handleOpenRecent never
      // throws (it records a failure in projectFiles.actionError, surfaced
      // below), so closing early would hide that error from the user.
      setBusyId(node.id);
      try {
        await projectFiles.handleOpenRecent(node.projectPath);
      } finally {
        setBusyId(null);
      }
    }
  };

  const hasContent = filtered.some((section) => section.children?.length);

  return (
    <section
      aria-label={t("browser.title")}
      // A fixed-width left rail on desktop; below the md breakpoint (where the
      // workspace row is a column and the Layers/Style panels already overlay at
      // z-30) it becomes a full-workspace sheet at z-40 with its own close
      // button, so it neither pushes the map off-screen nor overlaps the Layers
      // overlay — the user dismisses it to return to the map.
      className="relative flex w-full shrink-0 flex-col overflow-hidden bg-card max-md:absolute max-md:inset-0 max-md:z-40 md:w-72 md:border-r"
    >
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <FolderTree className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("browser.title")}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-8 w-8"
          title={t("browser.close")}
          aria-label={t("browser.close")}
          onClick={() => setBrowserPanelOpen(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

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
    </section>
  );
}
