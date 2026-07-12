/**
 * Pure tree model for the Browser (Data Source Manager) panel — a QGIS-style
 * navigable tree that unifies the app's existing data entry points into one
 * surface. This module builds the node tree from already-loaded inputs (the
 * saved-service library and the recent-projects list); it has no React, I/O, or
 * store dependencies, so it unit-tests in isolation. The `useBrowserTree` hook
 * feeds it live data and the `BrowserPanel` renders the result.
 *
 * The MVP covers two top-level sections — **Services** (grouped by service kind,
 * mirroring the Add Data web-service sources: XYZ, WMS, WFS, WMTS, ArcGIS) and
 * **Recent** (recently opened projects). Local-file and connection sections come
 * in a later phase.
 */

import {
  type ServiceLibraryEntry,
  type ServiceLibraryKind,
} from "../components/layout/add-data/service-library";
import type { RecentProjectEntry } from "@geolibre/core";

/** The kind of node, which determines its icon and click behavior. */
export type BrowserNodeKind =
  | "section" // a static top-level group (Services, Recent)
  | "category" // a service category grouping (Imagery, Basemaps, …)
  | "service" // a saved-service leaf that adds a layer when activated
  | "recent-project"; // a recent project that opens when activated

/** One node in the Browser tree. */
export interface BrowserNode {
  /** Stable, unique id (e.g. `service:<entryId>`, `category:Imagery`). */
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
 * @param input - The services to list and the recent-projects list.
 * @returns The top-level section nodes (Services, then Recent).
 */
export function buildBrowserTree(input: BrowserTreeInput): BrowserNode[] {
  const kinds = buildServiceKinds(input.services);
  const servicesSection: BrowserNode = {
    id: "section:services",
    kind: "section",
    label: "Services",
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
    label: "Recent",
    addable: false,
    count: recentChildren.length,
    children: recentChildren,
  };

  return [servicesSection, recentSection];
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
