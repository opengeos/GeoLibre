// Orthographic top / side / front views of one cuboid, for precise editing
// the map camera cannot give (Segments.ai's side views). Each view is a
// standalone deck.gl Deck showing the points around the box in the box's own
// frame, with drag handles on the box outline.

import { COORDINATE_SYSTEM, Deck, OrthographicView } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { fromBoxFrame, localFrame, toBoxFrame, type Cuboid } from "./cuboid";

/** Which plane a view looks at: top (x-y), side (x-z) or front (y-z). */
export type ViewPlane = "top" | "side" | "front";

/** Points around the box, already in its frame (metres), with colours. */
export interface BoxFramePoints {
  /** `[x, y, z]` per point in the box frame. */
  xyz: Float32Array;
  /** RGBA per point. */
  colors: Uint8Array;
  count: number;
}

/** What a drag on a view changes. */
export type HandleKind = "move" | "min-a" | "max-a" | "min-b" | "max-b" | "rotate";

/**
 * Maps a view plane to the box-frame axes it shows horizontally (a) and
 * vertically (b): top = (x, y), side = (x, z), front = (y, z).
 *
 * @param plane - The view plane.
 * @returns Axis indices into `[x, y, z]`.
 */
export function planeAxes(plane: ViewPlane): [number, number] {
  return plane === "top" ? [0, 1] : plane === "side" ? [0, 2] : [1, 2];
}

/**
 * Finds which handle a pointer at `(a, b)` (box-frame metres in the view's
 * plane) grabs: an edge within `tolerance` resizes along it, the rotation
 * knob (top view only) rotates, anything inside the box moves it.
 *
 * @param plane - The view plane.
 * @param box - The box being edited.
 * @param a - Horizontal coordinate in metres.
 * @param b - Vertical coordinate in metres.
 * @param tolerance - Grab distance in metres.
 * @returns The handle, or null when the pointer is off the box.
 */
export function hitHandle(
  plane: ViewPlane,
  box: Cuboid,
  a: number,
  b: number,
  tolerance: number,
): HandleKind | null {
  const [ia, ib] = planeAxes(plane);
  const ha = box.size[ia] / 2;
  const hb = box.size[ib] / 2;
  if (plane === "top" && Math.hypot(a - (ha + 3 * tolerance), b) <= 1.5 * tolerance)
    return "rotate";
  const insideA = a >= -ha - tolerance && a <= ha + tolerance;
  const insideB = b >= -hb - tolerance && b <= hb + tolerance;
  if (!insideA || !insideB) return null;
  // The nearest edge within reach wins, so a box thinner than the reach can
  // still be grown from either side.
  const edges: [HandleKind, number][] = [
    ["min-a", Math.abs(a + ha)],
    ["max-a", Math.abs(a - ha)],
    ["min-b", Math.abs(b + hb)],
    ["max-b", Math.abs(b - hb)],
  ];
  let nearest: HandleKind = "move";
  let best = tolerance;
  for (const [kind, distance] of edges) {
    if (distance <= best) {
      best = distance;
      nearest = kind;
    }
  }
  return nearest;
}

/**
 * Applies a drag from `(a0, b0)` to `(a1, b1)` (box-frame metres at drag
 * start) to the box as it was at drag start. Resizing keeps the opposite face
 * fixed; moving shifts the centre in the plane; rotating turns the heading by
 * the angle swept around the centre.
 *
 * @param plane - The view plane.
 * @param start - The box when the drag began.
 * @param handle - The grabbed handle.
 * @param a0 - Start horizontal coordinate.
 * @param b0 - Start vertical coordinate.
 * @param a1 - Current horizontal coordinate.
 * @param b1 - Current vertical coordinate.
 * @returns The edited box.
 */
export function dragBox(
  plane: ViewPlane,
  start: Cuboid,
  handle: HandleKind,
  a0: number,
  b0: number,
  a1: number,
  b1: number,
): Cuboid {
  const [ia, ib] = planeAxes(plane);
  if (handle === "rotate") {
    const swept = Math.atan2(b1, a1) - Math.atan2(b0, a0);
    return { ...start, yaw: Math.atan2(Math.sin(start.yaw + swept), Math.cos(start.yaw + swept)) };
  }
  // Work out the new centre offset and size in the box frame.
  const offset = [0, 0, 0];
  const size = [...start.size] as [number, number, number];
  const minSize = 0.05;
  if (handle === "move") {
    offset[ia] = a1 - a0;
    offset[ib] = b1 - b0;
  } else {
    const axis = handle.endsWith("-a") ? ia : ib;
    const delta = handle.endsWith("-a") ? a1 - a0 : b1 - b0;
    const sign = handle.startsWith("max") ? 1 : -1;
    const grown = Math.max(minSize, start.size[axis] + sign * delta);
    offset[axis] = (sign * (grown - start.size[axis])) / 2;
    size[axis] = grown;
  }
  const center = fromBoxFrame(start, offset[0], offset[1], offset[2]);
  return { center, size, yaw: start.yaw };
}

/**
 * Gathers the points around a box into its frame, for the views.
 *
 * @param box - The box.
 * @param positions - Cloud positions (`[dLng, dLat, z]` offsets).
 * @param origin - Cloud coordinate origin.
 * @param indices - Candidate points (e.g. from `pointsInCuboid` with a margin).
 * @param colorOf - Colour for a point index.
 * @returns The points in box-frame metres.
 */
export function boxFramePoints(
  box: Cuboid,
  positions: Float32Array,
  origin: readonly [number, number, number],
  indices: ArrayLike<number>,
  colorOf: (index: number) => [number, number, number],
): BoxFramePoints {
  const frame = localFrame(box.center[1]);
  const xyz = new Float32Array(indices.length * 3);
  const colors = new Uint8Array(indices.length * 4);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    const [x, y, z] = toBoxFrame(
      box,
      origin[0] + positions[i * 3],
      origin[1] + positions[i * 3 + 1],
      positions[i * 3 + 2],
      frame,
    );
    xyz.set([x, y, z], k * 3);
    const [r, g, b] = colorOf(i);
    colors.set([r, g, b, 255], k * 4);
  }
  return { xyz, colors, count: indices.length };
}

interface PlaneView {
  plane: ViewPlane;
  deck: Deck<OrthographicView>;
  canvasHost: HTMLElement;
  /** Current zoom: 2^zoom pixels per metre. */
  zoom: number;
  /** View centre in the plane, metres. */
  target: [number, number];
  /** Cursor for the handle under the pointer (deck.gl applies it). */
  cursor: string;
}

/** Callbacks from the views back to the annotator. */
export interface ObjectViewsHandlers {
  /** Called on every drag step with the edited box. */
  onChange: (box: Cuboid) => void;
  /** Called once when a drag ends. */
  onCommit: (box: Cuboid) => void;
}

/**
 * Three orthographic views of a box, mounted into `container`.
 */
export class ObjectViews {
  private readonly views: PlaneView[] = [];
  private box: Cuboid | null = null;
  private points: BoxFramePoints | null = null;
  private drag: {
    view: PlaneView;
    handle: HandleKind;
    start: Cuboid;
    a0: number;
    b0: number;
    pointerId: number;
  } | null = null;

  /**
   * @param container - Element the three views are laid out in.
   * @param handlers - Change callbacks.
   * @param labels - View captions (translated by the caller).
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly handlers: ObjectViewsHandlers,
    labels: Record<ViewPlane, string>,
  ) {
    container.style.cssText =
      "display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;height:100%;min-height:160px;";
    for (const plane of ["top", "side", "front"] as ViewPlane[]) {
      const cell = document.createElement("div");
      cell.style.cssText =
        "position:relative;min-width:0;min-height:140px;border:1px solid hsl(var(--border));border-radius:4px;overflow:hidden;background:#111;";
      cell.dataset.plane = plane;
      const caption = document.createElement("div");
      caption.textContent = labels[plane];
      caption.style.cssText =
        "position:absolute;top:2px;left:4px;z-index:1;font-size:11px;color:#ddd;pointer-events:none;";
      const canvasHost = document.createElement("div");
      canvasHost.style.cssText = "position:absolute;inset:0;";
      cell.append(canvasHost, caption);
      container.append(cell);
      const deck = new Deck<OrthographicView>({
        parent: canvasHost,
        views: new OrthographicView({ id: plane, flipY: false }),
        initialViewState: { target: [0, 0, 0], zoom: 3 },
        controller: false,
        layers: [],
        // deck.gl owns the canvas cursor (default "grab"); report the handle's.
        getCursor: () => view.cursor,
      });
      const view: PlaneView = {
        plane,
        deck,
        canvasHost,
        zoom: 3,
        target: [0, 0],
        cursor: "default",
      };
      this.views.push(view);
      canvasHost.addEventListener("pointerdown", (event) => this.onPointerDown(view, event));
      canvasHost.addEventListener("pointermove", (event) => this.onPointerMove(view, event));
      canvasHost.addEventListener("pointerup", (event) => this.onPointerUp(view, event));
      canvasHost.addEventListener("pointercancel", (event) => this.onPointerUp(view, event));
      canvasHost.addEventListener("wheel", (event) => this.onWheel(view, event), {
        passive: false,
      });
    }
  }

  /**
   * Shows a box and the points around it.
   *
   * @param box - The box, or null to clear.
   * @param points - Points in the box frame.
   * @param refit - Re-zoom each view to the box.
   */
  update(box: Cuboid | null, points: BoxFramePoints | null, refit = false): void {
    this.box = box;
    this.points = points;
    for (const view of this.views) {
      if (refit && box) this.fit(view);
      view.deck.setProps({ layers: this.layers(view.plane) });
    }
  }

  /** Releases the three WebGL contexts. */
  destroy(): void {
    for (const view of this.views) view.deck.finalize();
    this.views.length = 0;
    this.container.replaceChildren();
  }

  private fit(view: PlaneView): void {
    if (!this.box) return;
    const [ia, ib] = planeAxes(view.plane);
    const width = view.canvasHost.clientWidth || 200;
    const height = view.canvasHost.clientHeight || 150;
    const span = Math.max(
      this.box.size[ia] * 1.6 + 2,
      (this.box.size[ib] * 1.6 + 2) * (width / height),
    );
    this.setView(view, [0, 0], Math.log2(width / span));
  }

  private layers(plane: ViewPlane) {
    const box = this.box;
    const points = this.points;
    if (!box) return [];
    const [ia, ib] = planeAxes(plane);
    const ha = box.size[ia] / 2;
    const hb = box.size[ib] / 2;
    const flat = new Float32Array((points?.count ?? 0) * 2);
    for (let k = 0; k < (points?.count ?? 0); k++) {
      flat[k * 2] = points!.xyz[k * 3 + ia];
      flat[k * 2 + 1] = points!.xyz[k * 3 + ib];
    }
    const outline = [
      [-ha, -hb],
      [ha, -hb],
      [ha, hb],
      [-ha, hb],
      [-ha, -hb],
    ];
    const paths: { path: number[][]; color: [number, number, number] }[] = [
      { path: outline, color: [250, 204, 21] },
    ];
    // A heading tick on the front face, and the rotation knob in the top view.
    if (plane === "top") {
      paths.push({
        path: [
          [ha, 0],
          [ha + Math.max(ha, hb) * 0.3, 0],
        ],
        color: [250, 204, 21],
      });
    }
    return [
      new ScatterplotLayer({
        id: `points-${plane}`,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: {
          length: points?.count ?? 0,
          attributes: {
            getPosition: { value: flat, size: 2 },
            getFillColor: { value: points?.colors ?? new Uint8Array(0), size: 4 },
          },
        },
        radiusUnits: "pixels",
        getRadius: 1.2,
        updateTriggers: { getPosition: [points, box] },
      }),
      new PathLayer({
        id: `outline-${plane}`,
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        data: paths,
        getPath: (d: { path: number[][] }) => d.path as [number, number][],
        getColor: (d: { color: [number, number, number] }) => d.color,
        widthUnits: "pixels",
        getWidth: 2,
      }),
    ];
  }

  private setView(view: PlaneView, target: [number, number], zoom: number): void {
    view.target = target;
    view.zoom = zoom;
    view.deck.setProps({ initialViewState: { target: [target[0], target[1], 0], zoom } });
  }

  private toPlane(view: PlaneView, event: PointerEvent | WheelEvent): [number, number] | null {
    const viewport = view.deck.getViewports()[0];
    if (!viewport) return null;
    const rect = view.canvasHost.getBoundingClientRect();
    const [a, b] = viewport.unproject([event.clientX - rect.left, event.clientY - rect.top]);
    return [a, b];
  }

  private tolerance(view: PlaneView): number {
    // 8 pixels in metres at the current zoom.
    return 8 / 2 ** view.zoom;
  }

  private onPointerDown(view: PlaneView, event: PointerEvent): void {
    if (!this.box || event.button !== 0) return;
    const at = this.toPlane(view, event);
    if (!at) return;
    const handle = hitHandle(view.plane, this.box, at[0], at[1], this.tolerance(view));
    if (!handle) return;
    event.preventDefault();
    view.canvasHost.setPointerCapture?.(event.pointerId);
    this.drag = { view, handle, start: this.box, a0: at[0], b0: at[1], pointerId: event.pointerId };
  }

  private onPointerMove(view: PlaneView, event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.view !== view || event.pointerId !== drag.pointerId) {
      if (this.box && !drag) {
        const at = this.toPlane(view, event);
        const handle = at && hitHandle(view.plane, this.box, at[0], at[1], this.tolerance(view));
        view.cursor =
          handle === "move"
            ? "move"
            : handle === "rotate"
              ? "grab"
              : handle === "min-a" || handle === "max-a"
                ? "ew-resize"
                : handle
                  ? "ns-resize"
                  : "default";
        view.canvasHost.dataset.handle = handle ?? "";
      }
      return;
    }
    const at = this.toPlane(view, event);
    if (!at) return;
    const box = dragBox(view.plane, drag.start, drag.handle, drag.a0, drag.b0, at[0], at[1]);
    this.handlers.onChange(box);
  }

  private onPointerUp(view: PlaneView, event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.view !== view || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    view.canvasHost.releasePointerCapture?.(event.pointerId);
    if (this.box) this.handlers.onCommit(this.box);
  }

  private onWheel(view: PlaneView, event: WheelEvent): void {
    event.preventDefault();
    // Zoom about the pointer, so a thin box can be blown up where it is.
    const at = this.toPlane(view, event);
    const zoom = view.zoom - Math.sign(event.deltaY) * 0.25;
    if (!at) {
      this.setView(view, view.target, zoom);
      return;
    }
    const factor = 2 ** (view.zoom - zoom);
    this.setView(
      view,
      [at[0] + (view.target[0] - at[0]) * factor, at[1] + (view.target[1] - at[1]) * factor],
      zoom,
    );
  }
}
