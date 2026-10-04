import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared plumbing for `tests/upstream-contracts.test.ts`: locating the package
 * a workspace really loads and reading its published files as text.
 *
 * Some packages cannot be imported under Node (they touch `window` or WebGL at
 * module load), and some of what GeoLibre mirrors is a private field or a
 * string inside a function body that no export reaches. Those contracts are
 * asserted against the **published** files under `node_modules` instead.
 */

/** The repository root. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The installed directory of `name` as `workspace` resolves it: the
 * workspace's own nested copy first, then the hoisted root copy — the order
 * Node and Vite resolve in. A nested copy matters when a workspace pins a
 * different version than the root one (Geoman is nested under both
 * `packages/plugins` and `apps/geolibre-desktop`).
 *
 * @param name - The npm package name.
 * @param workspace - Repo-relative workspace directory that declares it.
 * @returns The absolute package directory.
 */
export function packageDir(name: string, workspace = "."): string {
  for (const base of [path.join(REPO_ROOT, workspace), REPO_ROOT]) {
    const dir = path.join(base, "node_modules", name);
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  throw new Error(`${name} is not installed (looked from ${workspace}); run npm install.`);
}

/**
 * The installed version of a package.
 *
 * @param name - The npm package name.
 * @param workspace - Repo-relative workspace directory that declares it.
 * @returns The `version` field of its `package.json`.
 */
export function packageVersion(name: string, workspace = "."): string {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDir(name, workspace), "package.json"), "utf8"),
  ) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Every published ESM JavaScript and CSS file directly inside a package's
 * build directory, concatenated. CommonJS twins (`.cjs`) and source maps are
 * skipped so a symbol is counted once. Chunk file names carry a content hash
 * that changes every release, which is why this reads the directory rather
 * than naming a file.
 *
 * @param name - The npm package name.
 * @param options - `workspace` to resolve from, `dir` inside the package (default `dist`).
 * @returns The concatenated file contents.
 */
export function readPublishedText(
  name: string,
  options: { workspace?: string; dir?: string } = {},
): string {
  const dir = path.join(packageDir(name, options.workspace), options.dir ?? "dist");
  return readdirSync(dir)
    .filter((file) => /\.(js|mjs|css)$/.test(file) && statSync(path.join(dir, file)).isFile())
    .sort()
    .map((file) => readFileSync(path.join(dir, file), "utf8"))
    .join("\n");
}

/**
 * Reads one published file of a package as text.
 *
 * @param name - The npm package name.
 * @param file - Path inside the package directory.
 * @param workspace - Repo-relative workspace to resolve from.
 * @returns The file contents.
 */
export function readPackageFile(name: string, file: string, workspace = "."): string {
  return readFileSync(path.join(packageDir(name, workspace), file), "utf8");
}

/**
 * Reads a repository file as text, for mirrors that live in a module a test
 * cannot cheaply import (a React component, a Vite plugin).
 *
 * @param relative - Repo-relative path.
 * @returns The file contents.
 */
export function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** Every docs/maintenance.md section a contract message has cited so far. */
export const citedSections = new Set<string>();

/**
 * The failure message every contract uses: what drifted, and the
 * docs/maintenance.md section that explains what depends on it.
 *
 * @param pkg - The upstream package.
 * @param section - The heading under "Dependency bumps that need a manual check".
 * @param detail - What the assertion expected.
 * @param workspace - Repo-relative workspace the package is resolved from.
 * @returns A message naming the package version and the section to read.
 */
export function contractMessage(
  pkg: string,
  section: string,
  detail: string,
  workspace = ".",
): string {
  citedSections.add(section);
  let version = "?";
  try {
    version = packageVersion(pkg, workspace);
  } catch {
    // Reported by the assertion itself.
  }
  return `${pkg}@${version}: ${detail}. GeoLibre mirrors this by hand; read "${section}" in docs/maintenance.md and update the mirror (or drop it if upstream now exports it).`;
}
