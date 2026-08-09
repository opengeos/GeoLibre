import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { buildMapboxStyle, type MapboxStyleExportResult } from "./mapbox-style-export";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Filename stem the `?style=` loader uses to associate style layers with data. */
export function geoLibreStyleSourceName(layer: Pick<GeoLibreLayer, "name" | "sourcePath">): string {
  // A ZIP member is addressed as `archive.zip#folder/parks.geojson`, so that
  // fragment names the data. Any other fragment is an ordinary URL hash
  // (`data.geojson#view`) and must not be mistaken for the filename.
  const source = layer.sourcePath ?? "";
  const fragment = safeDecode(source.includes("#") ? source.slice(source.indexOf("#") + 1) : "");
  const raw =
    (/\.(?:geojson|json)$/i.test(fragment) ? fragment : source.split("#")[0]) || layer.name;
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split(/[?#]/)[0] ?? raw;
  }
  // Decode before splitting: an entry written as `folder%2Fparks.geojson` has to
  // read as a path, or the stem would come out as `folder/parks`.
  const basename = safeDecode(pathname).replaceAll("\\", "/").split("/").pop() || layer.name;
  const stem = basename.replace(/\.(?:geojson|json)$/i, "").trim();
  return stem || "layer";
}

/**
 * Build a compact GeoLibre query-param style. Unlike the general Mapbox export,
 * this document does not embed features: `?data=` supplies them. Every render
 * layer points at the data filename stem used by the ZIP style dispatcher.
 */
export function buildGeoLibreQueryStyle(
  layer: GeoLibreLayer,
  geojson: FeatureCollection,
): MapboxStyleExportResult {
  const result = buildMapboxStyle(layer, geojson, { largeFeatureCount: Number.POSITIVE_INFINITY });
  const sourceName = geoLibreStyleSourceName(layer);
  const oldSource = Object.keys(result.style.sources)[0];
  return {
    warnings: result.warnings,
    style: {
      ...result.style,
      name: `${layer.name} — GeoLibre URL style`,
      sources: {
        [sourceName]: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: result.style.layers.map((styleLayer) =>
        "source" in styleLayer && styleLayer.source === oldSource
          ? { ...styleLayer, source: sourceName }
          : styleLayer,
      ),
    },
  };
}
