// Package the "Open data in GeoLibre" extension for one browser.
//
//   node scripts/package-chrome-extension.mjs                   # Chrome Web Store ZIP
//   node scripts/package-chrome-extension.mjs --target=firefox  # Firefox (AMO) ZIP
//
// Both builds ship the same files; only the manifest differs (see
// scripts/extension-manifest.mjs). Each run writes the versioned ZIP to dist/
// and an unpacked copy to dist/geolibre-<target>/ for loading during
// development (`about:debugging` in Firefox, "Load unpacked" in Chrome).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { EXTENSION_TARGETS, manifestForTarget } from "./extension-manifest.mjs";

const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : "chrome";
if (!EXTENSION_TARGETS.includes(target)) {
  console.error(`Unknown --target "${target}"; expected one of: ${EXTENSION_TARGETS.join(", ")}.`);
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(root, "extensions/geolibre-chrome");
const manifest = manifestForTarget(
  JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8")),
  target,
);
const runtimeFiles = [
  "popup.html",
  "popup.css",
  "popup.mjs",
  "options.html",
  "options.css",
  "options.mjs",
  "base-url-settings.mjs",
  "scanner.mjs",
  "service-scanner.mjs",
  "url-builder.mjs",
  "icons/geolibre-16.png",
  "icons/geolibre-32.png",
  "icons/geolibre-48.png",
  "icons/geolibre-128.png",
];

const archive = {
  "manifest.json": new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
};
for (const path of runtimeFiles)
  archive[path] = new Uint8Array(await readFile(resolve(extensionDir, path)));

const outputDir = resolve(root, "dist");
const output = resolve(outputDir, `geolibre-${target}-${manifest.version}.zip`);
await mkdir(outputDir, { recursive: true });
await writeFile(output, zipSync(archive, { level: 9, mtime: new Date(1980, 0, 1) }));

const unpackedDir = resolve(outputDir, `geolibre-${target}`);
await rm(unpackedDir, { recursive: true, force: true });
for (const [path, bytes] of Object.entries(archive)) {
  const file = resolve(unpackedDir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
console.log(output);
