// Run the semantic rule in a separate process so ESLint need not retain every
// workspace's TypeScript program. ESLint still owns syntax and custom rules.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OXLINT = path.join(ROOT, "node_modules/oxlint/bin/oxlint");

/** Stale typed suppressions are fatal independently of the warning budget. */
function isErrorDiagnostic(item) {
  return (
    item.severity === "error" || /^Unused (?:oxlint|eslint)-disable directive\b/.test(item.message)
  );
}

/** Leave ESLint's own directives to ESLint; keep every Oxlint diagnostic. */
export function typedDiagnostics(diagnostics, readSource = readFileSync) {
  const sources = new Map();
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.code || !/^Unused eslint-disable directive\b/.test(diagnostic.message))
      return true;
    const span = diagnostic.labels?.[0]?.span;
    if (!span || !diagnostic.filename) return true;
    if (!sources.has(diagnostic.filename))
      sources.set(diagnostic.filename, readSource(diagnostic.filename));
    // Oxlint offsets are UTF-8 bytes, not JavaScript string offsets.
    const comment = sources
      .get(diagnostic.filename)
      .subarray(span.offset, span.offset + span.length)
      .toString("utf8");
    return !/^(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?(?:\s|$)/.test(comment);
  });
}

/** Match the existing typed source roots without scanning vendored Tauri configs. */
export function typedSourceRoots(cwd) {
  const roots = ["apps/geolibre-desktop/src"];
  for (const group of ["packages", "workers"]) {
    for (const entry of readdirSync(path.join(cwd, group), { withFileTypes: true })) {
      const source = `${group}/${entry.name}/src`;
      if (entry.isDirectory() && existsSync(path.join(cwd, source))) roots.push(source);
    }
  }
  return roots;
}

/** Execute the real typed engine, fail closed on process or protocol errors. */
export function runTypedLint({ cwd = ROOT, maxWarnings = 35 } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      OXLINT,
      "--type-aware",
      "--report-unused-disable-directives",
      "--format",
      "json",
      ...typedSourceRoots(cwd),
    ],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Oxlint terminated by ${result.signal}`);
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(result.stderr || result.stdout || `Oxlint exited ${result.status}`);
  }
  if (!Array.isArray(report.diagnostics)) throw new Error("Oxlint did not return diagnostics");
  const diagnostics = typedDiagnostics(
    report.diagnostics.map((item) => ({ ...item, filename: path.resolve(cwd, item.filename) })),
  );
  // A stale typed suppression is always an error, even when warnings remain
  // below the budget. Other unused directives are checked by ESLint itself.
  const errors = diagnostics.filter(isErrorDiagnostic).length;
  const warnings = diagnostics.length - errors;
  return {
    diagnostics,
    errors,
    warnings,
    exitStatus: result.status,
    ok: result.status === 0 && errors === 0 && warnings <= maxWarnings,
  };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--max-warnings" || !/^\d+$/.test(args[1]))
      throw new Error("Usage: node scripts/lint-typed.mjs --max-warnings N");
    const limit = Number(args[1]);
    const report = runTypedLint({ maxWarnings: limit });
    for (const item of report.diagnostics) {
      const span = item.labels?.[0]?.span;
      const severity = isErrorDiagnostic(item) ? "error" : item.severity;
      console.log(
        `${path.relative(ROOT, item.filename)}:${span?.line ?? 0}:${span?.column ?? 0} ${severity}: ${item.message} ${item.code ?? ""}`,
      );
    }
    if (report.exitStatus !== 0 && report.errors === 0)
      console.error(`Oxlint exited with status ${report.exitStatus}.`);
    console.log(
      `Typed lint: ${report.errors} errors, ${report.warnings} warnings (limit ${limit}).`,
    );
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
