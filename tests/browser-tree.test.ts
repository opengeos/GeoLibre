import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecentProjectEntry } from "@geolibre/core";
import {
  buildBrowserTree,
  filterBrowserTree,
  type BrowserNode,
} from "../apps/geolibre-desktop/src/lib/browser-tree";
import type { ServiceLibraryEntry } from "../apps/geolibre-desktop/src/components/layout/add-data/service-library";

function service(
  id: string,
  name: string,
  category: string,
  extra: Partial<ServiceLibraryEntry> = {},
): ServiceLibraryEntry {
  return {
    id,
    name,
    category,
    kind: "xyz",
    fields: { url: `https://example.com/${id}` },
    ...extra,
  };
}

const RECENT: RecentProjectEntry[] = [
  { path: "/a/one.geolibre.json", name: "One", openedAt: "2026-01-02" },
  { path: "/a/two.geolibre.json", name: "Two", openedAt: "2026-01-01" },
];

/** Finds a node by id anywhere in the tree (depth-first). */
function find(nodes: BrowserNode[], id: string): BrowserNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const hit = find(node.children, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe("buildBrowserTree", () => {
  it("returns Services then Recent sections", () => {
    const tree = buildBrowserTree({ services: [], recentProjects: [] });
    assert.deepEqual(
      tree.map((n) => n.id),
      ["section:services", "section:recent"],
    );
    assert.equal(tree[0].kind, "section");
    // Empty sections are still present (the panel renders an empty state).
    assert.equal(tree[0].children?.length, 0);
    assert.equal(tree[1].children?.length, 0);
  });

  it("groups services by category and sorts categories + entries by label", () => {
    const tree = buildBrowserTree({
      services: [
        service("s1", "Zebra", "Imagery"),
        service("s2", "Alpha", "Imagery"),
        service("s3", "Basemap one", "Basemaps"),
      ],
      recentProjects: [],
    });
    const services = tree[0];
    // Categories sorted: Basemaps before Imagery.
    assert.deepEqual(
      services.children?.map((c) => c.label),
      ["Basemaps", "Imagery"],
    );
    const imagery = find(tree, "category:Imagery");
    // Entries within a category sorted by name: Alpha before Zebra.
    assert.deepEqual(
      imagery?.children?.map((c) => c.label),
      ["Alpha", "Zebra"],
    );
    assert.equal(imagery?.count, 2);
    assert.equal(services.count, 3);
  });

  it("buckets a blank category under Uncategorized", () => {
    const tree = buildBrowserTree({
      services: [service("s1", "Loose", "")],
      recentProjects: [],
    });
    assert.ok(find(tree, "category:Uncategorized"));
  });

  it("carries the service id, kind, and builtin flag onto leaf nodes", () => {
    const tree = buildBrowserTree({
      services: [
        service("s1", "WMS one", "Web", { kind: "wms", builtin: true }),
      ],
      recentProjects: [],
    });
    const leaf = find(tree, "service:s1");
    assert.equal(leaf?.kind, "service");
    assert.equal(leaf?.addable, true);
    assert.equal(leaf?.serviceId, "s1");
    assert.equal(leaf?.serviceKind, "wms");
    assert.equal(leaf?.builtin, true);
  });

  it("lists recent projects in the given order with their paths", () => {
    const tree = buildBrowserTree({ services: [], recentProjects: RECENT });
    const recent = tree[1];
    assert.deepEqual(
      recent.children?.map((n) => n.label),
      ["One", "Two"],
    );
    const one = find(tree, "recent:/a/one.geolibre.json");
    assert.equal(one?.kind, "recent-project");
    assert.equal(one?.projectPath, "/a/one.geolibre.json");
    assert.equal(one?.addable, true);
  });
});

describe("filterBrowserTree", () => {
  const tree = buildBrowserTree({
    services: [
      service("s1", "Landsat imagery", "Imagery"),
      service("s2", "OpenStreetMap", "Basemaps"),
    ],
    recentProjects: RECENT,
  });

  it("returns the tree unchanged for an empty query", () => {
    const out = filterBrowserTree(tree, "   ");
    assert.deepEqual(
      out.map((n) => n.id),
      tree.map((n) => n.id),
    );
  });

  it("keeps only branches with a matching leaf and prunes the rest", () => {
    const out = filterBrowserTree(tree, "landsat");
    // Recent section has no match → dropped entirely.
    assert.deepEqual(
      out.map((n) => n.id),
      ["section:services"],
    );
    // Only the Imagery category (with Landsat) survives under Services.
    assert.deepEqual(
      out[0].children?.map((c) => c.label),
      ["Imagery"],
    );
    assert.equal(find(out, "service:s1")?.label, "Landsat imagery");
    assert.equal(find(out, "service:s2"), undefined);
  });

  it("matches a recent project by name", () => {
    const out = filterBrowserTree(tree, "two");
    assert.deepEqual(
      out.map((n) => n.id),
      ["section:recent"],
    );
    assert.equal(out[0].children?.length, 1);
    assert.equal(out[0].children?.[0].label, "Two");
  });

  it("keeps all children when a group label itself matches", () => {
    const out = filterBrowserTree(tree, "imagery");
    // "Imagery" category matches by its own label, so its child is retained.
    const imagery = find(out, "category:Imagery");
    assert.equal(imagery?.children?.length, 1);
  });

  it("counts total matching leaves, not surviving subgroups, on a section", () => {
    // Two services under one category, so a match on the category label keeps
    // both leaves but leaves the section with a single surviving child.
    const twoInImagery = buildBrowserTree({
      services: [
        service("a", "Aerial", "Imagery"),
        service("b", "Satellite", "Imagery"),
      ],
      recentProjects: [],
    });
    const out = filterBrowserTree(twoInImagery, "imagery");
    // The Services badge must report 2 (both visible leaves), not 1 (one
    // surviving category).
    assert.equal(find(out, "section:services")?.count, 2);
    assert.equal(find(out, "category:Imagery")?.count, 2);
  });

  it("does not mutate the input tree", () => {
    const before = tree[0].children?.length;
    filterBrowserTree(tree, "landsat");
    assert.equal(tree[0].children?.length, before);
  });
});
