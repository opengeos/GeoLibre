/**
 * Tells a right-click apart from a right-button drag (issue #2721).
 *
 * MapLibre and Mapbox rotate and pitch the camera on a right-button drag, and
 * Cesium zooms on one, but the browser still fires `contextmenu` for that
 * gesture. Worse, the timing differs by platform: Windows fires it on release,
 * after the drag, while Linux and macOS fire it on press, before the pointer has
 * moved at all. So the map's quick-actions menu cannot decide at `contextmenu`
 * time alone. This tracker follows the pointer from press to release and only
 * lets the menu open once the button is up and the pointer stayed within
 * {@link CONTEXT_MENU_DRAG_TOLERANCE_PX} of where it went down.
 *
 * The tracker is DOM-free: the caller forwards pointer events and receives an
 * `open` callback when the menu should appear, which keeps it unit-testable.
 */

/**
 * Pixels the pointer may travel while a button is held before the gesture
 * counts as a drag. Matches MapLibre's default `clickTolerance`, so any
 * movement large enough to turn the camera also suppresses the menu.
 */
export const CONTEXT_MENU_DRAG_TOLERANCE_PX = 3;

/**
 * How long after a right-button release a `contextmenu` event is still treated
 * as belonging to that gesture. Windows fires it in the same task as the
 * release; the window only guards against a stale gesture swallowing a later
 * keyboard-invoked menu.
 */
export const CONTEXT_MENU_RELEASE_WINDOW_MS = 500;

/** Minimal pointer payload the tracker needs. */
export interface GesturePointer {
  /** Pointer id, so a second pointer does not disturb the tracked gesture. */
  pointerId: number;
  /** Button that changed state (`0` left, `2` right); ignored on move. */
  button: number;
  clientX: number;
  clientY: number;
}

/** Cursor position of a `contextmenu` request, in viewport pixels. */
export interface ContextMenuRequest {
  clientX: number;
  clientY: number;
}

interface Gesture {
  pointerId: number;
  button: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** Timestamp of the release, or `null` while the button is still held. */
  releasedAt: number | null;
  /** A `contextmenu` that arrived while the button was still held. */
  pending: ContextMenuRequest | null;
}

/**
 * Follows one mouse-button gesture on the map and decides whether the
 * `contextmenu` it produced should open the quick-actions menu.
 */
export class ContextMenuGestureTracker {
  private gesture: Gesture | null = null;

  /**
   * Creates a tracker.
   *
   * @param open - Called with the request position when the menu should open.
   * @param now - Clock in milliseconds; injectable for tests.
   */
  constructor(
    private readonly open: (request: ContextMenuRequest) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Records a button press on the map. A new press always replaces whatever
   * gesture came before it.
   *
   * @param event - The `pointerdown` payload.
   */
  pointerDown(event: GesturePointer): void {
    this.gesture = {
      pointerId: event.pointerId,
      button: event.button,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      releasedAt: null,
      pending: null,
    };
  }

  /**
   * Marks the held gesture as a drag once it leaves the tolerance radius.
   *
   * @param event - A `pointermove` payload.
   */
  pointerMove(event: GesturePointer): void {
    const gesture = this.gesture;
    if (!gesture || gesture.releasedAt !== null || gesture.pointerId !== event.pointerId) return;
    if (gesture.moved) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.hypot(dx, dy) > CONTEXT_MENU_DRAG_TOLERANCE_PX) gesture.moved = true;
  }

  /**
   * Ends the held gesture. Opens a menu that was deferred at press time
   * (Linux/macOS) unless the gesture turned into a drag.
   *
   * @param event - The `pointerup` payload.
   */
  pointerUp(event: GesturePointer): void {
    const gesture = this.gesture;
    if (!gesture || gesture.releasedAt !== null || gesture.pointerId !== event.pointerId) return;
    this.pointerMove(event);
    gesture.releasedAt = this.now();
    const pending = gesture.pending;
    if (!pending) return;
    this.gesture = null;
    if (!gesture.moved) this.open(pending);
  }

  /**
   * Drops the held gesture without opening anything, e.g. on `pointercancel`
   * or when the window loses focus mid-press.
   *
   * @param pointerId - Only cancel when the tracked gesture belongs to this
   *   pointer, so a cancelled unrelated pointer leaves it alone. Omit it (window
   *   blur) to cancel unconditionally.
   */
  cancel(pointerId?: number): void {
    if (pointerId !== undefined && this.gesture?.pointerId !== pointerId) return;
    this.gesture = null;
  }

  /**
   * Handles a `contextmenu` event on the map.
   *
   * - Button still held (Linux/macOS): defer until release.
   * - Just released (Windows): open only if the gesture was not a drag.
   * - No gesture (keyboard menu key, Shift+F10): open right away.
   *
   * @param request - Cursor position of the `contextmenu` event.
   */
  contextMenu(request: ContextMenuRequest): void {
    const gesture = this.gesture;
    if (gesture && gesture.releasedAt === null) {
      gesture.pending = request;
      return;
    }
    this.gesture = null;
    if (
      gesture &&
      gesture.button === 2 &&
      gesture.releasedAt !== null &&
      this.now() - gesture.releasedAt <= CONTEXT_MENU_RELEASE_WINDOW_MS &&
      gesture.moved
    ) {
      return;
    }
    this.open(request);
  }
}
