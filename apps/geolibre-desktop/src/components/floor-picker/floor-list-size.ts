/**
 * Sizing the floor picker's list (issue #3341): the height a user drags it to,
 * remembered per browser, and the room the map leaves for it. Kept apart from
 * the component so Fast Refresh can still hot-swap the component file.
 */

/** Where this browser remembers the floor list's height (a viewer convenience, not project state). */
export const LIST_HEIGHT_KEY = "geolibre.floorPicker.listHeight";
/** The list never shrinks below this many floors. */
export const MIN_ROWS = 3;
/** Gap kept between the picker and the map's bottom edge. */
const BOTTOM_MARGIN_PX = 10;

/** The remembered list height, or `null` for the default. Storage can throw (private mode). */
export function readListHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(LIST_HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Remember (or, with `null`, forget) the list height. */
export function writeListHeight(height: number | null): void {
  try {
    if (height === null) window.localStorage.removeItem(LIST_HEIGHT_KEY);
    else window.localStorage.setItem(LIST_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // Not remembered; the height still applies for this session.
  }
}

/**
 * Clamp a list height between {@link MIN_ROWS} floors and the room the map
 * leaves for it.
 *
 * @param height - The requested height in pixels.
 * @param rowHeight - One floor button's height.
 * @param room - The most the list can take without the picker running off the
 *   map (see {@link floorListRoom}), or `null` when unknown.
 * @returns The height to apply.
 */
export function clampFloorListHeight(
  height: number,
  rowHeight: number,
  room: number | null,
): number {
  const min = rowHeight * MIN_ROWS;
  const max = Math.max(min, room ?? Number.POSITIVE_INFINITY);
  return Math.round(Math.min(max, Math.max(min, height)));
}

/**
 * The height the floor list can take: from its top edge down to the map's
 * bottom, minus what the picker draws under it ("+ below", the grip), the
 * controls in the bottom-right corner below it (attribution, scale), and a
 * margin. The picker sits under the corner's other controls, so the map's
 * height alone overstates the room.
 *
 * @param list - The floor list element.
 * @param picker - The picker panel element.
 * @param map - The map container, or `null` when not found.
 * @returns The room in pixels, or `null` without a map.
 */
export function floorListRoom(
  list: HTMLElement,
  picker: HTMLElement,
  map: HTMLElement | null,
): number | null {
  if (!map) return null;
  const listRect = list.getBoundingClientRect();
  const below = picker.getBoundingClientRect().bottom - listRect.bottom;
  const corner = map.querySelector<HTMLElement>(
    ".maplibregl-ctrl-bottom-right, .mapboxgl-ctrl-bottom-right",
  );
  const floor = corner ? corner.getBoundingClientRect().top : map.getBoundingClientRect().bottom;
  return floor - listRect.top - below - BOTTOM_MARGIN_PX;
}

/** The map container a picker host sits in, on any renderer. */
export function mapContainerOf(host: HTMLElement): HTMLElement | null {
  return host.closest<HTMLElement>(".maplibregl-map, .mapboxgl-map, .cesium-widget, .esri-view");
}
