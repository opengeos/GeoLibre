import { useAppStore } from "@geolibre/core";
import type { MapController } from "@geolibre/map";
import { fetchPostgisStatus, listPostgisTables } from "@geolibre/processing";
import { Input, ScrollArea } from "@geolibre/ui";
import { Search } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { startGeoLibreSidecar } from "../../lib/sidecar";
import { isLoadableFilePath, isTauri, listDirectory, pickLocalDirectory } from "../../lib/tauri-io";
import { pinFolder, unpinFolder } from "../../lib/browser-folders";
import { addFavorite, isFavoritableKind, removeFavorite } from "../../lib/browser-favorites";
import { useBrowserTree } from "../../hooks/useBrowserTree";
import {
  augmentConnections,
  augmentFolders,
  filterBrowserTree,
  flattenVisibleTree,
  type BrowserNode,
  type ConnectionLoad,
  type FolderLoad,
} from "../../lib/browser-tree";
import { applyServiceEntry } from "../layout/add-data/apply-service";
import { errorMessage } from "../layout/add-data/helpers";
import type { AddDataKind } from "../layout/AddDataDialog";
import { openAddData } from "../layout/add-data/open-add-data";
import { BrowserTreeNode } from "./BrowserTreeNode";

/** The `connection:` / `folder:` id prefixes (id = prefix + connString/path). */
const CONNECTION_ID_PREFIX = "connection:";
const FOLDER_ID_PREFIX = "folder:";

interface BrowserPanelProps {
  mapControllerRef: RefObject<MapController | null>;
  /**
   * Open a recent project by path (shared with the toolbar's instance).
   * Resolves to an error message to show inline, or null on success.
   */
  onOpenRecentProject: (path: string) => Promise<string | null>;
  /**
   * Add a local file (by absolute path) as a layer — vector/raster/MBTiles,
   * dispatched by the shell which owns the store add-paths. Resolves to an error
   * message to show inline, or null on success. Absent off-desktop (no Files
   * section renders there).
   */
  onAddFilePath?: (path: string) => Promise<string | null>;
}

/** The section nodes are expanded by default so their contents are visible. */
const DEFAULT_EXPANDED = new Set([
  "section:favorites",
  "section:services",
  "section:recent",
  "section:databases",
  "section:files",
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
  onAddFilePath,
}: BrowserPanelProps) {
  const { t } = useTranslation();
  const addLayer = useAppStore((s) => s.addLayer);
  const { tree, serviceById, favoriteIds } = useBrowserTree();

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(DEFAULT_EXPANDED));
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
  const [connLoads, setConnLoads] = useState<Record<string, ConnectionLoad>>({});
  // Tracks in-flight/settled fetches so a re-expand (or the expand-all a search
  // triggers) doesn't refetch. A failed fetch drops its entry so re-expanding
  // the connection retries (there is no separate refresh affordance).
  const connFetchedRef = useRef<Set<string>>(new Set());

  const fetchConnectionTables = useCallback(
    (connectionString: string) => {
      if (connFetchedRef.current.has(connectionString)) return;
      connFetchedRef.current.add(connectionString);
      // PostGIS browsing needs the desktop sidecar/Martin; off-Tauri, show the
      // same localized "requires GeoLibre Desktop" message the Add Data dialog
      // gives rather than letting startGeoLibreSidecar/fetch fail with a raw
      // network error. Dropped from the fetched set so it can retry on desktop.
      if (!isTauri()) {
        connFetchedRef.current.delete(connectionString);
        setConnLoads((prev) => ({
          ...prev,
          [connectionString]: {
            status: "error",
            message: t("addData.postgres.errorDesktopOnly"),
          },
        }));
        return;
      }
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

  // Lazy directory listing for the Files section: keyed by absolute path,
  // populated the first time a folder is expanded (same pattern as connections).
  const [folderLoads, setFolderLoads] = useState<Record<string, FolderLoad>>({});
  const folderFetchedRef = useRef<Set<string>>(new Set());
  // Per-path fetch generation: bumped when a folder is (re)fetched or unpinned,
  // so a slow listDirectory that resolves after the folder was unpinned/re-pinned
  // can't clobber newer state with its stale result.
  const folderGenRef = useRef<Map<string, number>>(new Map());

  const fetchFolder = useCallback(
    (path: string) => {
      if (folderFetchedRef.current.has(path)) return;
      folderFetchedRef.current.add(path);
      const generation = (folderGenRef.current.get(path) ?? 0) + 1;
      folderGenRef.current.set(path, generation);
      const isCurrent = () => folderGenRef.current.get(path) === generation;
      setFolderLoads((prev) => ({ ...prev, [path]: { status: "loading" } }));
      listDirectory(path)
        .then((entries) => {
          if (!isCurrent()) return; // superseded by an unpin/re-pin mid-fetch
          setFolderLoads((prev) => ({
            ...prev,
            [path]: { status: "loaded", entries },
          }));
        })
        .catch((err: unknown) => {
          if (!isCurrent()) return;
          // Drop the marker so a re-expand retries (a folder can also change on
          // disk); surface the message inline via the status row, using the
          // translated fallback helper like fetchConnectionTables does.
          folderFetchedRef.current.delete(path);
          setFolderLoads((prev) => ({
            ...prev,
            [path]: {
              status: "error",
              message: errorMessage(err, t("browser.loadFolderFailed")),
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
  // until it is first drilled into. Folder listings are injected the same way.
  const loadingLabel = t("browser.loadingTables");
  const foldersLoadingLabel = t("browser.loadingFolder");
  const augmented = useMemo(
    () =>
      augmentFolders(
        augmentConnections(tree, connLoads, loadingLabel),
        folderLoads,
        foldersLoadingLabel,
        isLoadableFilePath,
        (shown, total) => t("browser.folderTruncated", { shown, total }),
      ),
    [tree, connLoads, loadingLabel, folderLoads, foldersLoadingLabel, t],
  );

  const filtered = useMemo(() => filterBrowserTree(augmented, query), [augmented, query]);

  // While searching, expand every group so matches deep in the tree are
  // visible without the user hunting for them; otherwise use their choices.
  const effectiveExpanded = useMemo(() => {
    if (!query.trim()) return expanded;
    const all = new Set(expanded);
    collectGroupIds(filtered, all);
    return all;
  }, [query, expanded, filtered]);

  const toggle = (id: string) => {
    // Kick off introspection/listing the first time a connection or folder is
    // expanded.
    if (id.startsWith(CONNECTION_ID_PREFIX) && !expanded.has(id)) {
      fetchConnectionTables(id.slice(CONNECTION_ID_PREFIX.length));
    } else if (id.startsWith(FOLDER_ID_PREFIX) && !expanded.has(id)) {
      fetchFolder(id.slice(FOLDER_ID_PREFIX.length));
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Keyboard navigation (WAI-ARIA tree pattern). The visible rows, flattened
  // top-to-bottom, are what Arrow Up/Down step through; Right/Left expand/
  // collapse or move to child/parent. Roving tabindex: only `activeRowId` is
  // tab-reachable, so the whole tree is one Tab stop and arrows move within it.
  const treeRef = useRef<HTMLUListElement>(null);
  const visibleRows = useMemo(
    // "info" rows (loading/error status) are non-interactive text, not tree
    // items, so they're excluded from keyboard navigation.
    () => flattenVisibleTree(filtered, effectiveExpanded).filter((row) => row.kind !== "info"),
    [filtered, effectiveExpanded],
  );
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  // Fall back to the first row when nothing is active yet, or the active row
  // scrolled out of existence (filtered away / its parent collapsed).
  const currentRowId =
    activeRowId && visibleRows.some((row) => row.id === activeRowId)
      ? activeRowId
      : (visibleRows[0]?.id ?? null);

  const focusRow = (id: string) => {
    setActiveRowId(id);
    // The button already exists (only its tabIndex flips), so focus it now
    // rather than waiting for the roving-tabindex re-render. Escape only `"`/`\`
    // for the quoted attribute value — CSS.escape is for identifiers and would
    // wrongly escape the `:`/`/` that ids like `section:services` contain.
    const escaped = id.replace(/["\\]/g, "\\$&");
    const selector = `[data-browser-row="${escaped}"]`;
    treeRef.current?.querySelector<HTMLElement>(selector)?.focus();
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    // Only navigate when a treeitem row is focused. A row's secondary buttons
    // (star/×/＋) are Tab-reachable; an Arrow key fired from one of those must
    // not hijack nav and yank focus to another row.
    if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-browser-row")) {
      return;
    }
    if (!currentRowId) return;
    const index = visibleRows.findIndex((row) => row.id === currentRowId);
    if (index === -1) return;
    const row = visibleRows[index];
    let targetId: string | null | undefined;
    // Horizontal arrows follow the reading direction (WAI-ARIA tree pattern):
    // in a right-to-left layout ArrowLeft expands and ArrowRight collapses.
    const isRtl = document.documentElement.dir === "rtl";
    const key =
      isRtl && event.key === "ArrowRight"
        ? "ArrowLeft"
        : isRtl && event.key === "ArrowLeft"
          ? "ArrowRight"
          : event.key;
    switch (key) {
      case "ArrowDown":
        targetId = visibleRows[index + 1]?.id;
        break;
      case "ArrowUp":
        targetId = visibleRows[index - 1]?.id;
        break;
      case "Home":
        targetId = visibleRows[0]?.id;
        break;
      case "End":
        targetId = visibleRows[visibleRows.length - 1]?.id;
        break;
      case "ArrowRight":
        if (row.isGroup && !row.isExpanded) {
          event.preventDefault();
          toggle(row.id); // expand in place
          return;
        }
        // Move to the group's first navigable child. Found by parentId rather
        // than positional adjacency, since the group's only children may be
        // non-navigable info rows (a connection/folder still loading or errored)
        // or it may be an empty group — in which case Right Arrow is a no-op.
        if (row.isGroup && row.isExpanded) {
          targetId = visibleRows.find((candidate) => candidate.parentId === row.id)?.id;
        }
        break;
      case "ArrowLeft":
        // Collapse only a genuinely-expanded group. During a search,
        // effectiveExpanded force-expands matching groups that aren't in the
        // raw `expanded` set, and toggling those would just re-add them (no
        // visible collapse) — so for a search-only-expanded group, fall through
        // to moving to the parent instead of silently doing nothing.
        if (row.isGroup && row.isExpanded && expanded.has(row.id)) {
          event.preventDefault();
          toggle(row.id); // collapse in place
          return;
        }
        targetId = row.parentId; // move to parent
        break;
      default:
        return; // let Enter/Space reach the focused button's onClick natively
    }
    if (targetId) {
      event.preventDefault();
      focusRow(targetId);
    }
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
        // the tree being built and this click.
        if (favoriteIds.has(node.id)) {
          // A favorite can outlive its saved service (removed anywhere, with no
          // change event to prune it). Self-heal: drop the dead favorite so it
          // stops erroring on every click, and say why.
          removeFavorite(node.id);
          setError(t("browser.favoriteMissing"));
        } else {
          setError(t("browser.addFailed"));
        }
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
    } else if (node.kind === "file" && node.path && onAddFilePath) {
      // Add the clicked file as a layer via the shell's dispatcher (which owns
      // the vector/raster/MBTiles store add-paths); it resolves to an error
      // message or null, surfaced inline like the recent-project open.
      beginBusy(node.id);
      try {
        const addError = await onAddFilePath(node.path);
        if (addError) setError(addError);
      } finally {
        endBusy();
      }
    }
  };

  // A group's "New connection" (＋) opens the Add Data dialog at that source;
  // saving there adds it to the library/connections, which show up in this tree.
  const newConnection = (kind: AddDataKind) => openAddData(kind);

  // The Files section's ＋ picks a folder to pin (native directory dialog); the
  // pinned-folders change event refreshes the tree via useBrowserTree.
  const addFolder = async () => {
    setError(null);
    try {
      const picked = await pickLocalDirectory();
      if (picked) pinFolder(picked);
    } catch (err) {
      console.error("Failed to add folder", err);
      setError(t("browser.addFolderFailed"));
    }
  };

  // A pinned root folder's (×) unpins it from the Files section. Also reset the
  // folder and any expanded descendants — clear their cached listings + fetch
  // markers and collapse them — so re-pinning the same path re-reads from disk
  // and expands cleanly (toggle only fetches on a collapsed→expanded change;
  // the panel stays mounted while hidden, so this state would otherwise persist).
  //
  // Note: this removes the pin from the UI/localStorage but does NOT revoke the
  // underlying fs scope the picker granted (persisted app-wide via
  // tauri-plugin-persisted-scope, see src-tauri/src/lib.rs) — there is no clean
  // per-path "forget". Unpin means "stop listing it here", not "revoke access".
  const removeFolder = (path: string) => {
    setError(null);
    // `path` may itself end in a separator (a normalized root: "/" or "C:\"),
    // so build the descendant prefix from the path's own trailing separator
    // rather than blindly appending one (which would yield "//" / "C:\\" and
    // match no real descendant).
    const separator = path.includes("\\") ? "\\" : "/";
    const prefix = path.endsWith(separator) ? path : `${path}${separator}`;
    const isWithin = (candidate: string) => candidate === path || candidate.startsWith(prefix);
    for (const key of [...folderFetchedRef.current]) {
      if (isWithin(key)) folderFetchedRef.current.delete(key);
    }
    // Invalidate any in-flight fetch for the folder/descendants so a late
    // resolution can't repopulate cleared state.
    for (const key of [...folderGenRef.current.keys()]) {
      if (isWithin(key)) {
        folderGenRef.current.set(key, (folderGenRef.current.get(key) ?? 0) + 1);
      }
    }
    setFolderLoads((prev) => {
      const next: Record<string, FolderLoad> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!isWithin(key)) next[key] = value;
      }
      return next;
    });
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of prev) {
        if (id.startsWith(FOLDER_ID_PREFIX) && isWithin(id.slice(FOLDER_ID_PREFIX.length))) {
          next.delete(id);
        }
      }
      return next;
    });
    unpinFolder(path);
  };

  // Toggle a node's presence in the Favorites section; the favorites change
  // event refreshes the tree via useBrowserTree. The descriptor carries enough
  // to rebuild + activate the favorited node without the live original.
  //
  // The label/payload are snapshotted at favorite time and not refreshed while
  // the original still exists — intentional, matching the "rebuild without the
  // live original" design. There's no rename for services/connections today, so
  // this is currently unreachable; a future rename feature should re-sync (or
  // accept) the stored label.
  const toggleFavorite = (node: BrowserNode) => {
    if (favoriteIds.has(node.id)) {
      removeFavorite(node.id);
      return;
    }
    const kind = node.kind;
    if (!isFavoritableKind(kind)) return;
    addFavorite({
      id: node.id,
      kind,
      label: node.label,
      serviceId: node.serviceId,
      serviceKind: node.serviceKind,
      builtin: node.builtin,
      path: node.path,
    });
  };

  // A section counts as content if it has children *or* an always-on ＋ action
  // (Databases' "New connection" and Files' "Add folder" show even with zero
  // entries, so a first-run user isn't stuck on the empty-state message).
  const hasContent = filtered.some(
    (section) => section.children?.length || section.newConnectionKind || section.addFolderAction,
  );

  return (
    // Body only: the shell (PluginRightPanel / SharedSidebar) renders the header,
    // move/merge/collapse/close controls, and the dock rail around this.
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b px-2 py-2">
        <Search className="pointer-events-none absolute start-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 ps-7 text-sm"
          placeholder={t("browser.searchPlaceholder")}
          value={query}
          aria-label={t("browser.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {error ? <p className="border-b px-3 py-2 text-xs text-destructive">{error}</p> : null}

      <ScrollArea className="min-h-0 flex-1">
        {hasContent ? (
          <ul
            ref={treeRef}
            className="py-1"
            role="tree"
            aria-label={t("browser.title")}
            aria-busy={busyId != null}
            onKeyDown={onTreeKeyDown}
          >
            {filtered.map((section) => (
              <BrowserTreeNode
                key={section.id}
                node={section}
                depth={0}
                expanded={effectiveExpanded}
                busyId={busyId}
                activeRowId={currentRowId}
                onRowFocus={setActiveRowId}
                onToggle={toggle}
                onActivate={activate}
                onNewConnection={newConnection}
                onAddFolder={addFolder}
                onRemoveFolder={removeFolder}
                favoriteIds={favoriteIds}
                onToggleFavorite={toggleFavorite}
              />
            ))}
          </ul>
        ) : (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {query.trim() ? t("browser.noMatches") : t("browser.empty")}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}
