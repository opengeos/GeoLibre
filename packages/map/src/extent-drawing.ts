import type { ExtentDrawingOptions, MapExtent } from "./map-engine";

/** Use the shorter longitude arc, preserving a crossing as west > east. */
export function extentFromCorners(a: [number, number], b: [number, number]): MapExtent {
  const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
  let west = Math.min(wrap(a[0]), wrap(b[0]));
  let east = Math.max(wrap(a[0]), wrap(b[0]));
  if (east - west > 180) [west, east] = [east, west];
  return [west, Math.min(a[1], b[1]), east, Math.max(a[1], b[1])];
}

/** One pointer lifecycle shared by both engines. Sky hits never become coordinates. */
export function drawExtentOnCanvas(
  canvas: HTMLCanvasElement,
  pick: (point: { x: number; y: number }) => [number, number] | null,
  suspendNavigation: () => () => void,
  options: ExtentDrawingOptions,
): () => void {
  let start: [number, number] | null = null;
  let pointer: number | null = null;
  let disposed = false;
  const cursor = canvas.style.cursor;
  const restore = suspendNavigation();
  canvas.style.cursor = "crosshair";
  const location = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return pick({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || pointer !== null) return;
    start = location(event);
    if (!start) return;
    pointer = event.pointerId;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const move = (event: PointerEvent) => {
    if (!start || event.pointerId !== pointer) return;
    const end = location(event);
    if (end) options.onChange(extentFromCorners(start, end));
  };
  const up = (event: PointerEvent) => {
    if (!start || event.pointerId !== pointer || event.button !== 0) return;
    const end = location(event);
    const extent = end ? extentFromCorners(start, end) : null;
    dispose();
    if (extent && extent[0] !== extent[2] && extent[1] !== extent[3]) {
      options.onChange(extent);
      options.onDone?.(extent);
    } else options.onCancel?.();
  };
  const cancel = () => {
    dispose();
    options.onCancel?.();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) cancel();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", key);
    canvas.style.cursor = cursor;
    restore();
    start = null;
    pointer = null;
  };
  canvas.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", key);
  return dispose;
}
