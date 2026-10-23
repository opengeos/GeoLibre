import type { MapEngine, MapExtent } from "@geolibre/map";

export type ProjectedOverlayAnchor = "top-left" | "bottom";

export interface ProjectedElementHandle {
  setCoordinate(coordinate: [number, number]): void;
  remove(): void;
}

export interface ProjectedExtentHandle {
  setExtent(extent: MapExtent): void;
  setColor(color: string): void;
  remove(): void;
}

interface SharedResizeObserver {
  observer: ResizeObserver;
  callbacks: Set<() => void>;
}

const resizeObservers = new WeakMap<HTMLElement, SharedResizeObserver>();

function observeContainerResize(container: HTMLElement, callback: () => void): () => void {
  let shared = resizeObservers.get(container);
  if (!shared) {
    const callbacks = new Set<() => void>();
    const observer = new ResizeObserver(() => {
      callbacks.forEach((render) => render());
    });
    shared = { observer, callbacks };
    resizeObservers.set(container, shared);
    observer.observe(container);
  }
  shared.callbacks.add(callback);

  return () => {
    shared.callbacks.delete(callback);
    if (shared.callbacks.size === 0) {
      shared.observer.disconnect();
      resizeObservers.delete(container);
    }
  };
}

/** Mount a DOM element at a geographic coordinate on any rendering engine. */
export function mountProjectedElement(
  engine: MapEngine,
  element: HTMLElement,
  coordinate: [number, number],
  anchor: ProjectedOverlayAnchor,
): ProjectedElementHandle {
  const surface = engine.getRenderSurface();
  if (!surface) return { setCoordinate: () => {}, remove: () => {} };
  let currentCoordinate = coordinate;
  const container = surface.getContainer();
  element.style.position = "absolute";
  element.style.left = "0";
  element.style.top = "0";
  element.style.zIndex ||= "10";
  container.appendChild(element);

  const render = () => {
    try {
      const point = surface.project(currentCoordinate);
      const anchorTransform = anchor === "bottom" ? " translate(-50%, -100%)" : "";
      element.style.transform = `translate(${point.x}px, ${point.y}px)${anchorTransform}`;
      element.style.display = "";
    } catch {
      element.style.display = "none";
    }
  };
  const detachMove = engine.onCameraMove(render);
  const detachIdle = engine.onCameraIdle(render);
  const detachResize = observeContainerResize(container, render);
  render();

  return {
    setCoordinate(next) {
      currentCoordinate = next;
      render();
    },
    remove() {
      detachMove();
      detachIdle();
      detachResize();
      element.remove();
    },
  };
}

/** Draw a participant viewport as a projected, colored outline. */
export function mountProjectedExtent(
  engine: MapEngine,
  extent: MapExtent,
  color: string,
): ProjectedExtentHandle {
  const surface = engine.getRenderSurface();
  if (!surface) return { setExtent: () => {}, setColor: () => {}, remove: () => {} };
  let currentExtent = extent;
  const container = surface.getContainer();
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("geolibre-collab-viewport");
  svg.style.cssText =
    "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9;overflow:hidden;";
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("fill", "none");
  polygon.setAttribute("stroke", color);
  polygon.setAttribute("stroke-width", "2");
  polygon.setAttribute("stroke-dasharray", "4 2");
  polygon.setAttribute("stroke-opacity", "0.8");
  svg.appendChild(polygon);
  container.appendChild(svg);

  const render = () => {
    try {
      const [west, south, rawEast, north] = currentExtent;
      const east = rawEast < west ? rawEast + 360 : rawEast;
      const points = [
        surface.project([west, south]),
        surface.project([east, south]),
        surface.project([east, north]),
        surface.project([west, north]),
      ];
      polygon.setAttribute("points", points.map(({ x, y }) => `${x},${y}`).join(" "));
      svg.style.display = "";
    } catch {
      svg.style.display = "none";
    }
  };
  const detachMove = engine.onCameraMove(render);
  const detachIdle = engine.onCameraIdle(render);
  const detachResize = observeContainerResize(container, render);
  render();

  return {
    setExtent(next) {
      currentExtent = next;
      render();
    },
    setColor(next) {
      polygon.setAttribute("stroke", next);
    },
    remove() {
      detachMove();
      detachIdle();
      detachResize();
      svg.remove();
    },
  };
}
