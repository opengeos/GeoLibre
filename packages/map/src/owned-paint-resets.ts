import { paintBuilderMayReset } from "./style-mapper";

/** The slice of a map (MapLibre or Mapbox) the ownership check reads. */
interface LayerLookup {
  getLayer(id: string): unknown;
}

/**
 * Which nullable paint properties GeoLibre itself wrote on a plugin's or
 * control's native layers, so a `null` from the paint builders (a dash cleared
 * back to solid, the fill hairline under a dashed outline) resets only what
 * GeoLibre set and never the plugin's own value, such as its dashed lines.
 *
 * Ownership is tied to the native layer object the map returned when GeoLibre
 * wrote the value. A plugin that removes and recreates its layer under the same
 * id, or a style swap, gives a new object, so a stale entry cannot reset the
 * new layer's own paint. A plugin rewriting the property on the same layer
 * object is not seen, so in that case the ownership is best-effort.
 */
export class OwnedPaintResets {
  // Keyed by the native layer object, so a removed layer is not kept alive and
  // a recreated one (a new object) starts with nothing owned.
  private readonly owned = new WeakMap<object, Set<string>>();

  /**
   * Whether `value` should be written to `property` on native layer `id`, and
   * record ownership when GeoLibre writes a value it may later reset.
   *
   * @param map - The map the native layer lives on.
   * @param id - The native layer id.
   * @param property - The paint property.
   * @param value - The value the paint builders produced.
   * @returns False for a `null` reset of a property GeoLibre does not own on
   *   this layer; true otherwise.
   */
  shouldWrite(map: LayerLookup, id: string, property: string, value: unknown): boolean {
    if (!paintBuilderMayReset(property)) return true;
    const layer = map.getLayer(id);
    if (typeof layer !== "object" || layer === null) return value !== null;
    let properties = this.owned.get(layer);
    if (value !== null) {
      if (!properties) {
        properties = new Set();
        this.owned.set(layer, properties);
      }
      properties.add(property);
      return true;
    }
    return properties?.delete(property) ?? false;
  }
}
