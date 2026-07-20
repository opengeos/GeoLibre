import maplibregl from "maplibre-gl";

/** Set by MapLibre once the control is in compact (collapsible) mode. */
const COMPACT_CLASS = "maplibregl-compact";
/** Set alongside it while the attribution text is expanded. */
const SHOW_CLASS = "maplibregl-compact-show";

/** The slice of an element the collapse helpers touch (kept small for tests). */
type ClassListElement = Pick<HTMLElement, "classList">;

/**
 * Collapse a compact attribution control once MapLibre has expanded it.
 *
 * @returns True once compact mode is on — the moment after which MapLibre never
 *   expands the control on its own again, so a caller watching for it can stop.
 *   False while the control has yet to enter compact mode.
 */
export function collapseCompactAttribution(container: ClassListElement): boolean {
  if (!container.classList.contains(COMPACT_CLASS)) return false;
  container.classList.remove(SHOW_CLASS);
  return true;
}

/**
 * Collapse the control as soon as MapLibre expands it, then stop watching.
 *
 * Attribution arrives asynchronously — with the first tiles, and again as
 * layers are added — so the expansion cannot be caught at `onAdd` time. Watching
 * the class list catches it whenever it lands, and giving up straight afterwards
 * leaves the user's own toggling of the control alone.
 *
 * @returns A function that stops the watch early (on control removal), or null
 *   when the control was already expanded or no `MutationObserver` exists.
 */
export function watchForCompactAttribution(container: HTMLElement): (() => void) | null {
  if (collapseCompactAttribution(container)) return null;
  if (typeof MutationObserver === "undefined") return null;
  const observer = new MutationObserver(() => {
    if (collapseCompactAttribution(container)) observer.disconnect();
  });
  observer.observe(container, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * A compact attribution control that starts collapsed.
 *
 * MapLibre's compact mode expands itself the first time the style reports an
 * attribution: `_updateCompact` adds `maplibregl-compact` and
 * `maplibregl-compact-show` in the same breath, and the only things that take
 * `maplibregl-compact-show` back off are a map drag or a click on the toggle.
 * A freshly loaded map therefore sits with its full attribution text spread
 * across the corner until the user touches the map. Collapsing it ourselves the
 * moment that expansion lands gives the map the tidy corner badge that compact
 * mode was asked for in the first place.
 */
export class CollapsedAttributionControl extends maplibregl.AttributionControl {
  private unwatch: (() => void) | null = null;

  constructor() {
    super({ compact: true });
  }

  override onAdd(map: maplibregl.Map): HTMLElement {
    const container = super.onAdd(map);
    this.unwatch = watchForCompactAttribution(container);
    return container;
  }

  override onRemove(): void {
    this.unwatch?.();
    this.unwatch = null;
    super.onRemove();
  }
}
