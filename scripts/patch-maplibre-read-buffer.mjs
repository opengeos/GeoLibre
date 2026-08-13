import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MAPLIBRE_BUNDLE_URL = new URL("../node_modules/maplibre-gl/dist/maplibre-gl.js", import.meta.url);

/**
 * MapLibre 5.24 labels its globe projection pixel-pack buffer STREAM_READ.
 * Chromium treats READ-usage buffers specially and repeatedly reports that its
 * readback shadow copy was discarded when MapLibre reuses the buffer. The GL
 * usage value is only a performance hint; STREAM_DRAW avoids that incompatible
 * Chromium optimization while preserving the fenced asynchronous readback.
 */
export function patchMapLibreReadBuffer(bundle) {
  const target = ".STREAM_READ";
  const occurrences = bundle.split(target).length - 1;
  if (occurrences === 0) return { bundle, changed: false };
  if (occurrences !== 1) {
    throw new Error(`Expected one MapLibre STREAM_READ usage, found ${occurrences}`);
  }
  return { bundle: bundle.replace(target, ".STREAM_DRAW"), changed: true };
}

async function main() {
  const source = await readFile(MAPLIBRE_BUNDLE_URL, "utf8");
  const result = patchMapLibreReadBuffer(source);
  if (result.changed) await writeFile(MAPLIBRE_BUNDLE_URL, result.bundle);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
