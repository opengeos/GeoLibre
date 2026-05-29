import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const userArgs = process.argv.slice(2);
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
  },
);

process.exit(result.status ?? 1);
