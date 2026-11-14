/**
 * Placement math for the floating selection panels (`SelectionFloatingPanel`),
 * kept free of React so it can be unit-tested on its own.
 */

/** Gap kept between the card and the bottom of the map area, in pixels. */
const EDGE_MARGIN = 12;
/** Deepest top offset of a `defaultPositionClass` (`top-9`), in pixels. */
const DEFAULT_MAX_TOP = 36;

/**
 * Clamp a dragged panel's position to the map area, for a drag move and when
 * the map area resizes under the card. Horizontally the whole card stays
 * inside. Vertically the card moves up until its full content height fits;
 * when the map area is too short for that, it is pinned to the top and the
 * height cap (`selectionPanelMaxHeight`) makes its body scroll.
 *
 * Pass the card's natural content height, not its rendered height: the cap
 * shrinks the rendered card as it moves down, so clamping against that would
 * let each drag step squash it a little further.
 *
 * @param pos - The wanted offset within the map area, in pixels.
 * @param area - The map area's size, in pixels.
 * @param card - The card's width and natural (uncapped) height, in pixels.
 * @returns The clamped offset, never negative.
 */
export function clampSelectionPanelPosition(
  pos: { x: number; y: number },
  area: { width: number; height: number },
  card: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(pos.x, area.width - card.width)),
    y: Math.max(0, Math.min(pos.y, area.height - card.height - EDGE_MARGIN)),
  };
}

/**
 * CSS `max-height` for the card, so it never extends past the bottom of the
 * map area whether it sits at its default corner or was dragged.
 *
 * @param top - The dragged top offset in pixels, or null at the default corner.
 * @returns A `calc()` relative to the map-area overlay's height.
 */
export function selectionPanelMaxHeight(top: number | null): string {
  // Before a drag the card sits at its default corner class, `top-3` or
  // `top-9` (36px); reserve room for the deeper one.
  const offset = (top ?? DEFAULT_MAX_TOP) + EDGE_MARGIN;
  return `calc(100% - ${offset}px)`;
}
