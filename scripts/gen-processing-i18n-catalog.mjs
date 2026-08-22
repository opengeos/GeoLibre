#!/usr/bin/env node
// Regenerate the English baseline for processing tool metadata in
// apps/geolibre-desktop/src/i18n/locales/en.json.
//
// Usage: node --import tsx scripts/gen-processing-i18n-catalog.mjs
//        node --import tsx scripts/gen-processing-i18n-catalog.mjs --check
//
// Tool names, descriptions, group labels, Whitebox categories and menu labels,
// parameter labels/help text and select option labels live in registries and
// generated catalogs that have no i18n access. The Processing
// dialogs render them through `lib/processing-tool-i18n.ts`, which resolves
// `processing.toolMeta.<catalog>.<toolId>.…` and falls back to the registry's
// own string. This script writes those registry strings into `en.json` so
// translators have a target: English is already correct without them (that is
// what the fallback is for), but a key absent from `en.json` cannot be added to
// any other locale — `tests/i18n-catalogs.test.ts` rejects a locale key with no
// English counterpart.
//
// So: after adding or renaming a tool, a parameter or a select option, re-run
// this and commit the result, or the new strings stay untranslatable. Drift is
// otherwise benign — the affected strings simply render in English.
//
// `--check` exits non-zero (without writing) when the catalog is out of date,
// for use in CI.
//
// Existing translations are never touched: only the `processing.toolMeta`,
// `processing.toolGroup`, and translated Whitebox subtrees of en.json are
// rewritten, and the other locales are left alone.
//
// The Whitebox baseline is not the public snapshot alone. In local WASM mode
// Processing uses the binary's manifests for parameter names and appends
// WASM-only tools, so the translator baseline must follow that same merge.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  NETWORK_TOOLS,
  RASTER_TOOLS,
  STATISTICS_TOOLS,
  VECTOR_TOOLS,
} from "../packages/processing/src/index.ts";
import {
  humanizeParameterName,
  toolGroupKey,
  whiteboxMenuSubcategorySlug,
} from "../apps/geolibre-desktop/src/lib/processing-tool-i18n.ts";
import { WHITEBOX_MENU_CATALOG } from "../apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enPath = join(repoRoot, "apps/geolibre-desktop/src/i18n/locales/en.json");
const whiteboxSnapshotPath = join(
  repoRoot,
  "apps/geolibre-desktop/public/whitebox-catalog-snapshot.json",
);

const whiteboxSnapshot = JSON.parse(readFileSync(whiteboxSnapshotPath, "utf8"));

/** Read every manifest embedded in the local geolibre-wasm runner. */
async function loadWasmWhiteboxTools() {
  try {
    const { initTools, listManifests } = await import("geolibre-wasm/tools");
    const toolsUrl = import.meta.resolve("geolibre-wasm/tools");
    const wasmPath = join(dirname(fileURLToPath(toolsUrl)), "geolibre-cli.wasm");
    await initTools(readFileSync(wasmPath));
    const manifests = await listManifests();
    return manifests.map((manifest) => ({
      id: manifest.id,
      display_name: manifest.display_name,
      category: manifest.category,
      summary: manifest.summary,
      license_tier: manifest.license_tier,
      locked: Boolean(manifest.locked),
      params: (manifest.params ?? []).map((param) => ({
        name: param.name,
        description: param.description,
      })),
    }));
  } catch (error) {
    throw new Error(
      `Could not load geolibre-wasm manifests for the i18n baseline: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Match ProcessingDialog's local-mode metadata merge: the snapshot supplies
 * display metadata, while non-empty WASM manifests supply the parameters and
 * WASM-only tools are appended.
 */
function mergeWhiteboxBaseline(catalogTools, wasmTools) {
  const wasmById = new Map(wasmTools.map((tool) => [tool.id, tool]));
  const merged = catalogTools.map((tool) => {
    const wasm = wasmById.get(tool.id);
    if (!wasm) return tool;
    wasmById.delete(tool.id);
    return { ...tool, params: wasm.params?.length ? wasm.params : tool.params };
  });
  return [...merged, ...[...wasmById.values()].filter((tool) => !tool.locked)];
}

/** Build the `processing.toolMeta` subtree from the registries. */
function buildToolMeta(CATALOGS) {
  const meta = {};
  for (const [catalog, tools] of Object.entries(CATALOGS)) {
    const entries = {};
    for (const tool of tools) {
      const isWhitebox = catalog === "whitebox";
      const entry = {
        name: isWhitebox ? tool.display_name || humanizeParameterName(tool.id) : tool.name,
      };
      // Whitebox snapshot stores tool summaries in `summary`, not `description`.
      const desc = isWhitebox ? tool.summary || tool.description : tool.description;
      if (desc) entry.description = desc;
      const params = {};
      for (const param of isWhitebox ? (tool.params ?? []) : (tool.parameters ?? [])) {
        const paramEntry = { label: isWhitebox ? humanizeParameterName(param.name) : param.label };
        if (param.description) paramEntry.description = param.description;
        // Whitebox enum values are CLI values, not display labels owned by the
        // host; leave them verbatim in the dropdown.
        if (!isWhitebox && param.options?.length) {
          const options = {};
          for (const option of param.options) options[option.value] = option.label;
          paramEntry.options = options;
        }
        params[isWhitebox ? param.name : param.id] = paramEntry;
      }
      if (Object.keys(params).length > 0) entry.params = params;
      entries[tool.id] = entry;
    }
    meta[catalog] = entries;
  }
  return meta;
}

/**
 * Build the `processing.toolGroup` subtree. Group labels are free text shared
 * across catalogs ("Analysis" appears in more than one), so they collapse into
 * one namespace keyed by `toolGroupKey` and are translated once.
 */
function buildToolGroups(CATALOGS) {
  // Null-prototype: `toolGroupKey` can produce an inherited member name — a
  // group labelled "Constructor" slugs to `constructor` — and on a plain object
  // the collision lookup below would read `Object.prototype.constructor` and
  // throw on the very first tool in that group.
  const groups = Object.create(null);
  for (const [catalog, tools] of Object.entries(CATALOGS)) {
    // Whitebox categories are not routed through this shared namespace; see
    // translateModelToolGroup for the raw-label collision details.
    if (catalog === "whitebox") continue;
    for (const tool of tools) {
      if (!tool.group) continue;
      const key = toolGroupKey(tool.group);
      // `toolGroupKey` strips punctuation, so two distinct labels can slug to
      // the same key ("Sub Group" and "Sub-Group" both give `subGroup`). Left
      // unchecked, the second label would silently overwrite the first and both
      // headings would share one translation. Fail here instead: this is the
      // only place that sees every label at once, and `--check` runs in CI.
      if (groups[key] !== undefined && groups[key] !== tool.group) {
        throw new Error(
          `Group labels "${groups[key]}" and "${tool.group}" both map to the key ` +
            `"${key}". Rename one, or make toolGroupKey distinguish them.`,
        );
      }
      groups[key] = tool.group;
    }
  }
  // Sorted so the generated block has a stable order regardless of which
  // registry happened to mention a group first.
  // Back to a normal object for JSON.stringify.
  return Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)));
}

/** Build translate-once keys for raw Whitebox category strings. */
export function buildWhiteboxCategories(tools) {
  const categories = new Map();
  for (const tool of tools) {
    if (!tool.category) continue;
    const key = toolGroupKey(tool.category);
    // Whitebox categories are raw upstream strings, so punctuation/case can
    // make two labels slug onto one translation key. Fail rather than let the
    // later label silently replace the earlier one.
    if (categories.has(key) && categories.get(key) !== tool.category) {
      throw new Error(
        `Whitebox category labels "${categories.get(key)}" and "${tool.category}" both map ` +
          `to the key "${key}". Rename one, or make toolGroupKey distinguish them.`,
      );
    }
    categories.set(key, tool.category);
  }
  return Object.fromEntries([...categories.entries()].sort(([, a], [, b]) => a.localeCompare(b)));
}

/** Build the English baseline for labels rendered from the generated menu catalog. */
export function buildWhiteboxMenuTranslations(menuCatalog) {
  const menuTools = Object.create(null);
  const menuSubcategories = Object.create(null);
  for (const category of menuCatalog) {
    for (const subcategory of category.subcategories) {
      const key = whiteboxMenuSubcategorySlug(subcategory.label);
      if (menuSubcategories[key] !== undefined && menuSubcategories[key] !== subcategory.label) {
        throw new Error(
          `Whitebox menu subcategory labels "${menuSubcategories[key]}" and ` +
            `"${subcategory.label}" both map to the key "${key}".`,
        );
      }
      menuSubcategories[key] = subcategory.label;
      for (const tool of subcategory.tools) {
        if (menuTools[tool.id] !== undefined && menuTools[tool.id] !== tool.name) {
          throw new Error(
            `Whitebox menu tool id "${tool.id}" has conflicting names ` +
              `"${menuTools[tool.id]}" and "${tool.name}".`,
          );
        }
        menuTools[tool.id] = tool.name;
      }
    }
  }
  return {
    menuTool: Object.fromEntries(Object.entries(menuTools)),
    menuSubcategory: Object.fromEntries(Object.entries(menuSubcategories)),
  };
}

async function main() {
  const catalogTools = whiteboxSnapshot.tools.filter((tool) => !tool.locked);
  const wasmTools = await loadWasmWhiteboxTools();
  /**
   * Catalog name → tools, matching `ProcessingToolCatalog`. Tool ids are unique
   * within a registry but not across them (`reproject` is both a vector and a
   * raster tool), which is why the catalog name is part of every key.
   */
  const CATALOGS = {
    vector: VECTOR_TOOLS,
    network: NETWORK_TOOLS,
    statistics: STATISTICS_TOOLS,
    raster: RASTER_TOOLS,
    whitebox: mergeWhiteboxBaseline(catalogTools, wasmTools),
  };

  const catalog = JSON.parse(readFileSync(enPath, "utf8"));
  const before = JSON.stringify(catalog);
  const whiteboxMenu = buildWhiteboxMenuTranslations(WHITEBOX_MENU_CATALOG);
  catalog.processing = {
    ...catalog.processing,
    toolMeta: buildToolMeta(CATALOGS),
    toolGroup: buildToolGroups(CATALOGS),
    whitebox: {
      ...catalog.processing.whitebox,
      categories: buildWhiteboxCategories(CATALOGS.whitebox),
      menuTool: whiteboxMenu.menuTool,
      menuSubcategory: whiteboxMenu.menuSubcategory,
    },
  };
  // Two-space indent + trailing newline: what the other catalogs use, and what
  // the pre-commit JSON hooks expect.
  const next = `${JSON.stringify(catalog, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    const current = readFileSync(enPath, "utf8");
    if (current !== next) {
      console.error(
        "en.json's processing tool metadata is out of date.\n" +
          "Run: node --import tsx scripts/gen-processing-i18n-catalog.mjs",
      );
      process.exit(1);
    }
    console.log("en.json processing tool metadata is up to date.");
  } else {
    writeFileSync(enPath, next);
    const changed = before !== JSON.stringify(catalog);
    console.log(
      changed
        ? `Updated ${enPath} (${Object.keys(catalog.processing.toolMeta).length} catalogs).`
        : `${enPath} already up to date.`,
    );
  }
}

// Only generate when invoked directly, so tests can import the pure builders
// without loading WASM manifests or touching en.json.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
