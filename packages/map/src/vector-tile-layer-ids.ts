/**
 * A vector-tile source layer's name inside a MapLibre layer id. Not injective: `a/b` and `a_2Fb`
 * both encode to `a_2Fb`, a collision inherited from `layer-sync` rather than introduced here.
 */
export function encodeVectorTileLayerPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}
