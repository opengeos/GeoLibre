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

/**
 * Duration (ms) a single touch must remain stationary on the map before the
 * cross-platform touch long-press context menu opens (iOS + Android parity).
 */
export const CONTEXT_MENU_TOUCH_HOLD_MS = 500;

/**
 * Pixels a held finger may drift before cancelling a touch long-press (wider
 * than desktop mouse tolerance to accommodate natural finger jitter).
 */
export const CONTEXT_MENU_TOUCH_TOLERANCE_PX = 10;

/** Minimal pointer payload the tracker needs. */
export interface GesturePointer {
  /** Pointer id, so a second pointer does not disturb the tracked gesture. */
  pointerId: number;
  /** Pointer type (`"mouse"`, `"touch"`, `"pen"`). */
  pointerType?: string;
  /** Button that changed state (`0` left, `2` right); ignored on move. */
  button: number;
  clientX: number;
  clientY: number;
}

/** Injectable timer scheduler so touch long-press tests run deterministically. */
export interface ContextMenuTimerScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_SCHEDULER: ContextMenuTimerScheduler = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Cursor position of a `contextmenu` request, in viewport pixels. */
export interface ContextMenuRequest {
  clientX: number;
  clientY: number;
  /** True when triggered by a touch long-press gesture. */
  isTouch?: boolean;
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

interface TouchHoldGesture {
  pointerId: number;
  startX: number;
  startY: number;
  timer: unknown;
}

/**
 * Follows one mouse-button gesture or single-finger touch long-press on the map
 * and decides when to open the quick-actions menu.
 */
export class ContextMenuGestureTracker {
  private gesture: Gesture | null = null;
  private touchHold: TouchHoldGesture | null = null;
  private activeTouchIds = new Set<number>();
  private lastTouchLongPressAt: number | null = null;

  /**
   * Creates a tracker.
   *
   * @param open - Called with the request position when the menu should open.
   * @param now - Clock in milliseconds; injectable for tests.
   * @param scheduler - Timer implementation; injectable for tests.
   */
  constructor(
    private readonly open: (request: ContextMenuRequest) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly scheduler: ContextMenuTimerScheduler = DEFAULT_SCHEDULER,
  ) {}

  private clearTouchHold(): void {
    if (!this.touchHold) return;
    this.scheduler.clearTimeout(this.touchHold.timer);
    this.touchHold = null;
  }

  /**
   * Records a button or finger press on the map.
   *
   * @param event - The `pointerdown` payload.
   */
  pointerDown(event: GesturePointer): void {
    if (event.pointerType === "touch") {
      this.activeTouchIds.add(event.pointerId);
      // Multi-touch (pinch/zoom/rotate) cancels any pending single-finger long-press.
      if (this.activeTouchIds.size > 1) {
        this.clearTouchHold();
        return;
      }
      this.clearTouchHold();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const timer = this.scheduler.setTimeout(() => {
        if (this.touchHold?.pointerId !== pointerId) return;
        this.touchHold = null;
        this.lastTouchLongPressAt = this.now();
        this.open({ clientX: startX, clientY: startY, isTouch: true });
      }, CONTEXT_MENU_TOUCH_HOLD_MS);
      this.touchHold = { pointerId, startX, startY, timer };
      return;
    }
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
    if (event.pointerType === "touch" || this.touchHold?.pointerId === event.pointerId) {
      if (this.touchHold && this.touchHold.pointerId === event.pointerId) {
        const dx = event.clientX - this.touchHold.startX;
        const dy = event.clientY - this.touchHold.startY;
        if (Math.hypot(dx, dy) > CONTEXT_MENU_TOUCH_TOLERANCE_PX) {
          this.clearTouchHold();
        }
      }
      return;
    }
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
    if (event.pointerType === "touch" || this.activeTouchIds.has(event.pointerId)) {
      this.activeTouchIds.delete(event.pointerId);
      if (this.touchHold?.pointerId === event.pointerId) {
        this.clearTouchHold();
      }
      return;
    }
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
   */
  cancel(pointerId?: number): void {
    if (pointerId === undefined) {
      this.activeTouchIds.clear();
      this.clearTouchHold();
      this.gesture = null;
      return;
    }
    this.activeTouchIds.delete(pointerId);
    if (this.touchHold?.pointerId === pointerId) {
      this.clearTouchHold();
    }
    if (this.gesture?.pointerId === pointerId) {
      this.gesture = null;
    }
  }

  /**
   * Handles a `contextmenu` event on the map.
   *
   * - Button still held (Linux/macOS): defer until release.
   * - Just released (Windows): open only if the gesture was not a drag.
   * - Just opened by touch long-press (Android): suppress duplicate native event.
   * - No gesture (keyboard menu key, Shift+F10): open right away.
   */
  contextMenu(request: ContextMenuRequest): void {
    if (
      this.lastTouchLongPressAt !== null &&
      this.now() - this.lastTouchLongPressAt <= CONTEXT_MENU_RELEASE_WINDOW_MS
    ) {
      this.lastTouchLongPressAt = null;
      return;
    }
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
