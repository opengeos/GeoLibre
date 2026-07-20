/** Actionable compatibility error for commands removed at the engine seam. */
export function unsupportedScriptingCommandMessage(method: string): string {
  if (method === "run_maplibre_js") {
    return 'Unsupported command "run_maplibre_js": native renderer scripting was removed; use an engine-neutral GeoLibre command instead.';
  }
  return `Unknown command "${method}"`;
}
