import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/**
 * Make local vector layers portable across a collaboration connection.
 *
 * Normal project saves may intentionally retain a desktop file reference and
 * omit its features. A collaborator cannot read that path, so collaboration
 * snapshots clear the reloadable flag and embed control-managed vector data.
 * Plain GeoJSON layers already carry their features and only need the flag
 * removed so the core save preparation does not strip them.
 */
export function prepareCollaborationLayers(
  layers: GeoLibreLayer[],
  materialized: ReadonlyMap<string, FeatureCollection>,
): GeoLibreLayer[] {
  return layers.map((layer) => {
    let metadata = layer.metadata;
    const collection = materialized.get(layer.id);
    if (collection) metadata = { ...metadata, embeddedGeoJSON: collection };
    if (metadata.localFileReloadable === true) {
      const { localFileReloadable: _localFileReloadable, ...portableMetadata } = metadata;
      metadata = portableMetadata;
    }
    return metadata === layer.metadata ? layer : { ...layer, metadata };
  });
}
