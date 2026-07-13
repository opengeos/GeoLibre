import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { fetchPostgisStatus, listPostgisTables } from "@geolibre/processing";
import { Input, ScrollArea } from "@geolibre/ui";
import { Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import { useBrowserTree } from "../../hooks/useBrowserTree";
import {
  buildPostgisTableNodes,
  filterBrowserTree,
  type BrowserNode,
} from "../../lib/browser-tree";
import { applyServiceEntry } from "../layout/add-data/apply-service";
import { errorMessage } from "../layout/add-data/helpers";
import type { AddDataKind } from "../layout/AddDataDialog";
import { openAddData } from "../layout/add-data/open-add-data";
import { BrowserTreeNode } from "./BrowserTreeNode";

/** Async load state for one connection's spatial-table introspection. */
type ConnectionLoad =
  | { status: "loading" }
  | { status: "loaded"; tables: { schema: string; table: string }[] }
  | { status: "error"; message: string };

/** The `connection:` id prefix a connection node carries (id = prefix + connString). */
const CONNECTION_ID_PREFIX = "connection:";

interface BrowserPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  /**
   * Open a recent project by path (shared with the toolbar's instance).
   * Resolves to an error message to show inline, or null on success.
   */
  onOpenRecentProject: (path: string) => Promise<string | null>;
}

/** The section nodes are expanded by default so their contents are visible. */
const DEFAULT_EXPANDED = new Set([
  "section:services",
  "section:recent",
  "section:databases",
]);

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
 * Returns a copy of the tree with each `connection` node's children replaced by
 * the current lazy-load state: a status row while loading or on error, or the
 * schema→table nodes once loaded. Connections with no load entry keep their
 * empty child list (still expandable; expanding triggers the fetch) — so search
 * only reaches the tables of connections that have already been introspected.
 *
 * @param nodes - The base tree from {@link useBrowserTree}.
 * @param loads - Per-connection introspection state keyed by connection string.
 * @param loadingLabel - Translated label for the "loading tables" status row.
 */
function augmentConnections(
  nodes: readonly BrowserNode[],
  loads: Record<string, ConnectionLoad>,
  loadingLabel: string,
): BrowserNode[] {
  return nodes.map((node) => {
    if (node.kind === "connection" && node.connectionString) {
      const load = loads[node.connectionString];
      let children: BrowserNode[] = [];
      if (load?.status === "loading") {
        children = [
          { id: `${node.id}:loading`, kind: "info", label: loadingLabel, addable: false },
        ];
      } else if (load?.status === "error") {
        children = [
          { id: `${node.id}:error`, kind: "info", label: load.message, addable: false },
        ];
      } else if (load?.status === "loaded") {
        children = buildPostgisTableNodes(node.connectionString, load.tables);
      }
      return { ...node, children };
    }
    if (node.children) {
      return {
        ...node,
        children: augmentConnections(node.children, loads, loadingLabel),
      };
    }
    return node;
  });
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
export function BrowserPanel({
  mapControllerRef,
  onOpenRecentProject,
}: BrowserPanelProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((s) => s.addLayer);
  const { tree, serviceById } = useBrowserTree();

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

  // Lazy PostGIS introspection: keyed by connection string, populated the first
  // time a connection node is expanded so we never hit the sidecar for a
  // connection the user hasn't opened.
  const [connLoads, setConnLoads] = useState<Record<string, ConnectionLoad>>(
    {},
  );
  // Tracks in-flight/settled fetches so a re-expand (or the expand-all a search
  // triggers) doesn't refetch. A failed fetch drops its entry so re-expanding
  // the connection retries (there is no separate refresh affordance).
  const connFetchedRef = useRef<Set<string>>(new Set());

  const fetchConnectionTables = useCallback(
    (connectionString: string) => {
      if (connFetchedRef.current.has(connectionString)) return;
      connFetchedRef.current.add(connectionString);
      setConnLoads((prev) => ({
        ...prev,
        [connectionString]: { status: "loading" },
      }));
      // The desktop sidecar is spawned on demand and only authenticated after
      // startGeoLibreSidecar runs, so ensure it is up before hitting /postgis —
      // best-effort, mirroring PostgresSource.handleConnectEditable (a failed
      // start still lets the status/list calls surface the real error).
      void startGeoLibreSidecar()
        .catch(() => {})
        .then(() => fetchPostgisStatus())
        .then((status) => {
          // Same runtime gate as the Add Data dialog, so a missing postgis
          // extra reads as the friendly "install the extra" message rather
          // than a raw connection error from /postgis/tables.
          if (!status.available) {
            throw new Error(t("addData.postgres.errorRuntimeMissing"));
          }
          return listPostgisTables(connectionString);
        })
        .then((tables) => {
          // geometry_columns returns one row per geometry column, so a table
          // with several geometry columns appears several times; keep the first
          // (mirrors PostgresSource.handleConnectEditable's dedup) so the tree
          // doesn't emit duplicate node ids.
          const seen = new Set<string>();
          const deduped: { schema: string; table: string }[] = [];
          for (const tbl of tables) {
            const key = `${tbl.schema}.${tbl.table}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push({ schema: tbl.schema, table: tbl.table });
          }
          setConnLoads((prev) => ({
            ...prev,
            [connectionString]: { status: "loaded", tables: deduped },
          }));
        })
        .catch((err: unknown) => {
          // Allow a retry: drop the fetched marker so collapsing and
          // re-expanding the connection re-runs introspection rather than
          // sticking on the error. Reuse the Add Data errorMessage helper for a
          // translated fallback, matching the dialog's PostGIS entry point.
          connFetchedRef.current.delete(connectionString);
          setConnLoads((prev) => ({
            ...prev,
            [connectionString]: {
              status: "error",
              message: errorMessage(err, t("addData.postgres.errorConnect")),
            },
          }));
        });
    },
    [t],
  );

  // Inject each connection node's lazily-loaded children (loading/error status
  // rows, or schema→table nodes) before filtering. Search therefore reaches the
  // tables of connections the user has already expanded; an unexpanded
  // connection keeps its empty child list, so its tables aren't searchable
  // until it is first drilled into.
  const loadingLabel = t("browser.loadingTables");
  const augmented = useMemo(
    () => augmentConnections(tree, connLoads, loadingLabel),
    [tree, connLoads, loadingLabel],
  );

  const filtered = useMemo(
    () => filterBrowserTree(augmented, query),
    [augmented, query],
  );

  // While searching, expand every group so matches deep in the tree are
  // visible without the user hunting for them; otherwise use their choices.
  const effectiveExpanded = useMemo(() => {
    if (!query.trim()) return expanded;
    const all = new Set(expanded);
    collectGroupIds(filtered, all);
    return all;
  }, [query, expanded, filtered]);

  const toggle = (id: string) => {
    // Kick off introspection the first time a connection is expanded.
    if (id.startsWith(CONNECTION_ID_PREFIX) && !expanded.has(id)) {
      fetchConnectionTables(id.slice(CONNECTION_ID_PREFIX.length));
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activate = async (node: BrowserNode) => {
    // Ignore a second activation while one is still resolving (a fast
    // double-click, or clicking another entry mid-fetch), so an async add
    // cannot run twice and duplicate the layer.
    if (busyRef.current != null) return;
    setError(null);
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
      // Keep the panel open until the open settles: the handler resolves to an
      // error message (or null) rather than throwing, so surface it inline here
      // instead of closing the panel and hiding it.
      beginBusy(node.id);
      try {
        const openError = await onOpenRecentProject(node.projectPath);
        if (openError) setError(openError);
      } finally {
        endBusy();
      }
    } else if (node.kind === "table" && node.connectionString) {
      // Reuse the proven PostgreSQL Add Data flow (desktop Martin lifecycle) to
      // add the table as a layer, opening it prefilled with this connection and
      // table so the user only confirms.
      openAddData("postgres", {
        postgres: {
          connection: node.connectionString,
          schema: node.tableSchema,
          table: node.tableName,
        },
      });
    }
  };

  // A group's "New connection" (＋) opens the Add Data dialog at that source;
  // saving there adds it to the library/connections, which show up in this tree.
  const newConnection = (kind: AddDataKind) => openAddData(kind);

  // A section counts as content if it has children *or* an always-on ＋ action
  // (the Databases section shows its "New connection" ＋ even with zero saved
  // connections, so a first-run user isn't stuck on the empty-state message).
  const hasContent = filtered.some(
    (section) => section.children?.length || section.newConnectionKind,
  );

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

      {error ? (
        <p className="border-b px-3 py-2 text-xs text-destructive">{error}</p>
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
                onNewConnection={newConnection}
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
