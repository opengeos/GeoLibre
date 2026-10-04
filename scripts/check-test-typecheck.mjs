// Type-check ratchet for the frontend test suite.
// Run with: npm run typecheck:tests  (node scripts/check-test-typecheck.mjs --max-errors N)
//
// `node --import tsx --test` strips types without checking them, so a test
// fake that drifts from the interface it stands in for (a renamed property, a
// new required member, a changed argument) still runs and still passes. This
// gate runs `tsc --noEmit` over the tests/ projects and fails when the number
// of errors in test files rises above `--max-errors` (set in the root
// package.json script). The count can only go down, the same way the lint
// `--max-warnings` ratchet works; see "Test type-check ratchet" in
// docs/maintenance.md.
//
// There are three projects (tsconfig.json files carry no comments here because
// the check-json pre-commit hook parses them as strict JSON):
//
// - tests/tsconfig.json: every test, against the DOM lib plus the Node, React
//   and Vite types and the ambient .d.ts files the app and packages compile
//   with. `allowJs` lets tests import the scripts/*.mjs, eslint-rules/*.mjs and
//   extensions/*.mjs they cover with inferred types (checkJs stays off).
// - tests/tsconfig.workers.json: tests that import workers/tiles or
//   workers/viewer, against @cloudflare/workers-types like those workers. The
//   Workers runtime types redeclare the DOM globals (Request, Response,
//   caches, ...), so they cannot share a program with the DOM lib.
// - tests/tsconfig.ai-proxy.json: tests that import workers/ai-proxy, against
//   that worker's wrangler-generated worker-configuration.d.ts, which carries
//   its own copy of the runtime types and so cannot share a program with
//   @cloudflare/workers-types either.
//
// A worker test is listed in tests/tsconfig.json's "exclude" and in exactly one
// worker project; checkProjectSplit() fails the gate when the lists drift, so
// an excluded test can never silently go unchecked.
//
// Only diagnostics in files under tests/ count. A test that imports product
// source pulls that source into the tests' program, but the source is
// type-checked by its own workspace's tsconfig; an error it reports here comes
// from the tests' compiler settings (DOM-using @geolibre/core code under the
// Workers types, say), so it is listed for information and left out of the
// count.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** The tests/ type-check projects (see the header comment). */
export const PROJECTS = [
  "tests/tsconfig.json",
  "tests/tsconfig.workers.json",
  "tests/tsconfig.ai-proxy.json",
];

/**
 * Find tests that tests/tsconfig.json excludes but no worker project picks up.
 *
 * @param {{exclude?: string[]}} main The parsed tests/tsconfig.json.
 * @param {{files?: string[], include?: string[]}[]} workerProjects The parsed
 *   worker-runtime projects.
 * @returns {string[]} Exclude entries no worker project lists.
 */
export function checkProjectSplit(main, workerProjects) {
  const covered = new Set(
    workerProjects.flatMap((project) => [...(project.files ?? []), ...(project.include ?? [])]),
  );
  return (main.exclude ?? []).filter((entry) => entry !== "fixtures" && !covered.has(entry));
}

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * Parse `tsc --pretty false` output into error diagnostics. Continuation lines
 * (the indented elaboration under an assignability error) belong to the
 * diagnostic above them and are not counted separately.
 *
 * @param {string} output The combined stdout/stderr of one tsc run.
 * @returns {{file: string, line: number, column: number, code: string, message: string}[]}
 */
export function parseDiagnostics(output) {
  const diagnostics = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC.exec(raw);
    if (!match) continue;
    const [, file, line, column, code, message] = match;
    diagnostics.push({
      file: file.replaceAll("\\", "/"),
      line: Number(line),
      column: Number(column),
      code,
      message,
    });
  }
  return diagnostics;
}

/**
 * Whether a diagnostic's file is part of the test suite (and so counts toward
 * the ratchet). tsc reports paths relative to the working directory.
 *
 * @param {string} file A diagnostic's file path.
 * @returns {boolean}
 */
export function isTestFile(file) {
  return file.startsWith("tests/");
}

/**
 * Decide the gate's outcome from the counted error total and the limit.
 *
 * @param {number} count Errors in test files across every project.
 * @param {number} max The committed baseline (`--max-errors`).
 * @returns {{ok: boolean, message: string}}
 */
export function judge(count, max) {
  if (count > max) {
    return {
      ok: false,
      message:
        `Test type check: ${count} errors, above the limit of ${max}. ` +
        "Fix the new errors rather than raising the limit " +
        '(docs/maintenance.md, "Test type-check ratchet").',
    };
  }
  if (count < max) {
    return {
      ok: true,
      message:
        `Test type check: ${count} errors, under the limit of ${max}. ` +
        `Lower --max-errors in the root package.json to ${count} to keep the gain.`,
    };
  }
  return { ok: true, message: `Test type check: ${count} errors (limit ${max}).` };
}

/**
 * Run `tsc --noEmit -p <project>` and collect its output.
 *
 * @param {string} project Path to a tsconfig.json.
 * @returns {Promise<{project: string, status: number | null, output: string}>}
 */
function runTsc(project) {
  const tsc = require.resolve("typescript/bin/tsc");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", project], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ project, status, output }));
  });
}

/**
 * Read `--max-errors N` from the command line.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {number}
 */
function parseMaxErrors(argv) {
  const index = argv.indexOf("--max-errors");
  const value = index === -1 ? undefined : Number(argv[index + 1]);
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error("usage: node scripts/check-test-typecheck.mjs --max-errors <N>");
  }
  return value;
}

/** Tally items by a key, most frequent first. */
function tally(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function main() {
  const max = parseMaxErrors(process.argv.slice(2));
  const verbose = process.argv.includes("--verbose");
  const [mainProject, ...workerProjects] = PROJECTS.map((project) =>
    JSON.parse(readFileSync(project, "utf8")),
  );
  const unchecked = checkProjectSplit(mainProject, workerProjects);
  if (unchecked.length > 0) {
    throw new Error(
      `tests/tsconfig.json excludes ${unchecked.join(", ")} but no worker project ` +
        "(tests/tsconfig.workers.json, tests/tsconfig.ai-proxy.json) lists it, so it would go unchecked",
    );
  }
  const runs = await Promise.all(PROJECTS.map(runTsc));

  const counted = [];
  for (const { project, status, output } of runs) {
    const diagnostics = parseDiagnostics(output);
    // tsc exits 1 or 2 when it reports diagnostics; any other failure (a bad
    // tsconfig, a crash) prints no parsable diagnostic and must not read as
    // "0 errors".
    if (status !== 0 && diagnostics.length === 0) {
      process.stderr.write(output);
      throw new Error(`tsc -p ${project} failed (exit ${status}) without reporting diagnostics`);
    }
    const tests = diagnostics.filter((d) => isTestFile(d.file));
    const others = diagnostics.filter((d) => !isTestFile(d.file));
    counted.push(...tests);
    console.log(`${project}: ${tests.length} errors in tests/`);
    if (others.length > 0) {
      console.log(
        `  (+${others.length} in imported source under these settings, not counted: ` +
          tally(others, (d) => d.file)
            .map(([file, n]) => `${file} ${n}`)
            .join(", ") +
          ")",
      );
    }
    if (verbose) {
      for (const d of tests)
        console.log(`  ${d.file}(${d.line},${d.column}): ${d.code} ${d.message}`);
    }
  }

  console.log(
    "By code: " +
      tally(counted, (d) => d.code)
        .map(([code, n]) => `${code} ${n}`)
        .join(", "),
  );
  const { ok, message } = judge(counted.length, max);
  if (!ok) {
    // Name the files so the new errors are easy to find; the full list is one
    // `npx tsc --noEmit -p tests/tsconfig.json` away.
    console.error(
      "By file: " +
        tally(counted, (d) => d.file)
          .map(([file, n]) => `${file} ${n}`)
          .join(", "),
    );
    console.error(message);
    process.exitCode = 1;
  } else {
    console.log(message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
