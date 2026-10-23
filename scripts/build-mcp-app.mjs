// Build the standalone MCP App and stage its HTML into the Python package.
// Independent of the Jupyter/web embed build.
// Output: apps/geolibre-mcp-app/dist/show-map.html -> python/src/geolibre/static/mcp/.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REMEDIATION, scanForCredentials } from "./scan-credentials.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "apps/geolibre-mcp-app/dist");
const staticDir = resolve(repoRoot, "python/src/geolibre/static/mcp");

const result = spawnSync("npm", ["run", "build", "-w", "geolibre-mcp-app"], {
  cwd: repoRoot,
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const findings = scanForCredentials(distDir);
if (findings.length > 0) {
  console.error(
    `[build-mcp-app] Refusing to stage: ${findings.length} credential(s) in the MCP App build.\n` +
      findings.map((finding) => `  - ${finding}`).join("\n") +
      `\n\n${REMEDIATION}`,
  );
  process.exit(1);
}
console.log("[build-mcp-app] Credential scan clean.");

rmSync(staticDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });
cpSync(resolve(distDir, "show-map.html"), resolve(staticDir, "show-map.html"));
console.log(`[build-mcp-app] Staged MCP App view into ${staticDir}`);
