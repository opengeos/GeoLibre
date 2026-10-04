// Ratchet for large frontend modules that no test loads.
// Run with: npm run check:untested-modules  (after `npm run test:frontend:coverage`)
//
// The frontend coverage floor only counts files a test actually imports, so a
// big module with no test at all is invisible to it rather than showing up as
// 0% (see "Coverage floors" in docs/maintenance.md). This script closes that
// gap. It reads the lcov report that `scripts/coverage-check.mjs` writes, which
// lists every file the suite loaded directly or transitively, and compares it
// with every source file under apps/*/src and packages/*/src.
//
// Every untested source file over THRESHOLD lines is either listed in
// scripts/untested-modules-baseline.json or fails the check. A baseline entry
// also fails once it grows more than GROWTH_ALLOWANCE lines past the count
// recorded for it. Removing entries is always allowed, and the script prints
// which ones can go (they gained a test, shrank under the threshold, or were
// deleted). `--prune` applies exactly those removals and lowers the recorded
// count of entries that shrank; it never adds an entry or raises a count.
//
// Backend modules are reported, not gated: the script lists sidecar modules
// with no test file named after them.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Untested source files longer than this many lines are tracked. */
export const THRESHOLD = 500;

/** How far past its recorded line count a baseline entry may grow. */
export const GROWTH_ALLOWANCE = 50;

export const LCOV_PATH = "coverage/frontend.lcov";
export const BASELINE_PATH = "scripts/untested-modules-baseline.json";

const SOURCE_ROOTS = ["apps", "packages"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const BACKEND_PACKAGE = "backend/geolibre_server/geolibre_server";
const BACKEND_TESTS = "backend/geolibre_server/tests";

/**
 * Files that never count, whatever their size. Generated files are also caught
 * by their header (see {@link isGeneratedSource}); list one here only when it
 * carries no marker.
 */
const EXCLUDED_FILES = new Set([
  // Regenerated from the Whitebox catalog snapshot; data, not logic.
  "apps/geolibre-desktop/src/lib/whitebox-menu-catalog.ts",
]);

/**
 * Whether a repo-relative source path is out of scope regardless of content:
 * declaration files, index barrels, locale catalogs, and test files that live
 * beside their source.
 *
 * @param {string} file Repo-relative POSIX path.
 * @returns {boolean}
 */
export function isExcludedPath(file) {
  const base = path.posix.basename(file);
  if (EXCLUDED_FILES.has(file)) return true;
  if (base.endsWith(".d.ts")) return true;
  if (/^index\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/\.(test|spec|stories)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (file.includes("/i18n/locales/") || file.includes("/generated/")) return true;
  return false;
}

/**
 * Whether a file declares itself generated in its first few lines
 * (`AUTO-GENERATED`, `@generated`, or `DO NOT EDIT`).
 *
 * @param {string} text File contents.
 * @returns {boolean}
 */
export function isGeneratedSource(text) {
  const head = text.split("\n", 10).join("\n");
  return /AUTO-GENERATED|@generated|DO NOT EDIT/.test(head);
}

/**
 * Line count as `wc -l` would report it for a file with a trailing newline.
 *
 * @param {string} text File contents.
 * @returns {number}
 */
export function countLines(text) {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/**
 * The set of files an lcov report covers, as repo-relative POSIX paths.
 *
 * @param {string} lcov lcov report text.
 * @param {string} root Absolute repo root, used to relativize absolute `SF:` paths.
 * @returns {Set<string>}
 */
export function parseLcovFiles(lcov, root) {
  const files = new Set();
  for (const line of lcov.split(/\r?\n/)) {
    if (!line.startsWith("SF:")) continue;
    let file = line.slice(3).trim();
    if (path.isAbsolute(file)) file = path.relative(root, file);
    files.add(file.split(path.sep).join("/"));
  }
  return files;
}

/**
 * Compare the current untested large modules with the committed baseline.
 *
 * @param {object} options
 * @param {Record<string, number>} options.untested Untested, in-scope source
 *   files over the threshold, mapped to their line counts.
 * @param {Record<string, number>} options.baseline The committed baseline,
 *   mapping each tracked file to its recorded line count.
 * @param {Set<string>} options.tested Files the coverage run loaded.
 * @param {Record<string, number>} options.sizes Line counts of every in-scope
 *   source file that exists now (tested or not).
 * @param {number} [options.threshold] Line count above which a file is tracked.
 * @param {number} [options.growthAllowance] Lines a baseline entry may grow.
 * @returns {{
 *   added: Array<{file: string, lines: number}>,
 *   grown: Array<{file: string, lines: number, recorded: number}>,
 *   removable: Array<{file: string, reason: "tested" | "small" | "deleted"}>,
 *   shrunk: Array<{file: string, lines: number, recorded: number}>,
 *   ok: boolean,
 * }}
 */
export function compareToBaseline({
  untested,
  baseline,
  tested,
  sizes,
  threshold = THRESHOLD,
  growthAllowance = GROWTH_ALLOWANCE,
}) {
  const added = [];
  const grown = [];
  const removable = [];
  const shrunk = [];

  for (const [file, lines] of Object.entries(untested).sort()) {
    if (lines <= threshold) continue;
    const recorded = baseline[file];
    if (recorded === undefined) {
      added.push({ file, lines });
    } else if (lines > recorded + growthAllowance) {
      grown.push({ file, lines, recorded });
    } else if (lines < recorded) {
      shrunk.push({ file, lines, recorded });
    }
  }

  for (const file of Object.keys(baseline).sort()) {
    if (!(file in sizes)) removable.push({ file, reason: "deleted" });
    else if (tested.has(file)) removable.push({ file, reason: "tested" });
    else if (sizes[file] <= threshold) removable.push({ file, reason: "small" });
  }

  return { added, grown, removable, shrunk, ok: added.length === 0 && grown.length === 0 };
}

/**
 * The baseline after dropping removable entries and lowering shrunk counts.
 * Never adds an entry or raises a count.
 *
 * @param {Record<string, number>} baseline
 * @param {ReturnType<typeof compareToBaseline>} result
 * @returns {Record<string, number>}
 */
export function prunedBaseline(baseline, result) {
  const next = { ...baseline };
  for (const { file } of result.removable) delete next[file];
  for (const { file, lines } of result.shrunk) next[file] = lines;
  return sortKeys(next);
}

/**
 * Backend modules with no test file named after them: `foo.py` counts as
 * covered by `test_foo.py` or `test_foo_*.py`. Each test file is credited to
 * the longest module name it matches, so `test_vector_io.py` covers
 * `vector_io.py` and not `vector.py`. Modules that share a basename in
 * different directories are matched together, since a test file name cannot
 * tell them apart. A report, not a gate.
 *
 * @param {string[]} modules Module paths ending in `.py`.
 * @param {string[]} testFiles Test file basenames.
 * @returns {string[]} The module paths no test file is credited to.
 */
export function backendModulesWithoutTests(modules, testFiles) {
  const names = [...new Set(modules.map((file) => path.posix.basename(file, ".py")))];
  const covered = new Set();
  for (const testFile of testFiles) {
    if (!testFile.startsWith("test_") || !testFile.endsWith(".py")) continue;
    const stem = testFile.slice("test_".length, -".py".length);
    const owner = names
      .filter((name) => stem === name || stem.startsWith(`${name}_`))
      .sort((a, b) => b.length - a.length)[0];
    if (owner) covered.add(owner);
  }
  return modules.filter((file) => !covered.has(path.posix.basename(file, ".py")));
}

/**
 * A copy of a record with its keys in sorted order, for stable JSON output.
 *
 * @param {Record<string, number>} record
 * @returns {Record<string, number>}
 */
function sortKeys(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Every file under a directory, skipping `node_modules` and dot entries.
 *
 * @param {string} dir Directory to walk.
 * @param {string[]} out Accumulator the paths are pushed onto.
 * @returns {string[]} `out`.
 */
function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * In-scope frontend source files with their line counts.
 *
 * @param {string} root Absolute repo root.
 * @returns {Record<string, number>}
 */
function collectSources(root) {
  const sizes = {};
  for (const top of SOURCE_ROOTS) {
    const topDir = path.join(root, top);
    if (!existsSync(topDir)) continue;
    for (const workspace of readdirSync(topDir)) {
      const srcDir = path.join(topDir, workspace, "src");
      if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
      for (const full of walk(srcDir, [])) {
        const file = path.relative(root, full).split(path.sep).join("/");
        if (!SOURCE_EXTENSIONS.has(path.extname(file)) || isExcludedPath(file)) continue;
        const text = readFileSync(full, "utf8");
        if (isGeneratedSource(text)) continue;
        sizes[file] = countLines(text);
      }
    }
  }
  return sizes;
}

/**
 * Repo-relative paths of backend sidecar modules with no test named after them.
 *
 * @param {string} root Absolute repo root.
 * @returns {string[]}
 */
function backendReport(root) {
  const pkgDir = path.join(root, BACKEND_PACKAGE);
  const testDir = path.join(root, BACKEND_TESTS);
  if (!existsSync(pkgDir) || !existsSync(testDir)) return [];
  const modules = walk(pkgDir, [])
    .filter((full) => full.endsWith(".py") && path.basename(full) !== "__init__.py")
    .map((full) => path.relative(root, full).split(path.sep).join("/"))
    .sort();
  return backendModulesWithoutTests(modules, readdirSync(testDir));
}

/**
 * Run the check.
 *
 * @param {string[]} argv Command-line flags (`--prune`, `--write-baseline`).
 * @returns {number} The process exit code.
 */
function main(argv) {
  const root = process.cwd();
  const prune = argv.includes("--prune");
  const writeBaseline = argv.includes("--write-baseline");

  const lcovFile = path.join(root, LCOV_PATH);
  if (!existsSync(lcovFile)) {
    console.error(
      `check-untested-modules: ${LCOV_PATH} not found. Run \`npm run test:frontend:coverage\` first; ` +
        "it writes the report this check reads.",
    );
    return 1;
  }
  const tested = parseLcovFiles(readFileSync(lcovFile, "utf8"), root);
  const sizes = collectSources(root);
  const untested = Object.fromEntries(
    Object.entries(sizes).filter(([file, lines]) => lines > THRESHOLD && !tested.has(file)),
  );

  const baselineFile = path.join(root, BASELINE_PATH);
  if (writeBaseline) {
    writeFileSync(baselineFile, `${JSON.stringify(sortKeys(untested), null, 2)}\n`);
    console.log(
      `check-untested-modules: wrote ${Object.keys(untested).length} entries to ${BASELINE_PATH}.`,
    );
    return 0;
  }
  let baseline = {};
  if (existsSync(baselineFile)) {
    try {
      baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
    } catch (error) {
      console.error(
        `check-untested-modules: could not parse ${BASELINE_PATH}: ${error.message}. ` +
          "Fix the file (a leftover merge conflict?) or restore it from git.",
      );
      return 1;
    }
  }
  const result = compareToBaseline({ untested, baseline, tested, sizes });

  const tracked = Object.keys(untested).length;
  console.log(
    `check-untested-modules: ${tracked} source file(s) over ${THRESHOLD} lines are loaded by no ` +
      `test (${Object.keys(baseline).length} in the baseline).`,
  );

  for (const { file, lines } of result.added) {
    console.error(
      `  NEW  ${file} (${lines} lines) is over ${THRESHOLD} lines and no test loads it. ` +
        "Add a test that imports it (or a leaf module extracted from it).",
    );
  }
  for (const { file, lines, recorded } of result.grown) {
    console.error(
      `  GREW ${file}: ${recorded} -> ${lines} lines (allowance ${GROWTH_ALLOWANCE}) with still no ` +
        "test loading it. Add a test, or move the new code into a tested module.",
    );
  }

  if (prune) {
    const next = prunedBaseline(baseline, result);
    writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `check-untested-modules: pruned ${result.removable.length} entr(ies) and lowered ` +
        `${result.shrunk.length} count(s) in ${BASELINE_PATH}.`,
    );
  } else if (result.removable.length > 0 || result.shrunk.length > 0) {
    console.log(
      "check-untested-modules: the baseline can shrink. Run `npm run check:untested-modules -- --prune` " +
        "to apply:",
    );
    for (const { file, reason } of result.removable) {
      const why = {
        tested: "now loaded by a test",
        small: `now ${THRESHOLD} lines or fewer`,
        deleted: "no longer exists",
      }[reason];
      console.log(`  remove ${file} (${why})`);
    }
    for (const { file, lines, recorded } of result.shrunk) {
      console.log(`  lower  ${file} ${recorded} -> ${lines}`);
    }
  }

  const backend = backendReport(root);
  if (backend.length > 0) {
    console.log(
      `check-untested-modules: backend modules with no test_<module>.py (report only, not gated):`,
    );
    for (const file of backend) console.log(`  ${file}`);
  }

  if (!result.ok) {
    console.error(
      `\ncheck-untested-modules: failed. Renamed a baseline file? Move its entry in ${BASELINE_PATH} ` +
        'to the new path. See "Untested module ratchet" in docs/maintenance.md.',
    );
    return 1;
  }
  return 0;
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
