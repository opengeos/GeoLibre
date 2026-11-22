#!/usr/bin/env node
/**
 * Sync or verify the shared TS/Python `project-constants.json` artifact.
 *
 * Canonical source: `packages/core/src/project-constants.json`
 * Python copy:      `python/src/geolibre/project-constants.json`
 *
 * Usage:
 *   node scripts/sync-project-constants.mjs         # copy canonical -> Python
 *   node scripts/sync-project-constants.mjs --check # fail if copies differ
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalPath = path.join(rootDir, "packages/core/src/project-constants.json");
const pythonPath = path.join(rootDir, "python/src/geolibre/project-constants.json");

const canonical = fs.readFileSync(canonicalPath, "utf8");
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const current = fs.existsSync(pythonPath) ? fs.readFileSync(pythonPath, "utf8") : "";
  if (current !== canonical) {
    console.error(
      "python/src/geolibre/project-constants.json is out of sync with packages/core/src/project-constants.json.\n" +
        "Run `node scripts/sync-project-constants.mjs` to update it.",
    );
    process.exit(1);
  }
  console.log("project-constants.json is in sync.");
} else {
  fs.writeFileSync(pythonPath, canonical, "utf8");
  console.log(
    "Synced packages/core/src/project-constants.json -> python/src/geolibre/project-constants.json",
  );
}
