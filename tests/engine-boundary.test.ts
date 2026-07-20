import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import baseline from "./fixtures/engine-boundary-baseline.json" with { type: "json" };

interface BoundaryViolation {
  readonly path: string;
  readonly pattern: string;
}

const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set(["dist", "node_modules"]);
const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
const mapControllerPattern = /\b(?:import|export)\s+(?:type\s+)?([^;"']*?)\s+from\s+["']([^"']+)["']/g;

function isConcreteRenderer(specifier: string): boolean {
  if (specifier === "@maplibre/maplibre-gl-style-spec") return false;
  return (
    specifier === "maplibre-gl" ||
    specifier.startsWith("maplibre-gl-") ||
    specifier.startsWith("@deck.gl/") ||
    specifier === "three" ||
    specifier.startsWith("three/") ||
    specifier === "cesium" ||
    specifier.startsWith("cesium/")
  );
}

async function collectSourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(entryPath)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function scanFile(filePath: string, source: string, root: string): readonly BoundaryViolation[] {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  const violations = new Map<string, BoundaryViolation>();

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || !isConcreteRenderer(specifier)) continue;
    const violation = { path: relativePath, pattern: specifier };
    violations.set(`${violation.path}\0${violation.pattern}`, violation);
  }

  for (const match of source.matchAll(mapControllerPattern)) {
    const importedNames = match[1] ?? "";
    const specifier = match[2] ?? "";
    if (!/\bMapController\b/.test(importedNames)) continue;
    const violation = { path: relativePath, pattern: `${specifier}#MapController` };
    violations.set(`${violation.path}\0${violation.pattern}`, violation);
  }

  return [...violations.values()];
}

async function scanBoundary(root: string): Promise<readonly BoundaryViolation[]> {
  const scanRoots = [path.join(root, "apps"), path.join(root, "packages")];
  const files = (
    await Promise.all(scanRoots.map((directory) => collectSourceFiles(directory)))
  ).flat();
  const mapPackage = path.join(root, "packages", "map") + path.sep;
  const violations: BoundaryViolation[] = [];

  for (const filePath of files) {
    if (filePath.startsWith(mapPackage)) continue;
    const source = await readFile(filePath, "utf8");
    violations.push(...scanFile(filePath, source, root));
  }

  return violations.sort(
    (left, right) => left.path.localeCompare(right.path) || left.pattern.localeCompare(right.pattern),
  );
}

test("renderer imports outside @geolibre/map match the reviewed baseline", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const actual = await scanBoundary(root);

  if (process.env.PRINT_ENGINE_BOUNDARY_BASELINE === "1") {
    console.log(JSON.stringify(actual, null, 2));
    return;
  }

  assert.deepEqual(actual, baseline);
});
