/**
 * Escape hatches for style properties whose names are only known at runtime.
 *
 * MapLibre v6 made `set/getPaintProperty` and `set/getLayoutProperty` generic
 * over `keyof AllPaintProperties` / `keyof AllLayoutProperties`, so they accept
 * only literal property names the compiler can see. GeoLibre computes property
 * names in several places that the type system cannot follow:
 *
 * - iterating `Object.entries(spec.paint)` when applying a whole style block,
 * - building transition names as `` `${prop}-transition` ``,
 * - taking a `property: string` parameter through a generic helper.
 *
 * Each needs a cast. They live here — one documented module — rather than being
 * sprinkled at every call site, so the blast radius is visible if MapLibre
 * tightens or relaxes these signatures again. Prefer the typed MapLibre methods
 * whenever the property name *is* a literal; reach for these only when it is not.
 */

/**
 * The slice of a MapLibre `Map` these helpers reach through.
 *
 * The getters are optional: they are read to skip no-op writes, and some
 * external-control and test map objects implement only the setters. A missing
 * getter must degrade to "unknown current value" (write anyway), never throw.
 * The setters are required — silently dropping a write would be a real bug.
 */
interface DynamicStyleTarget {
  setPaintProperty: (layerId: string, property: string, value: unknown) => void;
  getPaintProperty?: (layerId: string, property: string) => unknown;
  setLayoutProperty: (layerId: string, property: string, value: unknown) => void;
  getLayoutProperty?: (layerId: string, property: string) => unknown;
}

export function setDynamicPaintProperty(
  map: object,
  layerId: string,
  property: string,
  value: unknown,
): void {
  (map as DynamicStyleTarget).setPaintProperty(layerId, property, value);
}

export function getDynamicPaintProperty(map: object, layerId: string, property: string): unknown {
  return (map as DynamicStyleTarget).getPaintProperty?.(layerId, property);
}

export function setDynamicLayoutProperty(
  map: object,
  layerId: string,
  property: string,
  value: unknown,
): void {
  (map as DynamicStyleTarget).setLayoutProperty(layerId, property, value);
}

export function getDynamicLayoutProperty(map: object, layerId: string, property: string): unknown {
  return (map as DynamicStyleTarget).getLayoutProperty?.(layerId, property);
}
