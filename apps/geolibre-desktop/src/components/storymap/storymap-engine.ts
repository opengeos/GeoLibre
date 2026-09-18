import * as maplibregl from "maplibre-gl";
import type { StoryChapterLocation } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";

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
    const point = surface.project(coordinate);
    element.style.transform = `translate(-50%, -100%) translate(${point.x}px, ${point.y}px)`;
  };
  const stopMoving = engine.onCameraMove(update);
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
      if (renderedFrame && engine.getRenderStatus().pending.length === 0) finish();
    };
    stopMoving = engine.onCameraMove(() => {
      renderedFrame = true;
    });
    stopIdle = engine.onCameraIdle(() => {
      renderedFrame = true;
      requestAnimationFrame(maybeFinish);
    });
    timer = window.setTimeout(finish, timeoutMs);
    poll = window.setInterval(() => {
      if (isAborted()) finish();
      else maybeFinish();
    }, 100);
    engine.applyView(location);
    requestAnimationFrame(() => {
      renderedFrame = true;
      maybeFinish();
    });
  });
}
