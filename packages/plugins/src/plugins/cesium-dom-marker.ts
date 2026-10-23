import type { CesiumSceneHandle } from "@geolibre/map";

/** A longitude/latitude in either form a MapLibre `LngLatLike` takes here. */
type LngLatInput = [number, number] | { lng: number; lat: number } | { lon: number; lat: number };

/** The marker surface a MapLibre control positions its own element through. */
export interface CesiumDomMarker {
  setLngLat(lngLat: LngLatInput): CesiumDomMarker;
  addTo(map: unknown): CesiumDomMarker;
  remove(): CesiumDomMarker;
  getElement(): HTMLElement;
}

function toLngLat(value: LngLatInput): [number, number] | null {
  if (Array.isArray(value)) return [Number(value[0]), Number(value[1])];
  const lng = "lng" in value ? value.lng : value.lon;
  return [Number(lng), Number(value.lat)];
}

/**
 * A DOM marker on the Cesium globe: the caller's element, laid over the
 * canvas and moved to the window position of a ground location every frame.
 *
 * MapLibre's `Marker` reads the map's transform, which the globe's control
 * facade does not have, so a control that builds its own marker element (Street
 * View's location pin) needs this in its place. The element is placed on the
 * terrain under the location, centred on it, and hidden while the location is
 * past the horizon or off the screen. It follows the scene's `postRender`, so
 * it tracks the camera smoothly rather than at the facade's `move` threshold.
 *
 * @param getScene - The primary globe's scene handle, read when the marker is
 *   added (the control builds it before it is on a map).
 * @param element - The element to position; its own transform is the
 *   caller's, so placement uses `left`/`top`.
 * @returns The marker.
 */
export function createCesiumDomMarker(
  getScene: () => CesiumSceneHandle | null,
  element: HTMLElement,
): CesiumDomMarker {
  let lngLat: [number, number] | null = null;
  let scene: CesiumSceneHandle | null = null;
  let unsubscribe: (() => void) | null = null;

  const update = () => {
    if (!scene || !lngLat) {
      element.style.display = "none";
      return;
    }
    const C = scene.Cesium;
    const [lng, lat] = lngLat;
    const height = scene.scene.globe?.getHeight(C.Cartographic.fromDegrees(lng, lat)) ?? 0;
    const world = C.Cartesian3.fromDegrees(lng, lat, height);
    // Past the horizon the projection still lands on the visible disc.
    if (scene.scene.mode === C.SceneMode.SCENE3D) {
      const toEye = C.Cartesian3.subtract(scene.camera.positionWC, world, new C.Cartesian3());
      if (C.Cartesian3.dot(world, toEye) < 0) {
        element.style.display = "none";
        return;
      }
    }
    const point = C.SceneTransforms.worldToWindowCoordinates(scene.scene, world);
    const { clientWidth, clientHeight } = scene.canvas;
    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x > clientWidth ||
      point.y > clientHeight
    ) {
      element.style.display = "none";
      return;
    }
    element.style.display = "";
    element.style.left = `${point.x - (element.offsetWidth || 0) / 2}px`;
    element.style.top = `${point.y - (element.offsetHeight || 0) / 2}px`;
  };

  const marker: CesiumDomMarker = {
    setLngLat(value) {
      lngLat = toLngLat(value);
      update();
      return marker;
    },
    addTo() {
      marker.remove();
      scene = getScene();
      const parent = scene?.canvas.parentElement;
      if (!scene || !parent) return marker;
      Object.assign(element.style, {
        position: "absolute",
        pointerEvents: "none",
        zIndex: "1",
      });
      parent.appendChild(element);
      const remove = scene.scene.postRender.addEventListener(update);
      unsubscribe = remove;
      update();
      scene.requestRender();
      return marker;
    },
    remove() {
      unsubscribe?.();
      unsubscribe = null;
      element.remove();
      scene = null;
      return marker;
    },
    getElement: () => element,
  };
  return marker;
}
