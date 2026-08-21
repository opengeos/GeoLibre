import { useAppStore } from "@geolibre/core";
import { createPMTilesStoreLayer, readRemotePMTilesInfo } from "@geolibre/map/pmtiles-layer";
import { createLayerId } from "../layer-ids";

/**
 * Add a STAC item's PMTiles asset as a layer.
 *
 * Not through the PMTiles control: it is a singleton that holds the archive it is loading on
 * itself and reports the outcome through shared state, so a caller cannot tell which add failed or
 * which layer it produced. Reading the header here is a range request, and the layer shape still
 * comes from {@link createPMTilesStoreLayer}. Answers null for an archive with no layers to draw.
 */
export async function addPMTilesAsset(
  href: string,
  name: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const info = await readRemotePMTilesInfo(href, signal);
  signal?.throwIfAborted();

  // No source layers means nothing to draw, which would land a placeholder and report success.
  if (info.tileType === "vector" && info.sourceLayers.length === 0) return null;

  // Full opacity, unlike the basemap extract's dimmed raster: an asset added from a search result
  // is the thing the user asked to look at, not a backdrop.
  const id = createLayerId();
  useAppStore.getState().addLayer(
    createPMTilesStoreLayer({
      id,
      name,
      url: href,
      tileType: info.tileType,
      ...(info.encoding ? { encoding: info.encoding } : {}),
      sourceLayers: info.sourceLayers,
    }),
  );
  return id;
}
