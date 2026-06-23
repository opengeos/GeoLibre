#!/usr/bin/env node
// Regenerate apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts from the
// Whitebox Next Gen catalog snapshot. The snapshot is the same source the
// Whitebox toolbox dialog falls back to, so tool ids stay in sync.
//
// Usage: node scripts/gen-whitebox-menu-catalog.mjs
//
// Groups the requested top-level categories (Conversion, Hydrology, LiDAR,
// Network, Projection, Raster, Remote Sensing, Terrain, Vector) by the catalog's
// "<Category> - <Subcategory>" naming. Tool/subcategory names are catalog data
// and are emitted verbatim (not translated), matching the dialog.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SNAPSHOT_URL =
  "https://raw.githubusercontent.com/opengeos/Whitebox-Next-Gen-ArcGIS/main/WNG/data/catalog_snapshot.json";

// Subcategory label for the GeoLibre-authored WASM tools. They carry bare
// categories (e.g. "Raster") and are not in the Whitebox snapshot, so we group
// them under their own heading within each top-level category instead of mixing
// them into the long "General" list.
const GEOLIBRE_SUBCATEGORY = "GeoLibre";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts",
);

// The full snapshot is also bundled into the app as a public asset so the
// Whitebox toolbox dialog loads its catalog offline, without fetching GitHub
// (restricted/air-gapped environments cannot reach raw.githubusercontent.com).
const SNAPSHOT_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/geolibre-desktop/public/whitebox-catalog-snapshot.json",
);

// [key, i18n labelKey, predicate over the catalog `category` string]. Existing
// i18n keys are reused where they exist; new ones were added to en.json.
// Ordered alphabetically by display label so the level-1 submenus read A-Z.
const GROUPS = [
  ["conversion", "toolbar.item.conversion", (c) => c.startsWith("Conversion")],
  ["hydrology", "toolbar.item.hydrology", (c) => c.startsWith("Hydrology")],
  ["lidar", "toolbar.item.lidar", (c) => c.startsWith("LiDAR")],
  ["network", "toolbar.item.network", (c) => c === "Vector - Network Analysis"],
  [
    "projection",
    "toolbar.item.projection",
    (c) => c.startsWith("Projection"),
  ],
  [
    "raster",
    "toolbar.item.raster",
    (c) => c === "Raster" || c.startsWith("Raster -"),
  ],
  [
    "remoteSensing",
    "toolbar.item.remoteSensing",
    (c) => c.startsWith("Remote Sensing"),
  ],
  [
    "terrain",
    "toolbar.item.terrain",
    (c) => c === "Terrain" || c.startsWith("Terrain -"),
  ],
  [
    "vector",
    "toolbar.item.vector",
    (c) => c.startsWith("Vector") && !c.includes("Network"),
  ],
];

const subcatLabel = (cat) =>
  cat.includes(" - ") ? cat.split(" - ").slice(1).join(" - ") : "General";

const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Load the GeoLibre-authored WASM tools from the geolibre-wasm binary's own
// manifests (they are not in the Whitebox snapshot). Returns [] if the package
// or wasm is unavailable, so the generator still produces a snapshot-only menu.
async function loadGeolibreWasmTools() {
  try {
    const { initTools, listManifests } = await import("geolibre-wasm/tools");
    const toolsUrl = import.meta.resolve("geolibre-wasm/tools");
    const wasmPath = join(
      dirname(fileURLToPath(toolsUrl)),
      "geolibre-cli.wasm",
    );
    await initTools(readFileSync(wasmPath));
    const manifests = await listManifests();
    return manifests
      .filter((m) => (m.source ?? "").toLowerCase() === "geolibre" && !m.locked)
      .map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        category: m.category ?? "",
      }));
  } catch (err) {
    console.warn(
      `Could not load geolibre-wasm tools (${err.message}); menu will list Whitebox tools only.`,
    );
    return [];
  }
}

async function main() {
  const res = await fetch(SNAPSHOT_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch catalog snapshot: ${res.status}`);
  }
  const snapshot = await res.json();
  const { tools } = snapshot;

  // Bundle a sanitized, minified copy for the app:
  //  - Drop the upstream `source` field: it holds the generating machine's
  //    absolute filesystem path, which must not ship in the app.
  //  - Drop `*args`/`**kwargs` params: these are Python varargs that leak into
  //    the schema and render as unusable input fields in the dialog.
  // The dialog only reads `tools`.
  const { source: _source, ...rest } = snapshot;
  const bundled = {
    ...rest,
    tools: tools.map((t) =>
      Array.isArray(t.params)
        ? {
            ...t,
            params: t.params.filter(
              (p) => !String(p?.name ?? "").startsWith("*"),
            ),
          }
        : t,
    ),
  };
  writeFileSync(SNAPSHOT_OUT, `${JSON.stringify(bundled)}\n`);
  console.log(
    `Wrote ${SNAPSHOT_OUT} (${tools.length} tools, ${Math.round(
      Buffer.byteLength(JSON.stringify(bundled)) / 1024,
    )} KB).`,
  );

  const geolibre = await loadGeolibreWasmTools();
  const geolibreIds = new Set(geolibre.map((t) => t.id));

  // Only free tools: locked/"pro"-tier Whitebox tools cannot run, so omit them
  // from the menu entirely (the dialog hides them too). Also drop any snapshot
  // tool whose id is a GeoLibre WASM tool: the dialog replaces the snapshot
  // entry with the GeoLibre one on an id collision, so listing both would point
  // two menu leaves at the same loaded tool.
  const free = tools.filter((t) => !t.locked && !geolibreIds.has(t.id));

  const cats = [];
  let total = 0;
  for (const [key, labelKey, pred] of GROUPS) {
    const sel = free.filter((t) => pred(t.category ?? ""));
    const bySub = new Map();
    for (const t of sel) {
      const label = subcatLabel(t.category ?? "");
      if (!bySub.has(label)) bySub.set(label, []);
      bySub.get(label).push({ id: t.id, name: t.display_name || t.id });
    }
    // GeoLibre-authored tools whose bare category falls in this group go under
    // the dedicated GeoLibre heading.
    const glHere = geolibre.filter((t) => pred(t.category));
    for (const t of glHere) {
      if (!bySub.has(GEOLIBRE_SUBCATEGORY)) bySub.set(GEOLIBRE_SUBCATEGORY, []);
      bySub.get(GEOLIBRE_SUBCATEGORY).push({ id: t.id, name: t.name });
    }
    // GeoLibre first, then "General" (bare category), then named subcategories
    // alphabetically.
    const rank = (s) =>
      s === GEOLIBRE_SUBCATEGORY ? 0 : s === "General" ? 1 : 2;
    const subLabels = [...bySub.keys()].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return a.toLowerCase().localeCompare(b.toLowerCase());
    });
    const subcategories = subLabels
      .map((label) => ({
        label,
        tools: bySub
          .get(label)
          .sort((a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
          ),
      }))
      .filter((s) => s.tools.length > 0);
    if (subcategories.length === 0) continue;
    cats.push({ key, labelKey, subcategories });
    total += sel.length + glHere.length;
  }

  const L = [];
  L.push("// AUTO-GENERATED for the Processing menu's Whitebox tool categories.");
  L.push("// Whitebox tools come from the Whitebox Next Gen catalog snapshot");
  L.push("// (opengeos/Whitebox-Next-Gen-ArcGIS WNG/data/catalog_snapshot.json);");
  L.push("// GeoLibre-authored WASM tools come from the geolibre-wasm manifests and");
  L.push("// are grouped under a \"GeoLibre\" subheading. Tool ids match the");
  L.push("// runtime/sidecar/WASM catalog used by ProcessingDialog.");
  L.push("// Regenerate with scripts/gen-whitebox-menu-catalog.mjs; do not hand-edit.");
  L.push("// Tool/subcategory names are catalog data and are intentionally not");
  L.push("// translated, matching the Whitebox toolbox dialog.");
  L.push("");
  L.push('import type { ParseKeys } from "i18next";');
  L.push("");
  L.push("export interface WhiteboxMenuTool {");
  L.push("  /** Tool id, passed to ProcessingDialog to preselect the tool. */");
  L.push("  id: string;");
  L.push("  /** Human-readable tool name from the catalog. */");
  L.push("  name: string;");
  L.push("}");
  L.push("");
  L.push("export interface WhiteboxMenuSubcategory {");
  L.push("  /** Subcategory label (catalog data, not translated). */");
  L.push("  label: string;");
  L.push("  tools: WhiteboxMenuTool[];");
  L.push("}");
  L.push("");
  L.push("export interface WhiteboxMenuCategory {");
  L.push("  /** Stable key for the top-level submenu. */");
  L.push("  key: string;");
  L.push("  /** i18n key for the submenu label. */");
  L.push("  labelKey: ParseKeys;");
  L.push("  subcategories: WhiteboxMenuSubcategory[];");
  L.push("}");
  L.push("");
  L.push(`/** ${total} tools across ${cats.length} categories. */`);
  L.push("export const WHITEBOX_MENU_CATALOG: WhiteboxMenuCategory[] = [");
  for (const c of cats) {
    L.push("  {");
    L.push(`    key: "${c.key}",`);
    L.push(`    labelKey: "${c.labelKey}",`);
    L.push("    subcategories: [");
    for (const s of c.subcategories) {
      L.push("      {");
      L.push(`        label: "${esc(s.label)}",`);
      L.push("        tools: [");
      for (const t of s.tools) {
        L.push(`          { id: "${esc(t.id)}", name: "${esc(t.name)}" },`);
      }
      L.push("        ],");
      L.push("      },");
    }
    L.push("    ],");
    L.push("  },");
  }
  L.push("];");
  L.push("");

  writeFileSync(OUT, L.join("\n"));
  console.log(`Wrote ${OUT} (${total} tools across ${cats.length} categories).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
