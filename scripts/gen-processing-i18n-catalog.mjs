#!/usr/bin/env node
// Regenerate the English baseline for GeoLibre's processing tool metadata in
// apps/geolibre-desktop/src/i18n/locales/en.json.
//
// Usage: node scripts/gen-processing-i18n-catalog.mjs
//        node scripts/gen-processing-i18n-catalog.mjs --check
//
// Tool names, descriptions, group labels, parameter labels/help text and select
// option labels live in `@geolibre/processing`, a package with no i18n access.
// The Processing dialogs render them through `lib/processing-tool-i18n.ts`,
// which resolves `processing.toolMeta.<catalog>.<toolId>.…` and falls back to
// the registry's own string. This script writes those registry strings into
// `en.json` so translators have a target: English is already correct without
// them (that is what the fallback is for), but a key absent from `en.json`
// cannot be added to any other locale — `tests/i18n-catalogs.test.ts` rejects a
// locale key with no English counterpart.
//
// So: after adding or renaming a tool, a parameter or a select option, re-run
// this and commit the result, or the new strings stay untranslatable. Drift is
// otherwise benign — the affected strings simply render in English.
//
// `--check` exits non-zero (without writing) when the catalog is out of date,
// for use in CI.
//
// Existing translations are never touched: only the `processing.toolMeta` and
// `processing.toolGroup` subtrees of en.json are rewritten, and the other
// locales are left alone.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  NETWORK_TOOLS,
  RASTER_TOOLS,
  STATISTICS_TOOLS,
  VECTOR_TOOLS,
} from "../packages/processing/src/index.ts";
import { toolGroupKey } from "../apps/geolibre-desktop/src/lib/processing-tool-i18n.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enPath = join(repoRoot, "apps/geolibre-desktop/src/i18n/locales/en.json");

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
};

/** Build the `processing.toolMeta` subtree from the registries. */
function buildToolMeta() {
  const meta = {};
  for (const [catalog, tools] of Object.entries(CATALOGS)) {
    const entries = {};
    for (const tool of tools) {
      const entry = { name: tool.name };
      if (tool.description) entry.description = tool.description;
      const params = {};
      for (const param of tool.parameters ?? []) {
        const paramEntry = { label: param.label };
        if (param.description) paramEntry.description = param.description;
        if (param.options?.length) {
          const options = {};
          for (const option of param.options) options[option.value] = option.label;
          paramEntry.options = options;
        }
        params[param.id] = paramEntry;
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
function buildToolGroups() {
  // Null-prototype: `toolGroupKey` can produce an inherited member name — a
  // group labelled "Constructor" slugs to `constructor` — and on a plain object
  // the collision lookup below would read `Object.prototype.constructor` and
  // throw on the very first tool in that group.
  const groups = Object.create(null);
  for (const tools of Object.values(CATALOGS)) {
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

const catalog = JSON.parse(readFileSync(enPath, "utf8"));
const before = JSON.stringify(catalog);
catalog.processing = {
  ...catalog.processing,
  toolMeta: buildToolMeta(),
  toolGroup: buildToolGroups(),
};
// Two-space indent + trailing newline: what the other catalogs use, and what
// the pre-commit JSON hooks expect.
const next = `${JSON.stringify(catalog, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(enPath, "utf8");
  if (current !== next) {
    console.error(
      "en.json's processing.toolMeta/toolGroup are out of date.\n" +
        "Run: node scripts/gen-processing-i18n-catalog.mjs",
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
