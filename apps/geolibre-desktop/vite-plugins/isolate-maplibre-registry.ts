import type { Plugin } from "vite";

const MAPLIBRE_MAIN_THREAD_BUNDLE = /[\\/]maplibre-gl[\\/]dist[\\/]maplibre-gl(?:-dev)?\.mjs$/;
const REGISTRY_KEY = /_classRegistryKey/g;

/**
 * Rename the property MapLibre's class registry writes onto the classes it
 * registers, so that it cannot break Mapbox GL JS on the same page.
 *
 * Both libraries use `_classRegistryKey`, and MapLibre defines it for good on
 * the shared `Set` and `Error` globals. Mapbox's serializer trusts any class with
 * that key, then fails looking it up in its own registry ("Cannot read properties
 * of undefined (reading 'omit')"), so no tile loads. The name is private to the
 * bundle and the same length, so source maps stay correct. Classes cross to the
 * worker as `$name`, so MapLibre's own worker needs no change.
 * `tests/upstream-contracts.test.ts` guards the assumption.
 *
 * @param code - The module source.
 * @param id - The module id.
 * @returns The rewritten source, or null for any other module.
 */
export function isolateMaplibreRegistry(code: string, id: string): string | null {
  if (!MAPLIBRE_MAIN_THREAD_BUNDLE.test(id.split("?")[0]!)) return null;
  return code.replace(REGISTRY_KEY, "_maplibreRegistry");
}

/**
 * Apply {@link isolateMaplibreRegistry} to a Vite build.
 *
 * @returns The plugin, which also goes in the dev server's dependency optimizer.
 */
export function isolateMaplibreRegistryPlugin(): Plugin {
  return {
    name: "geolibre-isolate-maplibre-registry",
    enforce: "pre",
    transform(code, id) {
      const transformed = isolateMaplibreRegistry(code, id);
      return transformed === null ? null : { code: transformed, map: null };
    },
  };
}
