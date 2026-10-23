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
 * **Recent** (recently opened projects), and **Databases** (PostgreSQL and SQL
 * Server connections, each grouped by engine and expandable to spatial tables).
 * Local-file sections come in a later phase.
 */

import {
  serviceFieldString,
  type ServiceLibraryEntry,
  type ServiceLibraryKind,
} from "../components/layout/add-data/service-library";
import type { AddDataKind } from "../components/layout/add-data/types";
import type { FavoriteKind } from "./browser-favorites";
import type { RecentProjectEntry } from "@geolibre/core";

import type { DatabaseTableIdentity } from "./database-tables";
/** The kind of node, which determines its icon and click behavior. */
export type BrowserNodeKind =
  | "section" // a static top-level group (Services, Recent, Databases)
  | "category" // a service-kind grouping or database-engine group
  | "service" // a saved-service leaf that adds a layer when activated
  | "recent-project" // a recent project that opens when activated
  | "connection" // a saved database connection; expands to its schemas/tables
  | "schema" // a database schema grouping under a connection
  | "table" // a database table leaf that opens the add flow for it
  | "folder" // a filesystem directory; expands to its subfolders/loadable files
  | "file" // a loadable file on disk that adds a layer when activated
  | "library-layer" // a saved Layer Library entry, re-added when activated
  | "arcgis-sublayer" // one sublayer of a saved ArcGIS MapServer, added on its own
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
   * service-kind categories and database-engine groups. Absent means the node
   * shows no ＋.
   */
  newConnectionKind?: AddDataKind;
  /** True on the Files section, whose ＋ opens a folder picker (kind `section`). */
  addFolderAction?: boolean;
  /** The saved database connection string a `connection`/`table` node belongs to. */
  connectionString?: string;
  /** Saved SQL Server profile id of a `connection`/`table` node. */
  mssqlConnectionId?: string;
  /** The schema of a `table` node. */
  tableSchema?: string;
  /** The table name of a `table` node. */
  tableName?: string;
  /** Absolute filesystem path of a `folder`/`file` node. */
  path?: string;
  /** True for a pinned root folder the user can unpin (kind `folder`). */
  removable?: boolean;
  /** The Layer Library entry this node re-adds (kind `library-layer`). */
  libraryLayerId?: string;
  /** True when the node can be renamed in place (kind `library-layer`). */
  renamable?: boolean;
  /** True when the node can be deleted from its library (kind `library-layer`). */
  deletable?: boolean;
  /**
   * True when re-adding this saved layer needs a host that can read local
   * files, for a "desktop only" badge (kind `library-layer`).
   */
  needsLocalFile?: boolean;
  /**
   * True on the My Data section, whose header carries the library's
   * import/export (JSON bundle) actions (kind `section`).
   */
  libraryImportExport?: boolean;
  /** True for a built-in preset service (read-only), for badge display. */
  builtin?: boolean;
  /** True for a deployment-managed service (read-only), for badge display. */
  deployment?: boolean;
  /** The project path a recent node opens (kind `recent-project`). */
  projectPath?: string;
  /**
   * The MapServer sublayer id an `arcgis-sublayer` node adds. Absent on the
   * service's "All layers" row, which adds the saved service as configured.
   */
  arcgisSublayerId?: number;
  /**
   * The name to give the layer an addable `arcgis-sublayer` row adds, when it
   * differs from the row's label (a group's "All layers" row).
   */
  arcgisLayerName?: string;
  /**
   * The `layers=show:` id list a group's "All layers" row draws: the group's
   * default-visible leaves, because ArcGIS draws every descendant of a group
   * id, including the ones the service hides by default.
   */
  arcgisSublayers?: string;
  /** Leaf count under a `section`/`category`, for a count badge. */
  count?: number;
}

/** Inputs the Browser tree is assembled from. */
export interface BrowserTreeInput {
  /** Every service to list — built-in, deployment, and the user's saved entries. */
  services: readonly ServiceLibraryEntry[];
  /** The recent-projects list from the store, most-recent first. */
  recentProjects: readonly RecentProjectEntry[];
  /**
   * Saved PostgreSQL connections for the PostgreSQL engine group under
   * Databases. Omitted (undefined) hides that group; an empty array keeps it
   * visible with its own "New connection" action.
   */
  databaseConnections?: readonly { connectionString: string; label: string }[];
  /**
   * Saved SQL Server profiles for the SQL Server engine group under Databases.
   * Omitted (undefined) hides that group; an empty array keeps it visible.
   */
  mssqlConnections?: readonly { id: string; label: string }[];
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
   * The user's saved Layer Library entries (issue #1520), listed under a My
   * Data section. Omitted (undefined) hides the section; an empty array still
   * renders it, so the library's Import action is reachable on a first run.
   * {@link LibraryLayerNodeInput} is the structural subset of
   * `LayerLibraryEntry` the tree needs.
   */
  libraryLayers?: readonly LibraryLayerNodeInput[];
  /**
   * Translated labels for the top-level sections. Optional so the pure module
   * (and its tests) default to English; the app passes `t()` values.
   */
  sectionLabels?: {
    services: string;
    recent: string;
    databases: string;
    postgresql?: string;
    files?: string;
    favorites?: string;
    myData?: string;
    sqlServer?: string;
  };
}

/** A saved Layer Library entry (structural subset of `LayerLibraryEntry`). */
export interface LibraryLayerNodeInput {
  id: string;
  name: string;
  /** True when only a filesystem-capable host can re-add it. */
  needsLocalFile?: boolean;
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
  csw: "CSW",
};

/** Kind grouping order under Services, mirroring the Add Data source order. */
const KIND_ORDER: readonly ServiceLibraryKind[] = ["xyz", "wms", "csw", "wfs", "wmts", "arcgis"];

/**
 * Groups services by kind (XYZ / WMS / WFS / WMTS / ArcGIS) so the tree mirrors
 * the Add Data web-service sources, ordering the groups by {@link KIND_ORDER}
 * and the services within each by name. Built-in, deployment, and user entries
 * are interleaved so each kind reads as one catalog.
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
          deployment: entry.deployment,
          // A MapServer expands to its sublayers, filled lazily on first
          // expand (GeoLibre#2780); see augmentArcGISServices.
          ...(isArcGISMapServiceEntry(entry) ? { children: [] } : {}),
        }),
      ),
    };
  });
}

/**
 * Builds the full Browser tree. Sections with no children are still returned so
 * the panel can render an empty-state hint under them.
 *
 * @param input - The services, recent projects, saved layers, and database
 *   connections.
 * @returns The top-level section nodes (Services, Recent, and Databases when
 *   either database engine input is provided).
 */
export function buildBrowserTree(input: BrowserTreeInput): BrowserNode[] {
  const labels = input.sectionLabels ?? {
    services: "Services",
    recent: "Recent",
    databases: "Databases",
    files: "Files",
    favorites: "Favorites",
    myData: "My Data",
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
      children: buildFavoriteNodes(
        input.favorites,
        new Set(input.services.filter(isArcGISMapServiceEntry).map((entry) => entry.id)),
      ),
    });
  }

  // My Data (the Layer Library) sits directly under Favorites: it is the user's
  // own saved content, so it reads before the app's service catalog. Rendered
  // whenever the input is provided, even when empty, so the Import action is
  // reachable before anything has been saved.
  if (input.libraryLayers) {
    sections.push({
      id: "section:my-data",
      kind: "section",
      label: labels.myData ?? "My Data",
      addable: false,
      libraryImportExport: true,
      count: input.libraryLayers.length,
      children: input.libraryLayers.map(
        (entry): BrowserNode => ({
          id: `library-layer:${entry.id}`,
          kind: "library-layer",
          label: entry.name,
          addable: true,
          libraryLayerId: entry.id,
          renamable: true,
          deletable: true,
          ...(entry.needsLocalFile ? { needsLocalFile: true } : {}),
        }),
      ),
    });
  }

  sections.push(servicesSection, recentSection);

  // The Databases section is included when either engine input is provided.
  // Each engine has its own group and its own "New connection" (＋) action.
  if (input.databaseConnections || input.mssqlConnections) {
    const engineGroups: BrowserNode[] = [];
    if (input.databaseConnections) {
      engineGroups.push({
        id: "database-engine:postgres",
        kind: "category",
        label: labels.postgresql ?? "PostgreSQL",
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
    if (input.mssqlConnections) {
      engineGroups.push({
        id: "database-engine:mssql",
        kind: "category",
        label: labels.sqlServer ?? "SQL Server",
        addable: false,
        newConnectionKind: "mssql",
        count: input.mssqlConnections.length,
        children: input.mssqlConnections.map(
          (connection): BrowserNode => ({
            id: `mssql-connection:${connection.id}`,
            kind: "connection",
            label: connection.label,
            addable: false,
            mssqlConnectionId: connection.id,
            // Lazily filled with schema/table nodes on first expand.
            children: [],
          }),
        ),
      });
    }
    sections.push({
      id: "section:databases",
      kind: "section",
      label: labels.databases,
      addable: false,
      count: engineGroups.reduce((count, group) => count + (group.count ?? 0), 0),
      children: engineGroups,
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
 * in file-io/local-fs.ts (which `listDirectory` returns); duplicated here so this pure
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
  deployment?: boolean;
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
 * @param expandableServiceIds - Saved services that expand to their sublayers
 *   (ArcGIS MapServers), so a favorited one expands like the original.
 * @returns One node per favorite (service/connection/folder/file).
 */
export function buildFavoriteNodes(
  favorites: readonly FavoriteNodeInput[],
  expandableServiceIds: ReadonlySet<string> = new Set(),
): BrowserNode[] {
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
          // Keep the origin badge on a favorited managed service.
          builtin: fav.builtin,
          deployment: fav.deployment,
          // Shares the original node's id, so it shares its sublayer listing.
          ...(fav.serviceId && expandableServiceIds.has(fav.serviceId) ? { children: [] } : {}),
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
  tables: readonly DatabaseTableIdentity[],
): BrowserNode[] {
  const bySchema = new Map<string, DatabaseTableIdentity[]>();
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
  | { status: "loaded"; tables: readonly DatabaseTableIdentity[] }
  | { status: "error"; message: string };

export type ConnectionLoads = Record<string, ConnectionLoad>;
export type SetConnectionLoads = (update: (previous: ConnectionLoads) => ConnectionLoads) => void;

/**
 * Groups a saved SQL Server connection's spatial tables into `schema` → `table`
 * nodes, sorted by name, dropping repeated schema/table pairs.
 *
 * @param connectionId - The saved SQL Server profile id (embedded in node ids
 *   and carried on table nodes for the add flow).
 * @param tables - The spatial tables discovered for that connection.
 * @returns One `schema` group per distinct schema, each with its `table` leaves.
 */
export function buildMssqlTableNodes(
  connectionId: string,
  tables: readonly DatabaseTableIdentity[],
): BrowserNode[] {
  const bySchema = new Map<string, Map<string, DatabaseTableIdentity>>();
  for (const entry of tables) {
    let bucket = bySchema.get(entry.schema);
    if (!bucket) {
      bucket = new Map();
      bySchema.set(entry.schema, bucket);
    }
    if (!bucket.has(entry.table)) bucket.set(entry.table, entry);
  }
  return Array.from(bySchema.keys())
    .sort(byLabel)
    .map((schema) => {
      const entries = [...(bySchema.get(schema)?.values() ?? [])];
      return {
        id: `mssql-schema:${connectionId}:${schema}`,
        kind: "schema" as const,
        label: schema,
        addable: false,
        count: entries.length,
        children: entries
          .sort((a, b) => byLabel(a.table, b.table))
          .map(
            (entry): BrowserNode => ({
              id: `mssql-table:${connectionId}:${schema}.${entry.table}`,
              kind: "table",
              label: entry.table,
              addable: true,
              mssqlConnectionId: connectionId,
              tableSchema: schema,
              tableName: entry.table,
            }),
          ),
      };
    });
}

/**
 * Returns a copy of the tree with each `connection` node's children replaced by
 * the current lazy-load state: a status row while loading or on error, or the
 * schema→table nodes once loaded. Connections with no load entry keep their
 * empty child list (still expandable; expanding triggers the fetch) — so search
 * only reaches the tables of connections that have already been introspected.
 * Pure so the panel's tree augmentation unit-tests without React/the sidecar.
 *
 * @param nodes - The base tree from {@link buildBrowserTree}.
 * @param loads - Per-connection introspection state, keyed by connection string
 *   (PostGIS) or `mssql:<profile id>` (SQL Server).
 * @param loadingLabel - Translated label for the "loading tables" status row.
 * @returns A new tree; connection nodes get their status/table children.
 */
export function augmentConnections(
  nodes: readonly BrowserNode[],
  loads: Record<string, ConnectionLoad>,
  loadingLabel: string,
): BrowserNode[] {
  return nodes.map((node) => {
    if (node.kind === "connection" && (node.connectionString || node.mssqlConnectionId)) {
      const isMssql = Boolean(node.mssqlConnectionId);
      const connectionId = node.mssqlConnectionId ?? node.connectionString!;
      const load = loads[isMssql ? `mssql:${connectionId}` : connectionId];
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
        children = isMssql
          ? buildMssqlTableNodes(connectionId, load.tables)
          : buildPostgisTableNodes(connectionId, load.tables);
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
 * Whether a saved service is an ArcGIS MapServer the Browser can expand into
 * its sublayers: a `map-service` entry addressed by URL (a portal item has no
 * service URL to introspect until it is resolved).
 *
 * @param entry - The saved service.
 * @returns True when the entry should render as an expandable group.
 */
export function isArcGISMapServiceEntry(entry: ServiceLibraryEntry): boolean {
  return (
    entry.kind === "arcgis" &&
    serviceFieldString(entry.fields, "layerType") === "map-service" &&
    serviceFieldString(entry.fields, "sourceType") !== "portal-item" &&
    serviceFieldString(entry.fields, "url").trim() !== ""
  );
}

/** One sublayer advertised by a MapServer (matches `ArcGISMapServiceSublayer`). */
export interface ArcGISSublayerRef {
  id: number;
  name: string;
  /** Child layer ids when this is a group layer; absent or empty for a leaf. */
  subLayerIds?: readonly number[] | null;
  /** Whether the service draws this layer by default (absent means yes). */
  defaultVisibility?: boolean;
}

/** Async load state for one saved MapServer's sublayer listing. */
export type ArcGISServiceLoad =
  | { status: "loading" }
  | { status: "loaded"; sublayers: readonly ArcGISSublayerRef[] }
  | { status: "error"; message: string };

/** Translated labels for {@link augmentArcGISServices}' rows. */
export interface ArcGISServiceLabels {
  /** The status row shown while the sublayers load. */
  loading: string;
  /** The row that adds the whole service as saved. */
  allLayers: string;
}

/**
 * Builds a saved MapServer's children, mirroring the service's layer tree: an
 * "All layers" row that adds the service as saved, then one row per top-level
 * layer. A leaf row adds that sublayer; a group layer is an expandable row
 * holding its own "All layers" row (which adds the whole group) followed by
 * its children, so a group and the leaf it wraps (services often name both
 * "Storm Inlet") never sit side by side as look-alike rows. Pure so it
 * unit-tests without the network.
 *
 * @param serviceNode - The expandable `service` node the rows belong to.
 * @param sublayers - The layers the service advertises.
 * @param allLayersLabel - Translated label for the "All layers" rows.
 * @returns The child nodes.
 */
export function buildArcGISSublayerNodes(
  serviceNode: BrowserNode,
  sublayers: readonly ArcGISSublayerRef[],
  allLayersLabel: string,
): BrowserNode[] {
  const base = {
    kind: "arcgis-sublayer" as const,
    serviceId: serviceNode.serviceId,
    serviceKind: serviceNode.serviceKind,
  };
  const byId = new Map(sublayers.map((sublayer) => [sublayer.id, sublayer]));
  const childIds = new Set(sublayers.flatMap((sublayer) => sublayer.subLayerIds ?? []));
  // Guards against a malformed service whose group lists itself as a descendant.
  const seen = new Set<number>();

  /** Leaf ids under a layer, each with its effective default visibility. */
  const leaves = (
    sublayer: ArcGISSublayerRef,
    visible: boolean,
    visited: Set<number>,
  ): Array<{ id: number; visible: boolean }> => {
    if (visited.has(sublayer.id)) return [];
    visited.add(sublayer.id);
    const shown = visible && sublayer.defaultVisibility !== false;
    const childIds = sublayer.subLayerIds ?? [];
    if (childIds.length === 0) return [{ id: sublayer.id, visible: shown }];
    return childIds.flatMap((childId) => {
      const child = byId.get(childId);
      return child ? leaves(child, shown, visited) : [];
    });
  };

  const build = (sublayer: ArcGISSublayerRef): BrowserNode | null => {
    if (seen.has(sublayer.id)) return null;
    seen.add(sublayer.id);
    const id = `${serviceNode.id}:sublayer:${sublayer.id}`;
    const children = (sublayer.subLayerIds ?? [])
      .map((childId) => byId.get(childId))
      .filter((child): child is ArcGISSublayerRef => child !== undefined)
      .map(build)
      .filter((child): child is BrowserNode => child !== null);
    if (children.length === 0) {
      return { ...base, id, label: sublayer.name, addable: true, arcgisSublayerId: sublayer.id };
    }
    // The user picked this group, so its own default visibility does not
    // matter; its descendants' does. With none visible by default, draw all.
    // One visited set for the whole subtree, so a leaf two children share is
    // listed once.
    const groupVisited = new Set([sublayer.id]);
    const groupLeaves = (sublayer.subLayerIds ?? []).flatMap((childId) => {
      const child = byId.get(childId);
      return child ? leaves(child, true, groupVisited) : [];
    });
    const shownLeaves = groupLeaves.filter((leaf) => leaf.visible);
    return {
      ...base,
      id,
      label: sublayer.name,
      addable: false,
      children: [
        {
          ...base,
          id: `${id}:all`,
          label: allLayersLabel,
          addable: true,
          arcgisSublayerId: sublayer.id,
          arcgisLayerName: sublayer.name,
          arcgisSublayers: (shownLeaves.length > 0 ? shownLeaves : groupLeaves)
            .map((leaf) => leaf.id)
            .join(","),
        },
        ...children,
      ],
    };
  };

  return [
    { ...base, id: `${serviceNode.id}:all`, label: allLayersLabel, addable: true },
    ...sublayers
      .filter((sublayer) => !childIds.has(sublayer.id))
      .map(build)
      .filter((node): node is BrowserNode => node !== null),
  ];
}

/**
 * Returns a copy of the tree with each expandable ArcGIS MapServer `service`
 * node's children replaced by its lazy-load state: a status row while loading
 * or on error, or the sublayer rows once loaded. A service with no load entry
 * keeps its empty child list (still expandable; expanding triggers the fetch).
 * Pure, like {@link augmentConnections}.
 *
 * @param nodes - The tree to augment.
 * @param loads - Per-service sublayer state keyed by saved-service id.
 * @param labels - Translated row labels.
 * @returns A new tree; MapServer nodes get their status/sublayer children.
 */
export function augmentArcGISServices(
  nodes: readonly BrowserNode[],
  loads: Record<string, ArcGISServiceLoad>,
  labels: ArcGISServiceLabels,
): BrowserNode[] {
  return nodes.map((node) => {
    if (node.kind === "service" && node.serviceId && node.children) {
      const load = loads[node.serviceId];
      let children: BrowserNode[] = [];
      if (load?.status === "loading") {
        children = [
          { id: `${node.id}:loading`, kind: "info", label: labels.loading, addable: false },
        ];
      } else if (load?.status === "error") {
        children = [{ id: `${node.id}:error`, kind: "info", label: load.message, addable: false }];
      } else if (load?.status === "loaded") {
        children = buildArcGISSublayerNodes(node, load.sublayers, labels.allLayers);
      }
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: augmentArcGISServices(node.children, loads, labels) };
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
