import { setWorkerUrl } from "maplibre-gl";
// Vite bundles the worker (it imports `./maplibre-gl-shared.mjs`) and hands back
// the emitted asset URL.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

/**
 * Point MapLibre at its bundled worker.
 *
 * v6 ships the worker as a **separate file** and locates it at runtime with
 * `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. That is a computed
 * string, not a static `new URL(…, import.meta.url)` literal, so no bundler can
 * see it: the file is never emitted, and at runtime the URL resolves next to the
 * hashed app chunk (`/assets/maplibre-gl-worker.mjs`), where nothing exists. In
 * the web build the SPA fallback answers that request with `index.html`, so the
 * failure is not even a 404 — the worker is handed HTML, and the request hangs
 * rather than erroring.
 *
 * `setWorkerUrl` overrides that lookup with an asset the build actually emits.
 * Must run before the first `Map` is constructed, so it is imported for effect
 * from the app entry.
 */
setWorkerUrl(maplibreWorkerUrl);
