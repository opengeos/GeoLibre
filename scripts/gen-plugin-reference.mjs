#!/usr/bin/env node
// Regenerate the built-in plugin reference table in docs/user-guide/plugins.md,
// between the <!-- plugin-reference:start/end --> markers.
//
// The plugin list, ids, and order come from the registry itself:
//
// - BUILT_IN_PLUGINS in apps/geolibre-desktop/src/hooks/usePlugins.ts names
//   every registered plugin object, in Plugins-menu order;
// - each object's `id` and `name` are read from its definition under
//   packages/plugins/src (object literal or factory call);
// - the display name is the English catalog entry toolbar.plugin.<id>, falling
//   back to the registered name, exactly as pluginDisplayName() resolves it;
// - the menu location follows PluginsMenu.tsx: WEB_SERVICE_PLUGIN_IDS and
//   DGGS_PLUGIN_IDS become submenus, and the ids PluginsMenu skips live
//   elsewhere (each needs a `menu` entry in scripts/plugin-reference.json);
// - the ?plugin= link name follows plugin-deep-link.ts; the consent-gated
//   plugins (CONSENT_GATED_PLUGIN_IDS) have none.
//
// Only the one-line description (and an optional menu override or docs link)
// is hand-written, in scripts/plugin-reference.json, keyed by plugin id. The
// generator fails when a registered plugin has no entry or an entry names a
// plugin that is no longer registered.
//
// Usage: node scripts/gen-plugin-reference.mjs          # rewrite plugins.md
//        node scripts/gen-plugin-reference.mjs --check  # exit 1 if it is stale

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_DOC_PATH = join(root, "docs/user-guide/plugins.md");
export const REFERENCE_START = "<!-- plugin-reference:start -->";
export const REFERENCE_END = "<!-- plugin-reference:end -->";

const USE_PLUGINS_PATH = join(root, "apps/geolibre-desktop/src/hooks/usePlugins.ts");
const PLUGINS_MENU_PATH = join(
  root,
  "apps/geolibre-desktop/src/components/layout/toolbar/PluginsMenu.tsx",
);
const EN_CATALOG_PATH = join(root, "apps/geolibre-desktop/src/i18n/locales/en.json");
const DESCRIPTIONS_PATH = join(root, "scripts/plugin-reference.json");
const PLUGINS_SRC = join(root, "packages/plugins/src");

/** Id prefixes a `?plugin=` short name may omit, longest first (plugin-deep-link.ts). */
const SHORT_NAME_PREFIXES = ["maplibre-gl-", "maplibre-", "geolibre-"];

/**
 * Lists every TypeScript source file under a directory.
 *
 * @param {string} dir - Directory to walk.
 * @returns {string[]} Absolute file paths.
 */
function listSources(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...listSources(path));
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

/**
 * Reads the plugins package sources once.
 *
 * @returns {{ path: string, text: string }[]} Every source file and its text.
 */
function loadPluginSources() {
  return listSources(PLUGINS_SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/**
 * Resolves a string constant (`export const FOO_PLUGIN_ID = "..."`) defined
 * anywhere in the plugins package.
 *
 * @param {{ path: string, text: string }[]} sources - Plugins package sources.
 * @param {string} name - Constant name.
 * @returns {string} The constant's string value.
 */
function resolveConstant(sources, name) {
  const re = new RegExp(`const ${name}\\b[^=]*=\\s*"([^"]+)"`);
  for (const { text } of sources) {
    const match = text.match(re);
    if (match) return match[1];
  }
  throw new Error(`Cannot resolve the string constant ${name} in packages/plugins/src`);
}

/**
 * Turns an expression that is either a string literal or a constant name into
 * its string value.
 *
 * @param {{ path: string, text: string }[]} sources - Plugins package sources.
 * @param {string} expr - The source expression.
 * @returns {string} The resolved value.
 */
function resolveValue(sources, expr) {
  const trimmed = expr.trim();
  const literal = trimmed.match(/^"([^"]*)"$/) ?? trimmed.match(/^'([^']*)'$/);
  if (literal) return literal[1];
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return resolveConstant(sources, trimmed);
  throw new Error(`Cannot resolve plugin metadata expression: ${trimmed}`);
}

/**
 * Resolves the id and registered name of one exported plugin object.
 *
 * Handles the definition shapes the plugins package uses: an object literal,
 * `createXPlugin({ id, name, ... })`, `createXPlugin(ID, "Name", ...)`,
 * `factoryResult.plugin`, and a no-argument factory whose body returns the
 * object literal.
 *
 * @param {{ path: string, text: string }[]} sources - Plugins package sources.
 * @param {string} ident - The exported identifier, e.g. `maplibreSwipePlugin`.
 * @returns {{ id: string, name: string, file: string }} The plugin metadata.
 */
function resolvePlugin(sources, ident) {
  const defRe = new RegExp(`export const ${ident}\\b[^=]*=\\s*`);
  for (const { path, text } of sources) {
    const def = defRe.exec(text);
    if (!def) continue;
    const rhsStart = def.index + def[0].length;
    const rhs = text.slice(rhsStart, rhsStart + 200);
    let anchor = rhsStart;
    const member = rhs.match(/^([A-Za-z0-9_]+)\.plugin\s*;/);
    const noArgFactory = rhs.match(/^([A-Za-z0-9_]+)\(\)\s*;/);
    const positional = rhs.match(/^[A-Za-z0-9_]+\(\s*([A-Z0-9_]+|"[^"]*")\s*,\s*("[^"]*")/);
    if (positional) {
      return {
        id: resolveValue(sources, positional[1]),
        name: resolveValue(sources, positional[2]),
        file: path,
      };
    }
    if (member) {
      const at = text.search(new RegExp(`const ${member[1]}\\s*=`));
      if (at < 0) throw new Error(`${ident}: cannot find const ${member[1]}`);
      anchor = at;
    } else if (noArgFactory) {
      const at = text.search(new RegExp(`function ${noArgFactory[1]}\\s*\\(`));
      if (at < 0) throw new Error(`${ident}: cannot find function ${noArgFactory[1]}`);
      anchor = at;
    }
    const body = text.slice(anchor);
    const id = body.match(/\n\s+id:\s*([^,\n]+),/);
    const name = body.match(/\n\s+name:\s*([^,\n]+),/);
    if (!id || !name) throw new Error(`${ident}: cannot find id/name in ${path}`);
    return {
      id: resolveValue(sources, id[1]),
      name: resolveValue(sources, name[1]),
      file: path,
    };
  }
  throw new Error(`Cannot find the definition of ${ident} in packages/plugins/src`);
}

/**
 * Reads the items of an exported array of ids (`export const X = [...]`).
 *
 * @param {{ path: string, text: string }[]} sources - Plugins package sources.
 * @param {string} name - The array's name.
 * @returns {string[]} The resolved ids.
 */
function resolveIdArray(sources, name) {
  const re = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`);
  for (const { text } of sources) {
    const match = text.match(re);
    if (!match) continue;
    return match[1]
      .split(",")
      .map((item) => item.replace(/\/\/.*$/gm, "").trim())
      .filter(Boolean)
      .map((item) => resolveValue(sources, item));
  }
  throw new Error(`Cannot find the id array ${name} in packages/plugins/src`);
}

/**
 * The `?plugin=` link name for each allowed id: the short name when it
 * resolves to that plugin alone, otherwise the full id. Mirrors
 * pluginDeepLinkNames() in plugin-deep-link.ts.
 *
 * @param {string[]} ids - The deep-linkable plugin ids.
 * @returns {Map<string, string>} Link name per id.
 */
function deepLinkNames(ids) {
  const shortName = (id) => {
    for (const prefix of SHORT_NAME_PREFIXES) {
      if (id.startsWith(prefix) && id.length > prefix.length) {
        return id.slice(prefix.length).toLowerCase();
      }
    }
    return null;
  };
  const owners = new Map();
  for (const id of ids) {
    const short = shortName(id);
    if (short) owners.set(short, owners.has(short) ? null : id);
  }
  return new Map(
    ids.map((id) => {
      const short = shortName(id);
      return [id, short && owners.get(short) === id ? short : id];
    }),
  );
}

/**
 * Collects every registered built-in plugin with the metadata the reference
 * table shows.
 *
 * @returns {{ id: string, name: string, menu: string, linkName: string | null,
 *   description: string, docs?: string }[]} One entry per plugin, in registry order.
 */
export function collectBuiltInPlugins() {
  const sources = loadPluginSources();
  const usePlugins = readFileSync(USE_PLUGINS_PATH, "utf8");
  const start = usePlugins.indexOf("const BUILT_IN_PLUGINS");
  const end = usePlugins.indexOf("];", start);
  if (start < 0 || end < 0) throw new Error("Cannot find BUILT_IN_PLUGINS in usePlugins.ts");
  const idents = [...usePlugins.slice(start, end).matchAll(/^\s+([A-Za-z0-9_]+),\s*$/gm)].map(
    (match) => match[1],
  );
  if (idents.length === 0) throw new Error("BUILT_IN_PLUGINS parsed as empty");

  const gatedBlock = usePlugins.match(/CONSENT_GATED_PLUGIN_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!gatedBlock) throw new Error("Cannot find CONSENT_GATED_PLUGIN_IDS in usePlugins.ts");
  const gated = new Set(
    gatedBlock[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => resolveValue(sources, item)),
  );

  const menuSource = readFileSync(PLUGINS_MENU_PATH, "utf8");
  const skipped = new Set(
    [...menuSource.matchAll(/p\.id === ([A-Z][A-Z0-9_]*)/g)].map((m) =>
      resolveConstant(sources, m[1]),
    ),
  );
  const webServices = new Set(resolveIdArray(sources, "WEB_SERVICE_PLUGIN_IDS"));
  const dggs = new Set(resolveIdArray(sources, "DGGS_PLUGIN_IDS"));

  const catalogNames = JSON.parse(readFileSync(EN_CATALOG_PATH, "utf8")).toolbar?.plugin ?? {};
  const descriptions = JSON.parse(readFileSync(DESCRIPTIONS_PATH, "utf8"));

  const plugins = idents.map((ident) => resolvePlugin(sources, ident));
  const ids = plugins.map((plugin) => plugin.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Plugin id ${duplicate} is registered twice`);
  const links = deepLinkNames(ids.filter((id) => !gated.has(id)));

  const problems = [];
  for (const id of Object.keys(descriptions)) {
    if (!ids.includes(id)) problems.push(`${id}: in plugin-reference.json but not registered`);
  }
  const rows = plugins.map(({ id, name }) => {
    const entry = descriptions[id];
    if (!entry?.description) {
      problems.push(`${id}: add a description to scripts/plugin-reference.json`);
      return null;
    }
    let menu = entry.menu;
    if (!menu) {
      if (skipped.has(id)) {
        problems.push(`${id}: PluginsMenu hides it, so plugin-reference.json needs a "menu"`);
      } else if (webServices.has(id)) menu = "Plugins → Web Services";
      else if (dggs.has(id)) menu = "Plugins → DGGS";
      else menu = "Plugins";
    }
    return {
      id,
      name: catalogNames[id] || name,
      menu,
      linkName: links.get(id) ?? null,
      description: entry.description,
      ...(entry.docs ? { docs: entry.docs } : {}),
    };
  });
  if (problems.length > 0)
    throw new Error(`Plugin reference is incomplete:\n  ${problems.join("\n  ")}`);
  return rows;
}

/**
 * Escapes a value for a Markdown table cell.
 *
 * @param {string} text - Cell text.
 * @returns {string} The escaped text.
 */
const cell = (text) => text.replace(/\|/g, "\\|");

/**
 * Renders the generated region (markers included).
 *
 * @param {ReturnType<typeof collectBuiltInPlugins>} plugins - Plugin rows.
 * @returns {string} The Markdown region.
 */
export function renderReference(plugins) {
  const lines = [
    REFERENCE_START,
    "<!-- Generated by scripts/gen-plugin-reference.mjs from the plugin registry and",
    "     scripts/plugin-reference.json. Do not edit by hand: run `npm run plugins:docs`. -->",
    "",
    `GeoLibre registers ${plugins.length} built-in plugins.`,
    "",
    "| Plugin | Where | Link name | What it adds |",
    "| --- | --- | --- | --- |",
  ];
  for (const plugin of plugins) {
    const link = plugin.linkName ? `\`${plugin.linkName}\`` : "menu only";
    const docs = plugin.docs ? ` See [${cell(plugin.name)}](${plugin.docs}).` : "";
    lines.push(
      `| **${cell(plugin.name)}** | ${cell(plugin.menu)} | ${link} | ` +
        `${cell(plugin.description)}${docs} |`,
    );
  }
  lines.push(REFERENCE_END);
  return lines.join("\n");
}

/**
 * Returns plugins.md with its generated region replaced.
 *
 * @param {string} doc - Current plugins.md text.
 * @param {string} region - Rendered region.
 * @returns {string} The updated document.
 */
export function replaceRegion(doc, region) {
  const start = doc.indexOf(REFERENCE_START);
  const end = doc.indexOf(REFERENCE_END);
  if (start < 0 || end < start) {
    throw new Error(
      `${PLUGIN_DOC_PATH} is missing the ${REFERENCE_START} / ${REFERENCE_END} markers`,
    );
  }
  return doc.slice(0, start) + region + doc.slice(end + REFERENCE_END.length);
}

/**
 * Builds the expected plugins.md text from the current registry.
 *
 * @returns {{ current: string, expected: string }} Committed and regenerated text.
 */
export function buildPluginDoc() {
  const current = readFileSync(PLUGIN_DOC_PATH, "utf8");
  return { current, expected: replaceRegion(current, renderReference(collectBuiltInPlugins())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { current, expected } = buildPluginDoc();
  if (process.argv.includes("--check")) {
    if (current !== expected) {
      console.error(
        "docs/user-guide/plugins.md is out of date with the plugin registry. " +
          "Run `npm run plugins:docs` and commit the result.",
      );
      process.exit(1);
    }
    console.log("Plugin reference is up to date.");
  } else if (current !== expected) {
    writeFileSync(PLUGIN_DOC_PATH, expected);
    console.log("Updated docs/user-guide/plugins.md.");
  } else {
    console.log("Plugin reference already up to date.");
  }
}
