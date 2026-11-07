import { paintBuilderMayReset } from "./style-mapper";

/**
 * Resolves a native layer id to an object that stays the same for the life of
 * that layer (MapLibre's `map.getLayer`; on Mapbox the style's own layer, since
 * Mapbox's `map.getLayer` returns a fresh serialized copy on every call).
 * `undefined` when there is no such layer or no stable object to use.
 */
export type StableLayerLookup = (id: string) => object | undefined;

/**
 * Which resettable paint properties (see `paintBuilderMayReset`) GeoLibre
 * itself wrote on a plugin's or control's native layers, so a reset from
 * `withPaintResets` (a dash cleared back to solid, a blur back to sharp, the
 * fill hairline under a dashed outline) clears only what GeoLibre set and
 * never the plugin's own value, such as its dashed lines.
 *
 * Ownership is keyed by the native layer object, so a removed layer is not
 * kept alive, and a plugin that recreates its layer under the same id, or a
 * style swap, starts with nothing owned. A plugin rewriting the property on
 * the same layer object is not seen, so in that case ownership is best-effort.
 * Without a stable layer object nothing is owned, so nothing is reset: the
 * plugin's paint is left alone rather than risked.
 */
export class OwnedPaintResets {
  private readonly owned = new WeakMap<object, Set<string>>();

  /**
   * Whether a `null` reset of `property` on native layer `id` may be written:
   * only when GeoLibre wrote that property on this layer. Ownership ends with
   * the reset.
   *
   * @param lookup - Resolves the native layer id to its stable object.
   * @param id - The native layer id.
   * @param property - The paint property.
   * @returns True when GeoLibre owns the value to reset.
   */
  mayReset(lookup: StableLayerLookup, id: string, property: string): boolean {
    const layer = lookup(id);
    return layer !== undefined && (this.owned.get(layer)?.delete(property) ?? false);
  }

  /**
   * Record that GeoLibre wrote a non-null value to `property` on native layer
   * `id`. Call it only after an actual write: a value the plugin already had
   * stays the plugin's.
   *
   * @param lookup - Resolves the native layer id to its stable object.
   * @param id - The native layer id.
   * @param property - The paint property.
   */
  recordWrite(lookup: StableLayerLookup, id: string, property: string): void {
    if (!paintBuilderMayReset(property)) return;
    const layer = lookup(id);
    if (layer === undefined) return;
    let properties = this.owned.get(layer);
    if (!properties) {
      properties = new Set();
      this.owned.set(layer, properties);
    }
    properties.add(property);
  }
}
