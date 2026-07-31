import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userArgs = process.argv.slice(2);
const nativeDuckDb = userArgs.includes("--native-duckdb");
const mas = userArgs.includes("--mas");
const tauriArgs = userArgs.filter((arg) => arg !== "--native-duckdb" && arg !== "--mas");
const buildArgs =
  tauriArgs.length === 0 && process.platform === "linux" ? ["--bundles", "deb,rpm"] : tauriArgs;

if (nativeDuckDb && mas) {
  // Native DuckDB fetches its spatial extension at runtime, which the Mac App
  // Store build must not do (App Sandbox + guideline 2.5.2); the MAS build
  // falls back to DuckDB-WASM in the webview.
  console.error("--native-duckdb cannot be combined with --mas.");
  process.exit(1);
}

if (nativeDuckDb) {
  buildArgs.push("--features", "native-duckdb");
}

if (mas) {
  if (process.platform !== "darwin") {
    console.error("--mas builds the Mac App Store variant and requires macOS.");
    process.exit(1);
  }
  // The `mas` cargo feature compiles out everything that downloads or spawns
  // external code (Python sidecar, Jupyter, martin, uv bootstrap); the config
  // overlay adds App Sandbox entitlements, the embedded provisioning profile,
  // and drops the bundled sidecar resources.
  buildArgs.push("--features", "mas");
  buildArgs.push("--config", "src-tauri/tauri.mas.conf.json");
}

const result = spawnSync(
  "npm",
  ["run", "tauri", "-w", "geolibre-desktop", "--", "build", ...buildArgs],
  {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
    env: mas
      ? {
          ...process.env,
          // Strips the in-app update flow (Store-policy parity with the MSIX
          // Store build) and hides UI backed by the compiled-out services.
          GEOLIBRE_STORE_BUILD: "1",
          GEOLIBRE_MAS_BUILD: "1",
        }
      : process.env,
  },
);

process.exit(result.status ?? 1);
