/**
 * Build-variant flags injected by Vite. Kept separate from updates.ts (which
 * owns the Microsoft Store flag alongside the update checker it disables) so
 * modules that only need a variant check don't pull in the update machinery.
 */

/**
 * True in the Mac App Store build, where the App Sandbox forbids spawning the
 * Python sidecar, the JupyterLab server, and the martin tile-server helper
 * processes, so every surface that depends on them is compiled out (client and
 * WASM engines keep working in the webview). Guarded the same way as
 * IS_STORE_BUILD in updates.ts so pure helpers stay importable in a plain Node
 * test (where the define is absent) without throwing a ReferenceError.
 * Injected by vite.config.ts; set only by the MAS build path.
 */
export const IS_MAS_BUILD: boolean =
  typeof __GEOLIBRE_MAS_BUILD__ !== "undefined" ? __GEOLIBRE_MAS_BUILD__ : false;
