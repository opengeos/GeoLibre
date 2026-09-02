import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Workspace-scoped production installs, such as the collaboration worker
// image, do not install GeoLibre's raster dependencies. There is nothing to
// patch in those trees, and asking patch-package to find @cogeotiff/core would
// make an otherwise valid `npm ci --omit=dev` fail.
if (!existsSync("node_modules/@cogeotiff/core/package.json")) {
  process.exit(0);
}

const result = spawnSync("patch-package", [], {
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
