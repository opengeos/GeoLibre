#!/usr/bin/env node
/**
 * Rewrite a workspace manifest into the form it should be published in.
 *
 * The monorepo consumes `@geolibre/core` and `@geolibre/map` straight from
 * TypeScript source: Vite, tsx and `tsc` all resolve `./src/index.ts` through
 * the package's own `exports`, so nothing has to be built before `npm run dev`,
 * `npm run test:frontend`, or a single `node --import tsx --test` run. npm
 * consumers need the built `dist` bundle instead.
 *
 * npm cannot express that split on its own. `publishConfig` only overrides npm
 * *config* (registry, access, tag) at publish time -- npm deliberately ignores
 * entry fields nested there, unlike pnpm and Yarn (npm/cli#7586). So the split
 * lives here: the manifest keeps the source entries that the repo needs, states
 * the published entries under `publishConfig`, and the publish workflow runs
 * this script to hoist them just before `npm publish`.
 *
 * It also pins `"*"` workspace dependencies to the exact version being
 * published. npm resolves `"*"` to the local workspace during development but
 * publishes it verbatim, which would let a consumer install any `@geolibre/core`
 * at all alongside a given `@geolibre/map`.
 *
 * Usage: node scripts/prepare-npm-package.mjs packages/map [...more]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Entry fields npm ignores inside `publishConfig` and that we hoist by hand. */
const HOISTED_FIELDS = ["main", "module", "types", "typings", "browser", "exports", "files"];

/**
 * @param {Record<string, unknown>} manifest Parsed `package.json`.
 * @param {(name: string) => string | undefined} workspaceVersion Version of a
 *   sibling workspace, or undefined when the name is not a workspace.
 * @returns {Record<string, unknown>} The manifest as it should be published.
 */
export function toPublishManifest(manifest, workspaceVersion = () => undefined) {
  const published = { ...manifest };
  const publishConfig = { ...(manifest.publishConfig ?? {}) };

  for (const field of HOISTED_FIELDS) {
    if (field in publishConfig) {
      published[field] = publishConfig[field];
      delete publishConfig[field];
    }
  }
  published.publishConfig = publishConfig;
  delete published.private;

  for (const kind of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest[kind];
    if (!deps) continue;
    const pinned = { ...deps };
    for (const [name, range] of Object.entries(deps)) {
      if (range !== "*") continue;
      const version = workspaceVersion(name);
      if (version) pinned[name] = `^${version}`;
    }
    published[kind] = pinned;
  }

  return published;
}

function main(dirs) {
  if (dirs.length === 0) {
    console.error("usage: node scripts/prepare-npm-package.mjs <package-dir> [...]");
    process.exit(1);
  }

  const manifests = new Map(
    dirs.map((dir) => {
      const file = path.join(dir, "package.json");
      return [dir, JSON.parse(readFileSync(file, "utf8"))];
    }),
  );
  const versions = new Map(
    [...manifests.values()].map((manifest) => [manifest.name, manifest.version]),
  );

  for (const [dir, manifest] of manifests) {
    const published = toPublishManifest(manifest, (name) => versions.get(name));
    writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
    console.log(`prepared ${manifest.name}@${manifest.version} for publishing (${dir})`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2));
}
