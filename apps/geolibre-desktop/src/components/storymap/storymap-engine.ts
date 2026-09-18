import * as maplibregl from "maplibre-gl";
import type { StoryChapterLocation } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

const RENDER_STABILITY_MS = 500;

export interface StoryMapMarker {
  setLngLat(lngLat: [number, number]): void;
  getElement(): HTMLElement;
  remove(): void;
}

/** Pin the standard story marker to any engine's renderer-neutral surface. */
export function createStoryMapMarker(engine: MapEngine, color: string): StoryMapMarker | null {
  const surface = engine.getRenderSurface();
  if (!surface) return null;
  const element = new maplibregl.Marker({ color }).getElement();
  element.style.pointerEvents = "none";
  surface.getContainer().appendChild(element);
  let coordinate: [number, number] | null = null;
  let removed = false;
  const update = () => {
    if (removed || !coordinate) return;
    try {
      const point = surface.project(coordinate);
      element.style.display = "";
      // Match MapLibre's default pin: center anchor with its built-in -14 px
      // vertical offset keeps the shadow ellipse's center on the coordinate.
      element.style.transform = `translate(-50%, -50%) translate(${point.x}px, ${point.y - 14}px)`;
    } catch {
      // Cesium cannot project a coordinate on the far side of the globe. Keep
      // the marker hidden until the camera brings it back into view.
      element.style.display = "none";
    }
  };
  const stopMoving = engine.onCameraMove(update);
  const resize = new ResizeObserver(update);
  resize.observe(surface.getContainer());
  const marker: StoryMapMarker = {
    setLngLat(lngLat) {
      coordinate = lngLat;
      update();
    },
    getElement: () => element,
    remove() {
      if (removed) return;
      removed = true;
      stopMoving();
      resize.disconnect();
      element.remove();
    },
  };
  return marker;
}

/**
 * Apply a story camera and wait until the active engine has finished rendering.
 * A timeout keeps an unavailable tile from stalling a whole handout export.
 */
export function applyStoryViewAndWait(
  engine: MapEngine,
  location: StoryChapterLocation,
  isAborted: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve) => {
    if (isAborted()) {
      resolve();
      return;
    }
    let settled = false;
    let renderedFrame = false;
    let cameraMoved = false;
    let cameraIdle = false;
    let viewApplied = false;
    let stableSince = 0;
    let stopMoving = () => {};
    let stopIdle = () => {};
    let timer = 0;
    let poll = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      stopMoving();
      stopIdle();
      window.clearTimeout(timer);
      window.clearInterval(poll);
      resolve();
    };
    const maybeFinish = () => {
      const ready = renderedFrame && cameraIdle && engine.getRenderStatus().pending.length === 0;
      if (!ready) {
        stableSince = 0;
        return;
      }
      stableSince ||= performance.now();
      if (performance.now() - stableSince >= RENDER_STABILITY_MS) finish();
    };
    stopMoving = engine.onCameraMove(() => {
      cameraMoved = true;
      cameraIdle = false;
      renderedFrame = true;
      stableSince = 0;
    });
    stopIdle = engine.onCameraIdle(() => {
      if (!viewApplied || !cameraMoved) return;
      cameraIdle = true;
      renderedFrame = true;
      requestAnimationFrame(maybeFinish);
    });
    timer = window.setTimeout(finish, timeoutMs);
    poll = window.setInterval(() => {
      if (isAborted()) finish();
      else maybeFinish();
    }, 100);
    viewApplied = true;
    try {
      void Promise.resolve(engine.applyView(location)).then(() => {
        if (settled) return;
        cameraIdle = !engine.isCameraMoving();
        requestAnimationFrame(() => {
          renderedFrame = true;
          maybeFinish();
        });
      }, finish);
    } catch {
      finish();
    }
  });
}
