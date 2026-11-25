import type { GeoLibreLayer } from "@geolibre/core";

/** Match an owned package by its stable identity, including when a damaged
 * manifest can no longer supply a readable archive path. */
export function referencesNativeOfflinePackage(
  layer: Pick<GeoLibreLayer, "sourcePath" | "source" | "metadata">,
  id: string,
): boolean {
  if (layer.metadata.nativeOfflinePackageId === id) return true;
  for (const reference of [layer.sourcePath, layer.source.url]) {
    if (typeof reference !== "string") continue;
    const url = reference.replace(/^pmtiles:\/\//, "");
    let path = url;
    if (
      /^(?:https?:\/\/(?:local-pmtiles|mbtiles)\.localhost|(?:local-pmtiles|mbtiles):\/\/localhost)\//.test(
        url,
      )
    ) {
      path = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("path") ?? "";
    } else if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path)) {
      continue;
    }
    const match =
      /(?:^|[\\/])offline-packages[\\/](pkg-[0-9a-f]{32})[\\/]archive\.(?:pmtiles|mbtiles)$/.exec(
        path,
      );
    if (match?.[1] === id) return true;
  }
  return false;
}
