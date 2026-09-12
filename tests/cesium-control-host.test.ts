import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import { Event as CesiumEvent } from "@cesium/engine";
import {
  CesiumControlHost,
  getPrimaryCesiumControlHost,
  setPrimaryCesiumControlHost,
} from "../packages/map/src/cesium-control-host";

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  setPrimaryCesiumControlHost(null);
  Object.assign(globalThis, {
    document: originalDocument,
    HTMLElement: originalHTMLElement,
  });
});

function installDom() {
  const { document, window } = parseHTML(
    "<html><body><div id='cesium-parent'></div></body></html>",
  );
  Object.assign(globalThis, { document, HTMLElement: window.HTMLElement });
  return document;
}

function makeFakeViewer(document: Document) {
  const canvas = document.createElement("canvas");
  return {
    canvas,
    scene: { canvas },
    camera: { heading: 0, pitch: -Math.PI / 2 },
  };
}

const RADIANS = Math.PI / 180;

/**
 * A viewer with the scene surface the facade's geometry reads: a globe that
 * reports a ground height, an ellipsoid that round-trips a cartesian, and a
 * camera that picks and bounds. `hit` controls whether a screen point lands on
 * the globe at all.
 */
function makeSceneViewer(document: Document, options: { hit?: boolean } = {}) {
  const canvas = document.createElement("canvas");
  const hit = options.hit ?? true;
  const ellipsoid = {
    // The fake Cartesian3 carries its own degrees, so the round trip is exact.
    cartesianToCartographic: (position: { lng: number; lat: number }) => ({
      longitude: position.lng * RADIANS,
      latitude: position.lat * RADIANS,
    }),
  };
  const scene = {
    canvas,
    globe: {
      ellipsoid,
      getHeight: () => 120,
      // The picked cartesian is the fake's own lng/lat pair, so unproject
      // round-trips it through cartesianToCartographic above.
      pick: () => (hit ? { lng: 12.5, lat: -3.25 } : undefined),
    },
  };
  return {
    canvas,
    scene,
    camera: {
      heading: 0,
      pitch: -Math.PI / 2,
      getPickRay: (point: { x: number; y: number }) => (hit ? { point } : undefined),
      pickEllipsoid: () => undefined,
      computeViewRectangle: () => ({
        west: -10 * RADIANS,
        south: -20 * RADIANS,
        east: 30 * RADIANS,
        north: 40 * RADIANS,
      }),
    },
    isDestroyed: () => false,
  };
}

/** Just enough of `@cesium/engine` for the facade's project/unproject/getBounds. */
function makeFakeCesium(options: { project?: { x: number; y: number } | undefined } = {}) {
  return {
    Math: { toDegrees: (radians: number) => radians / RADIANS },
    Cartographic: { fromDegrees: (lng: number, lat: number) => ({ lng, lat }) },
    Cartesian3: {
      fromDegrees: (lng: number, lat: number, height: number) => ({
        lng,
        lat,
        height,
      }),
    },
    Ellipsoid: { WGS84: {} },
    SceneTransforms: {
      worldToWindowCoordinates: () => ("project" in options ? options.project : { x: 400, y: 300 }),
    },
  };
}

describe("CesiumControlHost", () => {
  let doc: Document;
  let parent: HTMLElement;
  let viewer: ReturnType<typeof makeFakeViewer>;

  beforeEach(() => {
    doc = installDom();
    parent = doc.getElementById("cesium-parent")!;
    viewer = makeFakeViewer(doc);
    useAppStore.setState({
      mapView: { center: [-122.4, 37.7], zoom: 10, bearing: 15, pitch: 45 },
    } as never);
  });

  it("moves a control without remounting its widget and rejects invalid corners", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const element = doc.createElement("button");
    let mounts = 0;
    let removals = 0;
    const control = {
      onAdd: () => {
        mounts++;
        return element;
      },
      onRemove: () => {
        removals++;
      },
    };
    host.addControl(control);
    assert.equal(host.setControlPosition(control, "bottom-left"), true);
    assert.equal(element.parentElement?.className, "maplibregl-ctrl-bottom-left");
    assert.equal(mounts, 1);
    assert.equal(removals, 0);
    assert.equal(host.setControlPosition(control, "constructor" as never), false);
    host.destroy();
    assert.equal(removals, 1);
  });

  it("creates corner containers with pointer-events: none over the parent", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const container = host.getContainer();
    assert.ok(container);
    assert.equal(container.className, "maplibregl-control-container");
    assert.equal(container.parentElement, parent);

    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    for (const corner of corners) {
      const el = container.querySelector(`.maplibregl-ctrl-${corner}`) as HTMLElement;
      assert.ok(el, `missing corner ${corner}`);
      assert.equal(el.style.pointerEvents, "none");
      assert.equal(el.style.position, "absolute");
      assert.equal(el.style.zIndex, "2");
    }
    host.destroy();
  });

  it("mounts controls with pointer-events: auto in the requested corner", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    ctrlEl.className = "test-control";

    let passedMap: MapLibreMap | null = null;
    const control: IControl = {
      onAdd: (map) => {
        passedMap = map;
        return ctrlEl;
      },
      onRemove: () => {},
    };

    const added = host.addControl(control, "bottom-left");
    assert.equal(added, true);
    assert.ok(passedMap, "control onAdd must receive map facade");
    assert.equal(ctrlEl.style.pointerEvents, "auto");

    const corner = host.getContainer().querySelector(".maplibregl-ctrl-bottom-left")!;
    assert.ok(corner.contains(ctrlEl));

    // Refuses duplicate control
    assert.equal(host.addControl(control), false);

    host.destroy();
  });

  it("falls back to top-right corner when position is not recognized", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {},
    };

    const added = host.addControl(control, "unknown-corner" as never);
    assert.equal(added, true);
    const corner = host.getContainer().querySelector(".maplibregl-ctrl-top-right")!;
    assert.ok(corner.contains(ctrlEl));
    host.destroy();
  });

  it("handles throwing control.onAdd gracefully without adding to registry", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const control: IControl = {
      onAdd: () => {
        throw new Error("Plugin failed to construct DOM");
      },
      onRemove: () => {},
    };

    const added = host.addControl(control);
    assert.equal(added, false);
    host.destroy();
  });

  it("rejects controls returning invalid elements or duck-typed objects from onAdd", () => {
    const host = new CesiumControlHost(viewer as never, parent);

    const duckTypedObj = { style: {} };
    const controlWithDuckType: IControl = {
      onAdd: () => duckTypedObj as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithDuckType), false);

    const forgedNode = { nodeType: 1, style: {} };
    const controlWithForgedNode: IControl = {
      onAdd: () => forgedNode as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithForgedNode), false);

    const controlWithNull: IControl = {
      onAdd: () => null as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithNull), false);

    const controlWithNumber: IControl = {
      onAdd: () => 42 as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithNumber), false);

    host.destroy();
  });

  it("safely falls back to top-right on inherited prototype properties as position", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {},
    };

    const added = host.addControl(control, "__proto__" as never);
    assert.equal(added, true);
    const corner = host.getContainer().querySelector(".maplibregl-ctrl-top-right")!;
    assert.ok(corner.contains(ctrlEl));
    host.destroy();
  });

  it("handles control whose onRemove detaches its container from parentNode directly", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    let onRemoveCalled = false;

    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {
        onRemoveCalled = true;
        // Classic MapLibre control pattern that throws if detached beforehand
        ctrlEl.parentNode!.removeChild(ctrlEl);
      },
    };

    host.addControl(control, "top-left");
    assert.doesNotThrow(() => host.removeControl(control));
    assert.equal(onRemoveCalled, true);
    assert.equal(ctrlEl.parentElement, null);
    host.destroy();
  });

  it("safeguards removeControl when control.onRemove throws", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");

    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {
        throw new Error("Teardown error in third-party control");
      },
    };

    host.addControl(control, "top-right");
    assert.doesNotThrow(() => host.removeControl(control));
    assert.equal(ctrlEl.parentElement, null, "DOM element must still be detached");
    host.destroy();
  });

  it("safely tears down all controls and container in destroy even if a control throws", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const el1 = doc.createElement("div");
    const el2 = doc.createElement("div");
    let c2Removed = false;

    const c1: IControl = {
      onAdd: () => el1,
      onRemove: () => {
        throw new Error("c1 explode");
      },
    };
    const c2: IControl = {
      onAdd: () => el2,
      onRemove: () => {
        c2Removed = true;
      },
    };

    host.addControl(c1);
    host.addControl(c2);
    assert.doesNotThrow(() => host.destroy());

    assert.equal(c2Removed, true, "subsequent controls must still be unmounted");
    assert.equal(host.getContainer().parentElement, null, "container must be detached from parent");
  });

  it("provides active camera view getters on CesiumMapFacade", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    let facade: any = null;
    const control: IControl = {
      onAdd: (map) => {
        facade = map;
        return doc.createElement("div");
      },
      onRemove: () => {},
    };

    host.addControl(control);
    assert.ok(facade);
    assert.equal(facade.getCanvas(), viewer.canvas);
    assert.equal(facade.isStyleLoaded(), true);
    assert.equal(facade.getZoom(), 10);
    assert.equal(facade.getBearing(), 15);
    assert.equal(facade.getPitch(), 45);
    assert.equal(facade.getCenter().lng, -122.4);
    assert.equal(facade.getCenter().lat, 37.7);

    // Unsupported style-spec mutations throw explicitly
    assert.throws(() => facade.addLayer({}), /addLayer is not supported/);
    assert.throws(() => facade.setPaintProperty(), /setPaintProperty is not supported/);
    assert.throws(() => facade.setLayoutProperty(), /setLayoutProperty is not supported/);
    assert.throws(() => facade.getStyle(), /getStyle is not supported/);

    // Source mutations must not report success without rendering anything.
    assert.throws(
      () => facade.addSource("test-src", { type: "geojson" }),
      /addSource is not supported/,
    );
    assert.throws(() => facade.removeSource("test-src"), /removeSource is not supported/);
    assert.throws(() => facade.removeLayer("test-layer"), /removeLayer is not supported/);
    assert.equal(facade.getSource("test-src"), undefined);

    host.destroy();
  });

  /** Mount a throwaway control just to capture the facade `onAdd` receives. */
  function facadeOf(host: CesiumControlHost): any {
    let facade: any = null;
    host.addControl({
      onAdd: (map) => {
        facade = map;
        return doc.createElement("div");
      },
      onRemove: () => {},
    });
    return facade;
  }

  it("forwards camera events and detaches every subscription on destroy", () => {
    const camera = Object.assign(viewer.camera, {
      moveStart: new CesiumEvent(),
      changed: new CesiumEvent(),
      moveEnd: new CesiumEvent(),
    });
    const host = new CesiumControlHost(viewer as never, parent);
    const facade = facadeOf(host);
    const events: string[] = [];
    for (const name of ["movestart", "move", "moveend"]) facade.on(name, () => events.push(name));
    camera.moveStart.raiseEvent();
    camera.changed.raiseEvent();
    camera.moveEnd.raiseEvent();
    assert.deepEqual(events, ["movestart", "move", "moveend"]);
    host.destroy();
    assert.equal(camera.moveStart.numberOfListeners, 0);
    assert.equal(camera.changed.numberOfListeners, 0);
    assert.equal(camera.moveEnd.numberOfListeners, 0);
  });

  it("forwards geographic pointer events and stops forwarding after destruction", () => {
    const sceneViewer = makeSceneViewer(doc);
    parent.appendChild(sceneViewer.canvas);
    sceneViewer.canvas.getBoundingClientRect = () => ({ left: 10, top: 20 }) as DOMRect;
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const facade = facadeOf(host);
    assert.equal(facade.getContainer(), parent);
    const clicks: any[] = [];
    facade.on("click", (event: unknown) => clicks.push(event));
    const event = new doc.defaultView!.Event("click");
    Object.assign(event, { clientX: 110, clientY: 220 });
    sceneViewer.canvas.dispatchEvent(event);
    assert.equal(clicks.length, 1);
    assert.deepEqual([clicks[0].point.x, clicks[0].point.y], [100, 200]);
    assert.ok(Math.abs(clicks[0].lngLat.lng - 12.5) < 1e-9);
    assert.equal(clicks[0].originalEvent, event);
    host.destroy();
    sceneViewer.canvas.dispatchEvent(event);
    assert.equal(clicks.length, 1);
  });

  it("forwards a pointer event on a scene that has no globe", () => {
    // `pickGlobeHit` answers a globe-less scene with a WGS84 ellipsoid pick, so
    // the facade's cartographic conversion cannot assume `scene.globe` exists.
    const canvas = doc.createElement("canvas");
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    parent.appendChild(canvas);
    const sceneViewer = {
      canvas,
      scene: { canvas },
      camera: {
        heading: 0,
        pitch: -Math.PI / 2,
        getPickRay: (point: { x: number; y: number }) => ({ point }),
        pickEllipsoid: () => ({ lng: 42, lat: -7 }),
      },
      isDestroyed: () => false,
    };
    const Cesium = makeFakeCesium();
    Cesium.Ellipsoid.WGS84 = {
      cartesianToCartographic: (position: { lng: number; lat: number }) => ({
        longitude: position.lng * RADIANS,
        latitude: position.lat * RADIANS,
      }),
    } as never;
    const host = new CesiumControlHost(sceneViewer as never, parent, Cesium as never);
    const facade = facadeOf(host);
    const clicks: any[] = [];
    facade.on("click", (event: unknown) => clicks.push(event));
    const event = new doc.defaultView!.Event("click");
    Object.assign(event, { clientX: 5, clientY: 6 });
    canvas.dispatchEvent(event);
    assert.equal(clicks.length, 1);
    assert.ok(Math.abs(clicks[0].lngLat.lng - 42) < 1e-9);
    assert.ok(Math.abs(clicks[0].lngLat.lat - -7) < 1e-9);
    host.destroy();
  });

  it("skips the globe pick when no control listens for the event", () => {
    // mousemove fires every pointer frame and each pick is a terrain ray
    // intersection, so an unsubscribed event must not reach the scene at all.
    const sceneViewer = makeSceneViewer(doc);
    parent.appendChild(sceneViewer.canvas);
    sceneViewer.canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    let picks = 0;
    const getPickRay = sceneViewer.camera.getPickRay;
    sceneViewer.camera.getPickRay = (point: { x: number; y: number }) => {
      picks++;
      return getPickRay(point);
    };
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const facade = facadeOf(host);
    const move = new doc.defaultView!.Event("mousemove");
    Object.assign(move, { clientX: 5, clientY: 6 });
    sceneViewer.canvas.dispatchEvent(move);
    assert.equal(picks, 0);

    const moves: unknown[] = [];
    facade.on("mousemove", (event: unknown) => moves.push(event));
    sceneViewer.canvas.dispatchEvent(move);
    assert.equal(picks, 1);
    assert.equal(moves.length, 1);
    host.destroy();
  });

  it("projects and unprojects through the Cesium scene", () => {
    const sceneViewer = makeSceneViewer(doc);
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const facade = facadeOf(host);

    const point = facade.project([-122.4, 37.7]);
    assert.equal(point.x, 400);
    assert.equal(point.y, 300);

    const lngLat = facade.unproject([400, 300]);
    assert.ok(Math.abs(lngLat.lng - 12.5) < 1e-9);
    assert.ok(Math.abs(lngLat.lat - -3.25) < 1e-9);

    host.destroy();
  });

  it("answers off-screen for a coordinate the scene cannot place", () => {
    const sceneViewer = makeSceneViewer(doc);
    const host = new CesiumControlHost(
      sceneViewer as never,
      parent,
      makeFakeCesium({ project: undefined }) as never,
    );
    const facade = facadeOf(host);

    const point = facade.project([-122.4, 37.7]);
    assert.ok(point.x < 0 && point.y < 0, "a point behind the globe must read as off screen");
    host.destroy();
  });

  it("unprojects a screen point that misses the globe to the view centre", () => {
    const sceneViewer = makeSceneViewer(doc, { hit: false });
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const facade = facadeOf(host);

    const lngLat = facade.unproject([5, 5]);
    assert.equal(lngLat.lng, -122.4);
    assert.equal(lngLat.lat, 37.7);
    host.destroy();
  });

  it("reads the camera's view rectangle as MapLibre bounds", () => {
    const sceneViewer = makeSceneViewer(doc);
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const bounds = facadeOf(host).getBounds();

    assert.ok(Math.abs(bounds.getWest() - -10) < 1e-9);
    assert.ok(Math.abs(bounds.getSouth() - -20) < 1e-9);
    assert.ok(Math.abs(bounds.getEast() - 30) < 1e-9);
    assert.ok(Math.abs(bounds.getNorth() - 40) < 1e-9);
    host.destroy();
  });

  it("unwraps a view rectangle that crosses the antimeridian", () => {
    const sceneViewer = makeSceneViewer(doc);
    // Cesium reports west > east across the seam; MapLibre bounds must not.
    sceneViewer.camera.computeViewRectangle = () => ({
      west: (170 * Math.PI) / 180,
      south: 0,
      east: (-170 * Math.PI) / 180,
      north: (10 * Math.PI) / 180,
    });
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const bounds = facadeOf(host).getBounds();

    assert.ok(Math.abs(bounds.getWest() - 170) < 1e-9);
    assert.ok(Math.abs(bounds.getEast() - 190) < 1e-9);
    host.destroy();
  });

  it("falls back to the whole world when the camera cannot bound the globe", () => {
    const sceneViewer = makeSceneViewer(doc);
    sceneViewer.camera.computeViewRectangle = () => undefined as never;
    const host = new CesiumControlHost(sceneViewer as never, parent, makeFakeCesium() as never);
    const bounds = facadeOf(host).getBounds();

    assert.equal(bounds.getWest(), -180);
    assert.equal(bounds.getSouth(), -90);
    assert.equal(bounds.getEast(), 180);
    assert.equal(bounds.getNorth(), 90);
    host.destroy();
  });

  it("tracks primaryCesiumControlHost singleton", () => {
    assert.equal(getPrimaryCesiumControlHost(), null);
    const host = new CesiumControlHost(viewer as never, parent);
    setPrimaryCesiumControlHost(host);
    assert.equal(getPrimaryCesiumControlHost(), host);
    setPrimaryCesiumControlHost(null);
    assert.equal(getPrimaryCesiumControlHost(), null);
    host.destroy();
  });
});
