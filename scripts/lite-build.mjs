// Build the GeoLibre web app for a host with a per-asset size ceiling.
//
// Identical to `npm run build` except `GEOLIBRE_DUCKDB_WASM_CDN=1` resolves
// DuckDB-WASM from jsDelivr instead of emitting it. That is the difference
// between a build that can be hosted on Cloudflare Pages / Workers static assets
// and one that cannot: `duckdb-mvp.wasm` (~40 MB) and `duckdb-eh.wasm` (~35 MB)
// are the only assets over Cloudflare's 25 MiB per-file limit, and it rejects
// the upload outright rather than degrading. Output drops ~251 MB -> ~176 MB.
//
// GitHub Pages allows 100 MB per file and needs none of this; use `npm run
// build` there. This build also needs network on FIRST DuckDB use (the service
// worker caches it after), so it is wrong for an air-gapped deployment.
//
// Output: apps/geolibre-desktop/dist/ (override with `-- --outDir <dir>`).

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Cloudflare Pages and Workers static assets both cap a single file at 25 MiB.
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Forward extra args (e.g. `-- --outDir dist-lite`) the way build-embed does, and
// track the chosen directory so the guards below check what was actually built.
//
// Both spellings, because Vite's parser (cac) accepts either and reading only the
// space-separated one is worse than not reading it at all: `--outDir=x` would
// leave the guard checking `dist`, which on any machine with a previous build in
// it passes while saying nothing about what was just written. Last occurrence
// wins, matching how cac resolves a repeated flag.
function resolveOutDirName(args) {
  let name = "dist";
  for (const [index, arg] of args.entries()) {
    // Both arms ignore an empty value (`--outDir=` from an unset shell var), which
    // would otherwise resolve to the app directory and walk node_modules.
    if (arg === "--outDir" && args[index + 1]) name = args[index + 1];
    else if (arg.startsWith("--outDir=") && arg.length > "--outDir=".length) {
      name = arg.slice("--outDir=".length);
    }
  }
  return name;
}

const passthrough = process.argv.slice(2);
const distDir = resolve(repoRoot, "apps/geolibre-desktop", resolveOutDirName(passthrough));

const result = spawnSync(
  "npm",
  ["run", "build", "-w", "geolibre-desktop", ...(passthrough.length ? ["--", ...passthrough] : [])],
  {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    env: { ...process.env, GEOLIBRE_DUCKDB_WASM_CDN: "1" },
  },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

// The guard this build exists for. Without it a regression here — the module swap
// breaking, or any *other* asset growing past the ceiling — produces a build that
// looks fine locally and fails at upload time, with nothing pointing at the cause.
const oversized = [];
for (const file of walk(distDir)) {
  const { size } = statSync(file);
  if (size > MAX_ASSET_BYTES) oversized.push({ file: relative(distDir, file), size });
}

if (oversized.length > 0) {
  oversized.sort((a, b) => b.size - a.size);
  const lines = oversized.map(
    ({ file, size }) => `  ${(size / 1024 / 1024).toFixed(1)} MiB  ${file}`,
  );
  const duckdb = oversized.some(({ file }) => /duckdb.*\.wasm$/.test(file));
  console.error(
    `[lite-build] ${oversized.length} asset(s) exceed the 25 MiB per-file limit ` +
      `on Cloudflare Pages / Workers static assets, which will reject the upload:\n` +
      lines.join("\n") +
      (duckdb
        ? "\nDuckDB-WASM was emitted despite GEOLIBRE_DUCKDB_WASM_CDN=1 — check " +
          "`duckdbWasmBundlesPlugin` in vite.config.ts and the " +
          "duckdb-wasm-bundles.cdn.ts / duckdb-wasm-bundles.ts module pair."
        : "\nThis is a new oversized asset, not DuckDB. It needs the same " +
          "treatment: load it from a CDN at runtime rather than emitting it."),
  );
  process.exit(1);
}

let total = 0;
let count = 0;
for (const file of walk(distDir)) {
  total += statSync(file).size;
  count += 1;
}
console.log(
  `[lite-build] ${relative(repoRoot, distDir)}: ${count} files, ` +
    `${(total / 1024 / 1024).toFixed(0)} MB, no file over 25 MiB.`,
);
