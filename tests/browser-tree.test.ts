import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecentProjectEntry } from "@geolibre/core";
import {
  buildBrowserTree,
  filterBrowserTree,
  type BrowserNode,
} from "../apps/geolibre-desktop/src/lib/browser-tree";
import type {
  ServiceLibraryEntry,
  ServiceLibraryKind,
} from "../apps/geolibre-desktop/src/components/layout/add-data/service-library";

function service(
  id: string,
  name: string,
  kind: ServiceLibraryKind = "xyz",
  extra: Partial<ServiceLibraryEntry> = {},
): ServiceLibraryEntry {
  return {
    id,
    name,
    category: "",
    kind,
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

  it("groups services by kind, ordered like the Add Data sources", () => {
    const tree = buildBrowserTree({
      services: [
        service("s1", "A feature layer", "arcgis"),
        service("s2", "A basemap", "xyz"),
        service("s3", "A map service", "wms"),
      ],
      recentProjects: [],
    });
    const services = tree[0];
    // Kind order mirrors Add Data: XYZ, then WMS, ..., then ArcGIS.
    assert.deepEqual(
      services.children?.map((c) => c.label),
      ["XYZ", "WMS", "ArcGIS"],
    );
    assert.deepEqual(
      services.children?.map((c) => c.id),
      ["kind:xyz", "kind:wms", "kind:arcgis"],
    );
    assert.equal(services.count, 3);
  });

  it("sorts services within a kind by name", () => {
    const tree = buildBrowserTree({
      services: [
        service("s1", "Zebra tiles", "xyz"),
        service("s2", "Alpha tiles", "xyz"),
      ],
      recentProjects: [],
    });
    const xyz = find(tree, "kind:xyz");
    assert.deepEqual(
      xyz?.children?.map((c) => c.label),
      ["Alpha tiles", "Zebra tiles"],
    );
    assert.equal(xyz?.count, 2);
  });

  it("carries the service id, kind, and builtin flag onto leaf nodes", () => {
    const tree = buildBrowserTree({
      services: [service("s1", "WMS one", "wms", { builtin: true })],
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
      service("s1", "Landsat imagery", "xyz"),
      service("s2", "US States", "wms"),
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
    // Only the XYZ kind (with Landsat) survives under Services.
    assert.deepEqual(
      out[0].children?.map((c) => c.id),
      ["kind:xyz"],
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

  it("matches a kind group by its header label", () => {
    const out = filterBrowserTree(tree, "wms");
    // "WMS" group label matches, so its child is retained.
    const wms = find(out, "kind:wms");
    assert.equal(wms?.children?.length, 1);
    assert.equal(wms?.children?.[0].label, "US States");
  });

  it("counts total matching leaves, not surviving subgroups, on a section", () => {
    // Two services of one kind, so a match on the kind label keeps both leaves
    // but leaves the section with a single surviving child.
    const twoWms = buildBrowserTree({
      services: [
        service("a", "Aerial", "wms"),
        service("b", "Satellite", "wms"),
      ],
      recentProjects: [],
    });
    const out = filterBrowserTree(twoWms, "wms");
    // The Services badge must report 2 (both visible leaves), not 1 (one
    // surviving kind group).
    assert.equal(find(out, "section:services")?.count, 2);
    assert.equal(find(out, "kind:wms")?.count, 2);
  });

  it("does not mutate the input tree", () => {
    const before = tree[0].children?.length;
    filterBrowserTree(tree, "landsat");
    assert.equal(tree[0].children?.length, before);
  });
});
