import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MAPLIBRE_BUNDLE_URL = new URL(
  "../node_modules/maplibre-gl/dist/maplibre-gl.js",
  import.meta.url,
);

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
  if (occurrences === 0) return { bundle, changed: false, occurrences };
  if (occurrences !== 1) {
    return { bundle, changed: false, occurrences };
  }
  return { bundle: bundle.replace(target, ".STREAM_DRAW"), changed: true, occurrences };
}

async function main() {
  const source = await readFile(MAPLIBRE_BUNDLE_URL, "utf8");
  const result = patchMapLibreReadBuffer(source);
  if (result.occurrences > 1) {
    console.warn(
      `Skipping MapLibre read-buffer patch: expected one STREAM_READ usage, found ${result.occurrences}`,
    );
    return;
  }
  if (result.changed) {
    // Replacing the directory entry instead of rewriting the existing inode is
    // safe when Bun populated node_modules with hardlinks to its global cache.
    const temporaryUrl = new URL(`${MAPLIBRE_BUNDLE_URL.href}.${process.pid}.tmp`);
    await writeFile(temporaryUrl, result.bundle);
    await rename(temporaryUrl, MAPLIBRE_BUNDLE_URL);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
