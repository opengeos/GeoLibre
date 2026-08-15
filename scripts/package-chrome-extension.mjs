import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(root, "extensions/geolibre-chrome");
const manifest = JSON.parse(await readFile(resolve(extensionDir, "manifest.json"), "utf8"));
const runtimeFiles = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.mjs",
  "scanner.mjs",
  "url-builder.mjs",
  "icons/geolibre-16.png",
  "icons/geolibre-32.png",
  "icons/geolibre-48.png",
  "icons/geolibre-128.png",
];

const archive = {};
for (const path of runtimeFiles)
  archive[path] = new Uint8Array(await readFile(resolve(extensionDir, path)));

const outputDir = resolve(root, "dist");
const output = resolve(outputDir, `geolibre-chrome-${manifest.version}.zip`);
await mkdir(outputDir, { recursive: true });
await writeFile(output, zipSync(archive, { level: 9, mtime: new Date(1980, 0, 1) }));
console.log(output);
