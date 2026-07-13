import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RecentProjectEntry } from "@geolibre/core";
import {
  augmentConnections,
  augmentFolders,
  buildBrowserTree,
  buildDirectoryNodes,
  buildFavoriteNodes,
  buildPostgisTableNodes,
  filterBrowserTree,
  MAX_DIRECTORY_ENTRIES,
  type BrowserNode,
  type ConnectionLoad,
  type DirectoryEntry,
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
    // Each kind group carries the Add Data source its "New connection" action
    // opens.
    assert.equal(find(tree, "kind:wms")?.newConnectionKind, "wms");
    assert.equal(find(tree, "kind:arcgis")?.newConnectionKind, "arcgis");
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

  it("defaults the section labels to English when none are given", () => {
    const tree = buildBrowserTree({ services: [], recentProjects: [] });
    assert.equal(find(tree, "section:services")?.label, "Services");
    assert.equal(find(tree, "section:recent")?.label, "Recent");
  });

  it("applies translated section labels when provided", () => {
    const tree = buildBrowserTree({
      services: [],
      recentProjects: [],
      sectionLabels: { services: "Servicios", recent: "Recientes" },
    });
    assert.equal(find(tree, "section:services")?.label, "Servicios");
    assert.equal(find(tree, "section:recent")?.label, "Recientes");
  });

  it("omits the Databases section unless connections are provided", () => {
    const tree = buildBrowserTree({ services: [], recentProjects: [] });
    assert.equal(find(tree, "section:databases"), undefined);
    assert.deepEqual(
      tree.map((n) => n.id),
      ["section:services", "section:recent"],
    );
  });

  it("adds a Databases section with connection leaves + a postgres ＋", () => {
    const tree = buildBrowserTree({
      services: [],
      recentProjects: [],
      databaseConnections: [
        { connectionString: "postgres://u@h/db", label: "db @ h" },
      ],
    });
    const db = find(tree, "section:databases");
    assert.equal(db?.kind, "section");
    // The section's ＋ opens the Add Data PostgreSQL source.
    assert.equal(db?.newConnectionKind, "postgres");
    assert.equal(db?.count, 1);
    const conn = find(tree, "connection:postgres://u@h/db");
    assert.equal(conn?.kind, "connection");
    assert.equal(conn?.connectionString, "postgres://u@h/db");
    assert.equal(conn?.label, "db @ h");
    // A connection is an expandable group (empty children until introspected),
    // not an addable leaf.
    assert.equal(conn?.addable, false);
    assert.deepEqual(conn?.children, []);
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

describe("buildPostgisTableNodes", () => {
  const CONN = "postgresql://u@h/db";

  it("groups tables into schema → table nodes, sorted by name", () => {
    const nodes = buildPostgisTableNodes(CONN, [
      { schema: "public", table: "roads" },
      { schema: "public", table: "buildings" },
      { schema: "census", table: "tracts" },
    ]);
    // Schemas sorted alphabetically.
    assert.deepEqual(
      nodes.map((n) => n.label),
      ["census", "public"],
    );
    assert.equal(nodes[0].kind, "schema");
    assert.equal(nodes[0].id, `schema:${CONN}:census`);
    assert.equal(nodes[0].count, 1);
    // Tables within a schema sorted alphabetically.
    const publicSchema = nodes[1];
    assert.equal(publicSchema.count, 2);
    assert.deepEqual(
      publicSchema.children?.map((c) => c.label),
      ["buildings", "roads"],
    );
  });

  it("carries the connection, schema, and table onto each table node", () => {
    const nodes = buildPostgisTableNodes(CONN, [
      { schema: "public", table: "roads" },
    ]);
    const table = nodes[0].children?.[0];
    assert.equal(table?.kind, "table");
    assert.equal(table?.id, `table:${CONN}:public.roads`);
    assert.equal(table?.label, "roads");
    assert.equal(table?.addable, true);
    assert.equal(table?.connectionString, CONN);
    assert.equal(table?.tableSchema, "public");
    assert.equal(table?.tableName, "roads");
  });

  it("returns an empty array for no tables", () => {
    assert.deepEqual(buildPostgisTableNodes(CONN, []), []);
  });
});

describe("buildFavoriteNodes", () => {
  it("rebuilds each favorite kind into its node", () => {
    const nodes = buildFavoriteNodes([
      { id: "service:s1", kind: "service", label: "Basemap", serviceId: "s1", serviceKind: "xyz", builtin: true },
      { id: "folder:/d", kind: "folder", label: "d", path: "/d" },
      { id: "file:/d/a.geojson", kind: "file", label: "a.geojson", path: "/d/a.geojson" },
    ]);
    assert.deepEqual(
      nodes.map((n) => `${n.kind}:${n.addable}`),
      ["service:true", "folder:false", "file:true"],
    );
    // A favorited folder is an expandable group with empty children; the id
    // matches the original so the panel's per-path state is shared.
    assert.deepEqual(nodes[1].children, []);
    assert.equal(nodes[0].serviceId, "s1");
    assert.equal(nodes[0].builtin, true); // built-in badge preserved
    assert.equal(nodes[2].path, "/d/a.geojson");
  });
});

describe("buildBrowserTree — Favorites section", () => {
  it("omits the Favorites section when there are no favorites", () => {
    const tree = buildBrowserTree({ services: [], recentProjects: [] });
    assert.equal(find(tree, "section:favorites"), undefined);
    assert.equal(tree[0].id, "section:services");
  });

  it("leads with a Favorites section when favorites exist", () => {
    const tree = buildBrowserTree({
      services: [],
      recentProjects: [],
      favorites: [
        { id: "service:s1", kind: "service", label: "Basemap", serviceId: "s1" },
      ],
    });
    // Favorites is the first section.
    assert.equal(tree[0].id, "section:favorites");
    assert.equal(tree[0].count, 1);
    assert.equal(find(tree, "service:s1")?.label, "Basemap");
  });
});

describe("buildBrowserTree — Files section", () => {
  it("omits the Files section unless files input is provided", () => {
    const tree = buildBrowserTree({ services: [], recentProjects: [] });
    assert.equal(find(tree, "section:files"), undefined);
  });

  it("adds a Files section with an Add-folder action and removable pins", () => {
    const tree = buildBrowserTree({
      services: [],
      recentProjects: [],
      files: {
        folders: [
          { path: "/data/gis", label: "gis" },
          { path: "/home/u/maps", label: "maps" },
        ],
      },
    });
    const files = find(tree, "section:files");
    assert.equal(files?.kind, "section");
    assert.equal(files?.addFolderAction, true);
    assert.equal(files?.count, 2);
    // Pinned folders are listed in the given (MRU) order.
    assert.deepEqual(
      files?.children?.map((c) => c.label),
      ["gis", "maps"],
    );
    const pin = find(tree, "folder:/data/gis");
    assert.equal(pin?.kind, "folder");
    assert.equal(pin?.path, "/data/gis");
    assert.equal(pin?.removable, true); // pinned roots can be unpinned
    assert.deepEqual(pin?.children, []); // expandable, lazily filled
  });

  it("renders the Files section with only the Add-folder action when empty", () => {
    const tree = buildBrowserTree({
      services: [],
      recentProjects: [],
      files: { folders: [] },
    });
    const files = find(tree, "section:files");
    assert.equal(files?.addFolderAction, true);
    assert.equal(files?.children?.length, 0);
  });
});

describe("buildDirectoryNodes", () => {
  const entries: DirectoryEntry[] = [
    { name: "roads.geojson", path: "/d/roads.geojson", isDirectory: false },
    { name: "sub", path: "/d/sub", isDirectory: true },
    { name: "notes.txt", path: "/d/notes.txt", isDirectory: false },
    { name: "aaa", path: "/d/aaa", isDirectory: true },
    { name: ".hidden", path: "/d/.hidden", isDirectory: true },
  ];
  const isLoadable = (name: string) => name.endsWith(".geojson");

  it("lists folders first (sorted), then loadable files (sorted)", () => {
    const nodes = buildDirectoryNodes(entries, isLoadable);
    assert.deepEqual(
      nodes.map((n) => `${n.kind}:${n.label}`),
      ["folder:aaa", "folder:sub", "file:roads.geojson"],
    );
  });

  it("drops non-loadable files and hidden dotfiles", () => {
    const nodes = buildDirectoryNodes(entries, isLoadable);
    assert.equal(
      nodes.find((n) => n.label === "notes.txt"),
      undefined,
    );
    assert.equal(
      nodes.find((n) => n.label === ".hidden"),
      undefined,
    );
  });

  it("makes folders expandable groups and files addable leaves", () => {
    const nodes = buildDirectoryNodes(entries, isLoadable);
    const folder = nodes.find((n) => n.kind === "folder");
    assert.deepEqual(folder?.children, []);
    assert.equal(folder?.addable, false);
    const file = nodes.find((n) => n.kind === "file");
    assert.equal(file?.addable, true);
    assert.equal(file?.path, "/d/roads.geojson");
  });
});

describe("augmentFolders", () => {
  const isLoadable = (name: string) => name.endsWith(".geojson");
  const baseTree = () =>
    buildBrowserTree({
      services: [],
      recentProjects: [],
      files: { folders: [{ path: "/d", label: "d" }] },
    });

  it("injects a loading row while a folder is loading", () => {
    const out = augmentFolders(
      baseTree(),
      { "/d": { status: "loading" } },
      "Loading…",
      isLoadable,
    );
    const folder = find(out, "folder:/d");
    assert.equal(folder?.children?.length, 1);
    assert.equal(folder?.children?.[0].kind, "info");
    assert.equal(folder?.children?.[0].label, "Loading…");
  });

  it("injects subfolder/file nodes once loaded", () => {
    const out = augmentFolders(
      baseTree(),
      {
        "/d": {
          status: "loaded",
          entries: [
            { name: "sub", path: "/d/sub", isDirectory: true },
            { name: "a.geojson", path: "/d/a.geojson", isDirectory: false },
          ],
        },
      },
      "Loading…",
      isLoadable,
    );
    assert.deepEqual(
      find(out, "folder:/d")?.children?.map((c) => c.label),
      ["sub", "a.geojson"],
    );
  });

  it("injects an error row when a folder fails to load", () => {
    const out = augmentFolders(
      baseTree(),
      { "/d": { status: "error", message: "Permission denied" } },
      "Loading…",
      isLoadable,
    );
    const folder = find(out, "folder:/d");
    assert.equal(folder?.children?.length, 1);
    assert.equal(folder?.children?.[0].kind, "info");
    assert.equal(folder?.children?.[0].label, "Permission denied");
  });

  it("caps a huge folder and appends a truncation row", () => {
    const entries: DirectoryEntry[] = Array.from(
      { length: MAX_DIRECTORY_ENTRIES + 3 },
      (_unused, i) => ({
        name: `f${String(i).padStart(5, "0")}.geojson`,
        path: `/d/f${i}.geojson`,
        isDirectory: false,
      }),
    );
    const out = augmentFolders(
      baseTree(),
      { "/d": { status: "loaded", entries } },
      "Loading…",
      isLoadable,
      (shown, total) => `first ${shown}/${total}`,
    );
    const children = find(out, "folder:/d")?.children ?? [];
    // MAX kept file nodes + one truncation info row.
    assert.equal(children.length, MAX_DIRECTORY_ENTRIES + 1);
    const last = children[children.length - 1];
    assert.equal(last.kind, "info");
    assert.equal(last.label, `first ${MAX_DIRECTORY_ENTRIES}/${entries.length}`);
  });

  it("recurses so an already-expanded subfolder also gets its listing", () => {
    const out = augmentFolders(
      baseTree(),
      {
        "/d": {
          status: "loaded",
          entries: [{ name: "sub", path: "/d/sub", isDirectory: true }],
        },
        "/d/sub": {
          status: "loaded",
          entries: [
            { name: "b.geojson", path: "/d/sub/b.geojson", isDirectory: false },
          ],
        },
      },
      "Loading…",
      isLoadable,
    );
    const sub = find(out, "folder:/d/sub");
    assert.equal(sub?.children?.length, 1);
    assert.equal(sub?.children?.[0].label, "b.geojson");
  });
});

describe("augmentConnections", () => {
  const CONN = "postgres://u@h/db";
  const baseTree = () =>
    buildBrowserTree({
      services: [],
      recentProjects: [],
      databaseConnections: [{ connectionString: CONN, label: "db @ h" }],
    });

  function augment(load?: ConnectionLoad): BrowserNode | undefined {
    const loads = load ? { [CONN]: load } : {};
    const out = augmentConnections(baseTree(), loads, "Loading tables…");
    return find(out, `connection:${CONN}`);
  }

  it("leaves an un-introspected connection with empty children", () => {
    assert.deepEqual(augment()?.children, []);
  });

  it("shows a single loading info row while loading", () => {
    const children = augment({ status: "loading" })?.children;
    assert.equal(children?.length, 1);
    assert.equal(children?.[0].kind, "info");
    assert.equal(children?.[0].id, `connection:${CONN}:loading`);
    assert.equal(children?.[0].label, "Loading tables…");
  });

  it("shows the error message in an info row on error", () => {
    const children = augment({ status: "error", message: "boom" })?.children;
    assert.equal(children?.length, 1);
    assert.equal(children?.[0].kind, "info");
    assert.equal(children?.[0].id, `connection:${CONN}:error`);
    assert.equal(children?.[0].label, "boom");
  });

  it("builds schema→table children once loaded", () => {
    const children = augment({
      status: "loaded",
      tables: [
        { schema: "public", table: "roads" },
        { schema: "census", table: "tracts" },
      ],
    })?.children;
    assert.deepEqual(
      children?.map((c) => c.label),
      ["census", "public"],
    );
    assert.equal(find([children![1]], `table:${CONN}:public.roads`)?.kind, "table");
  });

  it("does not mutate the input tree", () => {
    const tree = baseTree();
    augmentConnections(tree, { [CONN]: { status: "loading" } }, "Loading…");
    assert.deepEqual(find(tree, `connection:${CONN}`)?.children, []);
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
