import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const userArgs = process.argv.slice(2);

// Forward an explicit cross-build target to the fetch helper so it pulls the
// matching DuckDB artifact rather than the host's. `tauri build` accepts the
// split (`--target <triple>`, `-t <triple>`) and joined (`--target=<triple>`,
// `-t=<triple>`) forms, so handle all of them.
function extractTargetTriple(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target" || arg === "-t") return args[i + 1] || "";
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
    if (arg.startsWith("-t=")) return arg.slice("-t=".length);
  }
  return "";
}
const targetTriple = extractTargetTriple(userArgs);
const targetArgs = targetTriple ? ["--target", targetTriple] : [];

// Fetch and verify the DuckDB spatial extension into the Tauri resources tree
// before bundling, so packaged desktop builds ship a signed extension the native
// DuckDB loader can read offline. A checksum mismatch aborts the build here.
const fetched = spawnSync(
  process.execPath,
  [resolve(repoRoot, "scripts/fetch-duckdb-spatial.mjs"), ...targetArgs],
  {
    cwd: repoRoot,
    stdio: "inherit",
  }
);
if (fetched.status !== 0) {
  process.exit(fetched.status ?? 1);
}
const buildArgs =
  userArgs.length === 0 && process.platform === "linux"
    ? ["--bundles", "deb,rpm"]
    : userArgs;

const result = spawnSync(
  "npm",
  ["run", "tauri", "-w", "geolibre-desktop", "--", "build", ...buildArgs],
  {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  }
);

process.exit(result.status ?? 1);
