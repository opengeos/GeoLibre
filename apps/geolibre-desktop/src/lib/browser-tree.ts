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
  /** The saved database connection string a `connection`/`table` node belongs to. */
  connectionString?: string;
  /** The schema of a `table` node. */
  tableSchema?: string;
  /** The table name of a `table` node. */
  tableName?: string;
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
   * Translated labels for the top-level sections. Optional so the pure module
   * (and its tests) default to English; the app passes `t()` values.
   */
  sectionLabels?: { services: string; recent: string; databases: string };
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
const KIND_ORDER: readonly ServiceLibraryKind[] = [
  "xyz",
  "wms",
  "wfs",
  "wmts",
  "arcgis",
];

/**
 * Groups services by kind (XYZ / WMS / WFS / WMTS / ArcGIS) so the tree mirrors
 * the Add Data web-service sources, ordering the groups by {@link KIND_ORDER}
 * and the services within each by name. Built-in presets and user entries are
 * interleaved so each kind reads as one catalog.
 */
function buildServiceKinds(
  services: readonly ServiceLibraryEntry[],
): BrowserNode[] {
  const byKind = new Map<ServiceLibraryKind, ServiceLibraryEntry[]>();
  for (const entry of services) {
    const bucket = byKind.get(entry.kind);
    if (bucket) bucket.push(entry);
    else byKind.set(entry.kind, [entry]);
  }
  return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => {
    const entries = [...(byKind.get(kind) ?? [])].sort((a, b) =>
      byLabel(a.name, b.name),
    );
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

  const sections = [servicesSection, recentSection];

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

  return sections;
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
export function filterBrowserTree(
  nodes: readonly BrowserNode[],
  query: string,
): BrowserNode[] {
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

  return nodes
    .map(prune)
    .filter((node): node is BrowserNode => node !== null);
}
