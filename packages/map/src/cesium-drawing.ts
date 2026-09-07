import type { CesiumWidget } from "@cesium/engine";
import type { ManualPlacementOptions } from "./map-engine";
import { pickGlobeHit } from "./cesium-camera";

type CesiumNs = typeof import("@cesium/engine");

export function pickDrawingLocation(
  C: CesiumNs,
  viewer: CesiumWidget,
  point: { x: number; y: number },
): [number, number] | null {
  if (viewer.isDestroyed() || viewer.scene.mode === C.SceneMode.MORPHING) return null;
  const hit = pickGlobeHit(C, viewer, point);
  if (!hit) return null;
  const position = C.Cartographic.fromCartesian(hit.position, viewer.scene.globe.ellipsoid);
  return [C.Math.toDegrees(position.longitude), C.Math.toDegrees(position.latitude)];
}

/** Save the exact navigation state, including when another tool disabled it. */
export function suspendCesiumNavigation(viewer: CesiumWidget): () => void {
  const controller = viewer.scene.screenSpaceCameraController;
  const previous = controller.enableInputs;
  controller.enableInputs = false;
  return () => {
    if (!viewer.isDestroyed()) controller.enableInputs = previous;
  };
}

export function placeCesiumPin(
  C: CesiumNs,
  viewer: CesiumWidget,
  lngLat: [number, number],
  options: ManualPlacementOptions,
  mount: (element: HTMLElement) => () => void,
): () => void {
  const entity = viewer.entities.add({
    position: C.Cartesian3.fromDegrees(...lngLat),
    point: {
      pixelSize: 18,
      color: C.Color.fromCssColorString("#ef4444"),
      outlineColor: C.Color.WHITE,
      outlineWidth: 2,
      heightReference: C.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  const container = document.createElement("div");
  container.className = "maplibregl-ctrl geolibre-placement-popup";
  const hint = document.createElement("p");
  hint.className = "geolibre-placement-popup-hint";
  hint.textContent = options.hint;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "geolibre-placement-popup-done";
  button.textContent = options.doneLabel;
  container.append(hint, button);
  const unmount = mount(container);
  const canvas = viewer.canvas;
  let pointer: number | null = null;
  let restore: (() => void) | null = null;
  let disposed = false;
  const screen = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return new C.Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || pointer !== null || viewer.scene.mode === C.SceneMode.MORPHING)
      return;
    if (viewer.scene.pick(screen(event))?.id !== entity) return;
    pointer = event.pointerId;
    restore = suspendCesiumNavigation(viewer);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const location = pickDrawingLocation(C, viewer, screen(event));
    if (!location) return;
    entity.position = new C.ConstantPositionProperty(C.Cartesian3.fromDegrees(...location));
    viewer.scene.requestRender();
    options.onMove(location);
  };
  const release = () => {
    pointer = null;
    restore?.();
    restore = null;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer || event.button !== 0) return;
    try {
      move(event);
    } finally {
      release();
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) dispose();
  };
  const done = () => {
    dispose();
    options.onDone?.();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    release();
    canvas.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", release);
    window.removeEventListener("blur", release);
    window.removeEventListener("keydown", key);
    button.removeEventListener("click", done);
    unmount();
    if (!viewer.isDestroyed()) {
      viewer.entities.remove(entity);
      viewer.scene.requestRender();
    }
  };
  canvas.addEventListener("pointerdown", down, true);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", release);
  window.addEventListener("blur", release);
  window.addEventListener("keydown", key);
  button.addEventListener("click", done);
  viewer.scene.requestRender();
  return dispose;
}
