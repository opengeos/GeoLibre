// Fails when a dependency declared by both the desktop app and the plugins
// package carries different version ranges.
// Run with: npm run check:shared-deps
//
// `apps/geolibre-desktop` and `packages/plugins` both declare many of the same
// upstream packages (the maplibre-gl-* controls, deck.gl, Geoman, ...). When a
// bump moves only one of the two ranges, npm can no longer hoist a single copy
// and nests a second one under the workspace that disagrees: the app then
// bundles two versions, and hand-kept mirrors of upstream internals (see
// "Dependency bumps that need a manual check" in docs/maintenance.md) end up
// checked against one copy while the other one runs. Dependabot opens one PR per
// manifest, so this drift is easy to merge without noticing.
//
// Only ranges are compared, across `dependencies`, `devDependencies`,
// `peerDependencies` and `optionalDependencies` (a package declared in
// different sections still has to agree). `--json` prints the mismatches as
// JSON for tooling.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The manifests whose shared dependencies must agree. */
export const MANIFESTS = ["apps/geolibre-desktop/package.json", "packages/plugins/package.json"];

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Every dependency a manifest declares, with the range and the section it
 * comes from. A package listed in several sections keeps the first one in
 * `SECTIONS` order.
 *
 * @param {Record<string, unknown>} manifest - A parsed package.json.
 * @returns {Map<string, { range: string, section: string }>}
 */
export function declaredDependencies(manifest) {
  const declared = new Map();
  for (const section of SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!declared.has(name)) declared.set(name, { range: String(range), section });
    }
  }
  return declared;
}

/**
 * The dependencies two manifests both declare with different ranges.
 *
 * @param {Record<string, unknown>} a - The first parsed package.json.
 * @param {Record<string, unknown>} b - The second parsed package.json.
 * @returns {{ name: string, a: { range: string, section: string }, b: { range: string, section: string } }[]}
 *   Mismatches sorted by package name.
 */
export function findRangeMismatches(a, b) {
  const left = declaredDependencies(a);
  const right = declaredDependencies(b);
  const mismatches = [];
  for (const [name, entry] of left) {
    const other = right.get(name);
    if (other && other.range !== entry.range) mismatches.push({ name, a: entry, b: other });
  }
  return mismatches.sort((x, y) => x.name.localeCompare(y.name));
}

function main() {
  const [fileA, fileB] = MANIFESTS;
  const read = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
  const mismatches = findRangeMismatches(read(fileA), read(fileB));
  if (process.argv.includes("--json")) {
    // Stdout stays a single JSON document; the exit code carries pass/fail.
    console.log(JSON.stringify(mismatches, null, 2));
    if (mismatches.length > 0) process.exitCode = 1;
    return;
  }
  if (mismatches.length === 0) {
    console.log(
      `check-shared-deps: every dependency shared by ${fileA} and ${fileB} has the same range.`,
    );
    return;
  }
  console.error(
    `check-shared-deps: ${mismatches.length} shared dependenc${mismatches.length === 1 ? "y has" : "ies have"} different ranges:`,
  );
  for (const { name, a, b } of mismatches) {
    console.error(
      `  ${name}: ${a.range} (${fileA} ${a.section}) vs ${b.range} (${fileB} ${b.section})`,
    );
  }
  console.error(
    "Give both manifests the same range (and refresh package-lock.json), or npm nests a second copy. " +
      'See "Shared dependency ranges" in docs/maintenance.md.',
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
