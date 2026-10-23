import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let workerPath;
try {
  workerPath = fileURLToPath(import.meta.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs"));
} catch (error) {
  if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  workerPath = resolve(
    dirname(createRequire(import.meta.url).resolve("maplibre-gl/package.json")),
    "dist/maplibre-gl-worker.mjs",
  );
}

await build({
  entryPoints: [workerPath],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: fileURLToPath(new URL("../build/maplibre-worker.js", import.meta.url)),
  logLevel: "warning",
});
