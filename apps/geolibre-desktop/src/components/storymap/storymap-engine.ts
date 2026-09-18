import * as maplibregl from "maplibre-gl";
import type { StoryChapterLocation } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

export interface StoryMapMarker {
  setLngLat(lngLat: [number, number]): void;
  getElement(): HTMLElement;
  remove(): void;
}

function viewMatchesLocation(engine: MapEngine, location: StoryChapterLocation): boolean {
  const current = engine.readView();
  const bearingDelta = Math.abs(
    ((((current.bearing - location.bearing + 180) % 360) + 360) % 360) - 180,
  );
  return (
    Math.abs(current.center[0] - location.center[0]) < 1e-8 &&
    Math.abs(current.center[1] - location.center[1]) < 1e-8 &&
    Math.abs(current.zoom - location.zoom) < 1e-8 &&
    bearingDelta < 1e-8 &&
    Math.abs(current.pitch - location.pitch) < 1e-8
  );
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
      element.style.transform = `translate(-50%, -100%) translate(${point.x}px, ${point.y}px)`;
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
    let settled = false;
    let renderedFrame = false;
    let cameraMoved = false;
    let cameraIdle = false;
    let viewApplied = false;
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
      if (renderedFrame && cameraIdle && engine.getRenderStatus().pending.length === 0) finish();
    };
    stopMoving = engine.onCameraMove(() => {
      cameraMoved = true;
      cameraIdle = false;
      renderedFrame = true;
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
    cameraIdle = viewMatchesLocation(engine, location);
    viewApplied = true;
    engine.applyView(location);
    requestAnimationFrame(() => {
      renderedFrame = true;
      // Immediate camera setters can complete between observable frames.
      if (!engine.isCameraMoving() && viewMatchesLocation(engine, location)) cameraIdle = true;
      maybeFinish();
    });
  });
}
