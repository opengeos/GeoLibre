/**
 * Pure tree model for the Browser (Data Source Manager) panel — a QGIS-style
 * navigable tree that unifies the app's existing data entry points into one
 * surface. This module builds the node tree from already-loaded inputs (the
 * saved-service library and the recent-projects list); it has no React, I/O, or
 * store dependencies, so it unit-tests in isolation. The `useBrowserTree` hook
 * feeds it live data and the `BrowserPanel` renders the result.
 *
 * It covers three top-level sections — **Services** (grouped by service kind,
 * mirroring the Add Data web-service sources: XYZ, WMS, WFS, WMTS, ArcGIS),
 * **Recent** (recently opened projects), and **Databases** (saved PostGIS
 * connections that expand to their schemas and spatial tables). Local-file
 * sections come in a later phase.
 */

import {
  type ServiceLibraryEntry,
  type ServiceLibraryKind,
} from "../components/layout/add-data/service-library";
import type { AddDataKind } from "../components/layout/add-data/types";
import type { FavoriteKind } from "./browser-favorites";
import type { RecentProjectEntry } from "@geolibre/core";

/** The kind of node, which determines its icon and click behavior. */
export type BrowserNodeKind =
  | "section" // a static top-level group (Services, Recent, Databases)
  | "category" // a service-kind grouping (XYZ, WMS, WFS, WMTS, ArcGIS)
  | "service" // a saved-service leaf that adds a layer when activated
  | "recent-project" // a recent project that opens when activated
  | "connection" // a saved database connection; expands to its schemas/tables
  | "schema" // a database schema grouping under a connection
  | "table" // a database table leaf that opens the add flow for it
  | "folder" // a filesystem directory; expands to its subfolders/loadable files
  | "file" // a loadable file on disk that adds a layer when activated
  | "info"; // a non-interactive status row (loading / error)

/** One node in the Browser tree. */
export interface BrowserNode {
  /** Stable, unique id (e.g. `service:<entryId>`, `kind:wms`). */
  id: string;
  kind: BrowserNodeKind;
  /** User-facing label. */
  label: string;
  /** Child nodes for `section`/`category` groups; absent for leaves. */
  children?: BrowserNode[];
  /** Whether activating the node adds/opens something (leaves only). */
  addable: boolean;
  /** The saved-service id this node applies (kind `service`). */
  serviceId?: string;
  /** The saved-service kind, for the icon and the applier (kind `service`). */
  serviceKind?: ServiceLibraryKind;
  /**
   * The Add Data source this node's "New connection" (＋) action opens — set on
   * service-kind category groups (their kind) and the Databases section
   * ("postgres"). Absent means the node shows no ＋.
   */
  newConnectionKind?: AddDataKind;
  /** True on the Files section, whose ＋ opens a folder picker (kind `section`). */
  addFolderAction?: boolean;
  /** The saved database connection string a `connection`/`table` node belongs to. */
  connectionString?: string;
  /** The schema of a `table` node. */
  tableSchema?: string;
  /** The table name of a `table` node. */
  tableName?: string;
  /** Absolute filesystem path of a `folder`/`file` node. */
  path?: string;
  /** True for a pinned root folder the user can unpin (kind `folder`). */
  removable?: boolean;
  /** True for a built-in preset service (read-only), for badge display. */
  builtin?: boolean;
  /** The project path a recent node opens (kind `recent-project`). */
  projectPath?: string;
  /** Leaf count under a `section`/`category`, for a count badge. */
  count?: number;
}

/** Inputs the Browser tree is assembled from. */
export interface BrowserTreeInput {
  /** Every service to list — built-in presets and the user's saved entries. */
  services: readonly ServiceLibraryEntry[];
  /** The recent-projects list from the store, most-recent first. */
  recentProjects: readonly RecentProjectEntry[];
  /**
   * Saved database (PostGIS) connections to list under the Databases section.
   * Omitted (undefined) hides the section entirely; an empty array still renders
   * it (with its "New connection" action). The app always passes it — the
   * PostgreSQL add flow itself reports when it needs GeoLibre Desktop.
   */
  databaseConnections?: readonly { connectionString: string; label: string }[];
  /**
   * The user's pinned folders to list under the Files section. Omitted
   * (undefined) hides the section — the app passes it only on desktop
   * (`isTauri()`), where directory reading is available. An empty `folders`
   * array still renders the section with its "Add folder" (＋) action.
   */
  files?: {
    folders: readonly { path: string; label: string }[];
  };
  /**
   * The user's favorited nodes (services / connections / folders / files) to
   * list in a quick-access Favorites section at the top. Omitted or empty hides
   * the section. {@link FavoriteNodeInput} matches `BrowserFavorite`.
   */
  favorites?: readonly FavoriteNodeInput[];
  /**
   * Translated labels for the top-level sections. Optional so the pure module
   * (and its tests) default to English; the app passes `t()` values.
   */
  sectionLabels?: {
    services: string;
    recent: string;
    databases: string;
    files?: string;
    favorites?: string;
  };
}

/** Locale-aware, case-insensitive compare for stable label sorting. */
function byLabel(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** Group headers for each service kind, matching the Add Data source names. */
const KIND_LABEL: Record<ServiceLibraryKind, string> = {
  xyz: "XYZ",
  wms: "WMS",
  wfs: "WFS",
  wmts: "WMTS",
  arcgis: "ArcGIS",
};

/** Kind grouping order under Services, mirroring the Add Data source order. */
const KIND_ORDER: readonly ServiceLibraryKind[] = ["xyz", "wms", "wfs", "wmts", "arcgis"];

/**
 * Groups services by kind (XYZ / WMS / WFS / WMTS / ArcGIS) so the tree mirrors
 * the Add Data web-service sources, ordering the groups by {@link KIND_ORDER}
 * and the services within each by name. Built-in presets and user entries are
 * interleaved so each kind reads as one catalog.
 */
function buildServiceKinds(services: readonly ServiceLibraryEntry[]): BrowserNode[] {
  const byKind = new Map<ServiceLibraryKind, ServiceLibraryEntry[]>();
  for (const entry of services) {
    const bucket = byKind.get(entry.kind);
    if (bucket) bucket.push(entry);
    else byKind.set(entry.kind, [entry]);
  }
  return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => {
    const entries = [...(byKind.get(kind) ?? [])].sort((a, b) => byLabel(a.name, b.name));
    return {
      id: `kind:${kind}`,
      kind: "category" as const,
      label: KIND_LABEL[kind],
      addable: false,
      // The panel's "New connection" (＋) action opens this Add Data source.
      newConnectionKind: kind,
      count: entries.length,
      children: entries.map(
        (entry): BrowserNode => ({
          id: `service:${entry.id}`,
          kind: "service",
          label: entry.name,
          addable: true,
          serviceId: entry.id,
          serviceKind: entry.kind,
          builtin: entry.builtin,
        }),
      ),
    };
  });
}

/**
 * Builds the full Browser tree. Sections with no children are still returned so
 * the panel can render an empty-state hint under them.
 *
 * @param input - The services, recent projects, and database connections.
 * @returns The top-level section nodes (Services, Recent, and Databases when
 *   `databaseConnections` is provided).
 */
export function buildBrowserTree(input: BrowserTreeInput): BrowserNode[] {
  const labels = input.sectionLabels ?? {
    services: "Services",
    recent: "Recent",
    databases: "Databases",
    files: "Files",
    favorites: "Favorites",
  };
  const kinds = buildServiceKinds(input.services);
  const servicesSection: BrowserNode = {
    id: "section:services",
    kind: "section",
    label: labels.services,
    addable: false,
    count: input.services.length,
    children: kinds,
  };

  const recentChildren = input.recentProjects.map(
    (entry): BrowserNode => ({
      id: `recent:${entry.path}`,
      kind: "recent-project",
      label: entry.name,
      addable: true,
      projectPath: entry.path,
    }),
  );
  const recentSection: BrowserNode = {
    id: "section:recent",
    kind: "section",
    label: labels.recent,
    addable: false,
    count: recentChildren.length,
    children: recentChildren,
  };

  const sections: BrowserNode[] = [];

  // Favorites lead the tree when the user has pinned anything, for quick access.
  if (input.favorites && input.favorites.length > 0) {
    sections.push({
      id: "section:favorites",
      kind: "section",
      label: labels.favorites ?? "Favorites",
      addable: false,
      count: input.favorites.length,
      children: buildFavoriteNodes(input.favorites),
    });
  }

  sections.push(servicesSection, recentSection);

  // The Databases section is included whenever `databaseConnections` is
  // provided (the app always provides it). It always shows its "New connection"
  // (＋) action, even with no connections yet.
  if (input.databaseConnections) {
    sections.push({
      id: "section:databases",
      kind: "section",
      label: labels.databases,
      addable: false,
      newConnectionKind: "postgres",
      count: input.databaseConnections.length,
      children: input.databaseConnections.map(
        (connection): BrowserNode => ({
          id: `connection:${connection.connectionString}`,
          kind: "connection",
          label: connection.label,
          addable: false,
          connectionString: connection.connectionString,
          // An empty child list marks it as an expandable group; the panel
          // lazily fills it with schema/table nodes on first expand.
          children: [],
        }),
      ),
    });
  }

  // The Files section is included only on desktop (the app passes `files` when
  // `isTauri()`). It always shows its "Add folder" (＋) action and lists the
  // user's pinned folders, each lazily expanded to its subfolders/files.
  if (input.files) {
    sections.push({
      id: "section:files",
      kind: "section",
      label: labels.files ?? "Files",
      addable: false,
      addFolderAction: true,
      count: input.files.folders.length,
      children: input.files.folders.map(
        (folder): BrowserNode => ({
          id: `folder:${folder.path}`,
          kind: "folder",
          label: folder.label,
          addable: false,
          path: folder.path,
          // Pinned roots can be unpinned; subfolders (added on expand) cannot.
          removable: true,
          // Expandable group, lazily filled with subfolders/files on expand.
          children: [],
        }),
      ),
    });
  }

  return sections;
}

/**
 * One entry of a directory listing. Structurally matches `LocalDirectoryEntry`
 * in tauri-io.ts (which `listDirectory` returns); duplicated here so this pure
 * model stays decoupled from tauri-io and unit-tests without the filesystem.
 */
export interface DirectoryEntry {
  name: string;
  /** Absolute path of the entry. */
  path: string;
  isDirectory: boolean;
}

/**
 * Turns a directory listing into `folder` → (lazily expandable) and `file`
 * (addable) nodes: subdirectories first, then loadable files, each group sorted
 * by name; hidden dotfiles are skipped. Pure so it unit-tests without the
 * filesystem — the caller supplies the "is this file loadable" predicate (the
 * app passes the tauri-io format check).
 *
 * @param entries - The directory's entries.
 * @param isLoadable - Whether a file name is a loadable geospatial format.
 * @returns Folder nodes (expandable) followed by loadable-file nodes.
 */
export function buildDirectoryNodes(
  entries: readonly DirectoryEntry[],
  isLoadable: (name: string) => boolean,
): BrowserNode[] {
  const visible = entries.filter((entry) => !entry.name.startsWith("."));
  const folders = visible
    .filter((entry) => entry.isDirectory)
    .sort((a, b) => byLabel(a.name, b.name))
    .map(
      (entry): BrowserNode => ({
        id: `folder:${entry.path}`,
        kind: "folder",
        label: entry.name,
        addable: false,
        path: entry.path,
        children: [],
      }),
    );
  const files = visible
    .filter((entry) => !entry.isDirectory && isLoadable(entry.name))
    .sort((a, b) => byLabel(a.name, b.name))
    .map(
      (entry): BrowserNode => ({
        id: `file:${entry.path}`,
        kind: "file",
        label: entry.name,
        addable: true,
        path: entry.path,
      }),
    );
  return [...folders, ...files];
}

/** A favorited node descriptor (structural subset of `BrowserFavorite`). */
export interface FavoriteNodeInput {
  id: string;
  kind: FavoriteKind;
  label: string;
  serviceId?: string;
  serviceKind?: ServiceLibraryKind;
  builtin?: boolean;
  path?: string;
}

/**
 * Rebuilds each favorite descriptor into the tree node it represents, so the
 * Favorites section renders and activates its entries the same way as the
 * originals — reusing the same node ids, so the panel's expand/introspect state
 * (keyed by id / connection string / path) is shared with the original node.
 * Pure so it unit-tests without the store or filesystem.
 *
 * @param favorites - The user's favorited node descriptors.
 * @returns One node per favorite (service/connection/folder/file).
 */
export function buildFavoriteNodes(favorites: readonly FavoriteNodeInput[]): BrowserNode[] {
  return favorites.map((fav): BrowserNode => {
    switch (fav.kind) {
      case "service":
        return {
          id: fav.id,
          kind: "service",
          label: fav.label,
          addable: true,
          serviceId: fav.serviceId,
          serviceKind: fav.serviceKind,
          // Keep the "built-in" badge on a favorited preset service.
          builtin: fav.builtin,
        };
      case "folder":
        return {
          id: fav.id,
          kind: "folder",
          label: fav.label,
          addable: false,
          path: fav.path,
          children: [],
        };
      case "file":
        return {
          id: fav.id,
          kind: "file",
          label: fav.label,
          addable: true,
          path: fav.path,
        };
    }
  });
}

/** A spatial table discovered under a database connection. */
export interface PostgisTableRef {
  schema: string;
  table: string;
}

/**
 * Groups a connection's spatial tables into `schema` → `table` nodes, sorted by
 * name, for the panel to inject as a lazily-expanded connection's children.
 * Pure so it unit-tests without the sidecar that produces the table list.
 *
 * @param connectionString - The owning connection (embedded in node ids + carried
 *   on table nodes for the add flow).
 * @param tables - The spatial tables discovered for that connection.
 * @returns One `schema` group per distinct schema, each with its `table` leaves.
 */
export function buildPostgisTableNodes(
  connectionString: string,
  tables: readonly PostgisTableRef[],
): BrowserNode[] {
  const bySchema = new Map<string, PostgisTableRef[]>();
  for (const entry of tables) {
    const bucket = bySchema.get(entry.schema);
    if (bucket) bucket.push(entry);
    else bySchema.set(entry.schema, [entry]);
  }
  return Array.from(bySchema.keys())
    .sort(byLabel)
    .map((schema) => ({
      id: `schema:${connectionString}:${schema}`,
      kind: "schema" as const,
      label: schema,
      addable: false,
      count: bySchema.get(schema)?.length ?? 0,
      children: [...(bySchema.get(schema) ?? [])]
        .sort((a, b) => byLabel(a.table, b.table))
        .map(
          (entry): BrowserNode => ({
            id: `table:${connectionString}:${schema}.${entry.table}`,
            kind: "table",
            label: entry.table,
            addable: true,
            connectionString,
            tableSchema: schema,
            tableName: entry.table,
          }),
        ),
    }));
}

/** Async load state for one connection's spatial-table introspection. */
export type ConnectionLoad =
  | { status: "loading" }
  | { status: "loaded"; tables: readonly PostgisTableRef[] }
  | { status: "error"; message: string };

/**
 * Returns a copy of the tree with each `connection` node's children replaced by
 * the current lazy-load state: a status row while loading or on error, or the
 * schema→table nodes once loaded. Connections with no load entry keep their
 * empty child list (still expandable; expanding triggers the fetch) — so search
 * only reaches the tables of connections that have already been introspected.
 * Pure so the panel's tree augmentation unit-tests without React/the sidecar.
 *
 * @param nodes - The base tree from {@link buildBrowserTree}.
 * @param loads - Per-connection introspection state keyed by connection string.
 * @param loadingLabel - Translated label for the "loading tables" status row.
 * @returns A new tree; connection nodes get their status/table children.
 */
export function augmentConnections(
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
          {
            id: `${node.id}:loading`,
            kind: "info",
            label: loadingLabel,
            addable: false,
          },
        ];
      } else if (load?.status === "error") {
        children = [
          {
            id: `${node.id}:error`,
            kind: "info",
            label: load.message,
            addable: false,
          },
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

/** Async load state for one folder's directory listing. */
export type FolderLoad =
  | { status: "loading" }
  | { status: "loaded"; entries: readonly DirectoryEntry[] }
  | { status: "error"; message: string };

/**
 * Cap on the number of direct children *rendered* per folder. A pathological
 * folder (a drive root, `Downloads`, a build dir) could otherwise mount
 * thousands of unvirtualized rows and stall the panel; beyond the cap the folder
 * shows a "showing first N" status row instead. Note this bounds only the render
 * cost — `readDir` still reads (and IPC-returns) the whole directory, and
 * `buildDirectoryNodes` still sorts it — so this prevents the DOM stall, not the
 * underlying read cost. Full virtualization (and an earlier read-side cap) is a
 * follow-up.
 */
export const MAX_DIRECTORY_ENTRIES = 500;

/**
 * Returns a copy of the tree with each `folder` node's children replaced by its
 * lazy-load state: a status row while loading or on error, or the subfolder/file
 * nodes once loaded. Unlike {@link augmentConnections}, folders nest, so a loaded
 * folder's built children are themselves augmented — an expanded subfolder deep
 * in the tree gets its own listing. Pure (the filesystem read happens elsewhere).
 *
 * @param nodes - The tree (typically already run through augmentConnections).
 * @param loads - Per-folder listing state keyed by absolute path.
 * @param loadingLabel - Translated label for the "loading" status row.
 * @param isLoadable - Whether a file name is a loadable geospatial format.
 * @param truncatedLabel - Optional label for the "showing first N of M" row a
 *   folder gets when its direct children exceed {@link MAX_DIRECTORY_ENTRIES}.
 * @returns A new tree; folder nodes get their status/subfolder/file children.
 */
export function augmentFolders(
  nodes: readonly BrowserNode[],
  loads: Record<string, FolderLoad>,
  loadingLabel: string,
  isLoadable: (name: string) => boolean,
  truncatedLabel?: (shown: number, total: number) => string,
): BrowserNode[] {
  const recurse = (list: readonly BrowserNode[]): BrowserNode[] =>
    list.map((node) => {
      if (node.kind === "folder" && node.path) {
        const load = loads[node.path];
        let children: BrowserNode[] = [];
        if (load?.status === "loading") {
          children = [
            {
              id: `${node.id}:loading`,
              kind: "info",
              label: loadingLabel,
              addable: false,
            },
          ];
        } else if (load?.status === "error") {
          children = [
            {
              id: `${node.id}:error`,
              kind: "info",
              label: load.message,
              addable: false,
            },
          ];
        } else if (load?.status === "loaded") {
          const direct = buildDirectoryNodes(load.entries, isLoadable);
          if (direct.length > MAX_DIRECTORY_ENTRIES) {
            // Cap the direct children, then append a truncation status row so a
            // huge folder can't stall the panel. Recurse before capping's info
            // row so an expanded subfolder within the kept slice still loads.
            children = recurse(direct.slice(0, MAX_DIRECTORY_ENTRIES));
            children.push({
              id: `${node.id}:truncated`,
              kind: "info",
              label: truncatedLabel
                ? truncatedLabel(MAX_DIRECTORY_ENTRIES, direct.length)
                : `Showing first ${MAX_DIRECTORY_ENTRIES} of ${direct.length}`,
              addable: false,
            });
          } else {
            // Recurse so an already-expanded subfolder also gets its listing.
            children = recurse(direct);
          }
        }
        return { ...node, children };
      }
      if (node.children) {
        return { ...node, children: recurse(node.children) };
      }
      return node;
    });
  return recurse(nodes);
}

/** One visible row of the tree, flattened in render (top-to-bottom) order. */
export interface VisibleRow {
  id: string;
  kind: BrowserNodeKind;
  /** Nesting depth (0 for top-level sections). */
  depth: number;
  /** True when the node is a group (has a `children` array). */
  isGroup: boolean;
  /** True when the group is currently expanded. */
  isExpanded: boolean;
  /** The parent group's id, or null for a top-level row. */
  parentId: string | null;
}

/**
 * Flattens the tree into the rows currently visible on screen, in top-to-bottom
 * order — i.e. descending into a group only when it is expanded. This is the
 * model the panel's keyboard navigation moves through (Arrow Up/Down step
 * between adjacent visible rows; Left/Right and parent/child use `parentId` /
 * `isGroup` / `isExpanded`). Pure so it unit-tests without the DOM.
 *
 * @param nodes - The (already filtered) tree to flatten.
 * @param expanded - Ids of the currently expanded groups.
 * @returns The visible rows, in order.
 */
export function flattenVisibleTree(
  nodes: readonly BrowserNode[],
  expanded: ReadonlySet<string>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (list: readonly BrowserNode[], depth: number, parentId: string | null): void => {
    for (const node of list) {
      const isGroup = Boolean(node.children);
      const isExpanded = isGroup && expanded.has(node.id);
      rows.push({ id: node.id, kind: node.kind, depth, isGroup, isExpanded, parentId });
      if (isGroup && isExpanded && node.children) {
        walk(node.children, depth + 1, node.id);
      }
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/**
 * Filters the tree to nodes whose label (or a descendant's label) matches the
 * query, case-insensitively. Returns the tree unchanged for an empty query.
 * Section/category nodes are kept when any descendant matches, so the matching
 * leaves stay reachable; matched groups keep only their matching children.
 *
 * @param nodes - The tree to filter.
 * @param query - The search text; whitespace-only is treated as empty.
 * @returns A new, pruned tree (never mutates the input).
 */
export function filterBrowserTree(nodes: readonly BrowserNode[], query: string): BrowserNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes.map((node) => ({ ...node }));

  const prune = (node: BrowserNode): BrowserNode | null => {
    const selfMatches = node.label.toLowerCase().includes(needle);
    if (!node.children) return selfMatches ? { ...node } : null;
    // A group whose own label matches keeps all its children; otherwise it
    // keeps only the children that (transitively) match.
    if (selfMatches) return { ...node };
    const children = node.children
      .map(prune)
      .filter((child): child is BrowserNode => child !== null);
    if (children.length === 0) return null;
    // Sum each surviving child's own matching-leaf count (leaves have no count,
    // so fall back to 1) rather than counting immediate children, so an
    // intermediate group (e.g. Services → category → service) reports the total
    // matching leaves beneath it, not the number of surviving subgroups.
    return {
      ...node,
      children,
      count: children.reduce((sum, child) => sum + (child.count ?? 1), 0),
    };
  };

  return nodes.map(prune).filter((node): node is BrowserNode => node !== null);
}
