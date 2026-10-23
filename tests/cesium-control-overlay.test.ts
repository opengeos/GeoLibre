import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import * as Cesium from "@cesium/engine";
import { useAppStore } from "@geolibre/core";
import {
  CesiumControlHost,
  mirrorSignature,
  restoreCompatibilityMouseEvents,
} from "../packages/map/src/cesium-control-host";
import {
  applyHorizonVisibility,
  cameraFacingTest,
  drawCesiumOverlayGraphics,
} from "../packages/map/src/cesium-control-overlay";
import { shadowOverlayGraphics } from "../packages/map/src/shadow-overlay";

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  Object.assign(globalThis, { document: originalDocument, HTMLElement: originalHTMLElement });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const square = {
  type: "Polygon" as const,
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

/** A widget with real Cesium data sources and a camera controller to toggle. */
function makeViewer(document: Document) {
  const canvas = document.createElement("canvas");
  const dataSources = new Cesium.DataSourceCollection();
  const screenSpaceCameraController = {
    enableRotate: true,
    enableTranslate: true,
    enableTilt: true,
    enableZoom: true,
    enableLook: true,
  };
  return {
    canvas,
    dataSources,
    scene: { canvas, screenSpaceCameraController, requestRender: () => {} },
    camera: { heading: 0, pitch: -Math.PI / 2 },
    isDestroyed: () => false,
  };
}

describe("drawCesiumOverlayGraphics", () => {
  it("draws fills, outlines, lines, circles and text as ground-clamped entities", () => {
    const source = new Cesium.CustomDataSource("test");
    const graphics = shadowOverlayGraphics(
      {
        sources: {
          cells: { type: "geojson", data: { type: "Feature", properties: {}, geometry: square } },
          pins: {
            type: "geojson",
            data: {
              type: "Feature",
              properties: { name: "Pin" },
              geometry: { type: "Point", coordinates: [0.5, 0.5] },
            },
          },
        },
        layers: [
          {
            id: "fill",
            type: "fill",
            source: "cells",
            paint: { "fill-color": "#0000ff", "fill-opacity": 0.5, "fill-outline-color": "#000" },
          },
          {
            id: "line",
            type: "line",
            source: "cells",
            paint: { "line-color": "#00ff00", "line-width": 3, "line-dasharray": [2, 2] },
          },
          {
            id: "dot",
            type: "circle",
            source: "pins",
            paint: { "circle-color": "#ff0000", "circle-radius": 4 },
          },
          {
            id: "text",
            type: "symbol",
            source: "pins",
            layout: { "text-field": ["get", "name"], "text-size": 14 },
            paint: { "text-halo-color": "#ffffff", "text-halo-width": 1 },
          },
        ] as never,
      },
      5,
      () => false,
    );
    drawCesiumOverlayGraphics(Cesium, source, graphics);
    const entities = source.entities.values;
    const time = Cesium.JulianDate.now();

    const polygon = entities.find((entity) => entity.polygon);
    assert.ok(polygon, "the fill draws a polygon");
    const fill = (polygon.polygon!.material as Cesium.ColorMaterialProperty).color!.getValue(time);
    assert.ok(fill.equalsEpsilon(new Cesium.Color(0, 0, 1, 0.5), 1e-6));

    const lines = entities.filter((entity) => entity.polyline);
    // The fill's outline ring plus the line layer's ring.
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(line.polyline!.clampToGround!.getValue(time), true);
    for (const line of lines)
      assert.equal(line.polyline!.arcType!.getValue(time), Cesium.ArcType.RHUMB);
    assert.ok(
      lines.some((line) => line.polyline!.material instanceof Cesium.PolylineDashMaterialProperty),
    );
    assert.ok(lines.some((line) => line.polyline!.width!.getValue(time) === 3));

    const point = entities.find((entity) => entity.point);
    assert.equal(point?.point!.pixelSize!.getValue(time), 8);
    assert.equal(
      point?.point!.heightReference!.getValue(time),
      Cesium.HeightReference.CLAMP_TO_GROUND,
    );

    const label = entities.find((entity) => entity.label);
    assert.equal(label?.label!.text!.getValue(time), "Pin");
    assert.equal(label?.label!.style!.getValue(time), Cesium.LabelStyle.FILL_AND_OUTLINE);
    assert.equal(label?.properties?.layerId.getValue(time), "text");
  });

  it("hides points and labels past the horizon in one pass, writing only changes", () => {
    const source = new Cesium.CustomDataSource("test");
    const point = (lng: number) => ({
      layerId: "p",
      featureId: String(lng),
      properties: {},
      geometry: { type: "Point" as const, coordinates: [lng, 0] },
      featureGeometry: { type: "Point" as const, coordinates: [lng, 0] },
      symbol: { type: "simple-marker", color: [0, 0, 0, 1], size: "8px" },
    });
    const anchored = drawCesiumOverlayGraphics(Cesium, source, [point(0), point(180)]);
    assert.equal(anchored.length, 2);
    // A camera far above (0°, 0°) sees the near point and not the antipode.
    const scene = {
      mode: Cesium.SceneMode.SCENE3D,
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 2e7) },
    };
    const facing = cameraFacingTest(Cesium, scene);
    assert.equal(applyHorizonVisibility(anchored, facing), true);
    assert.deepEqual(
      anchored.map(({ entity }) => entity.show),
      [true, false],
    );
    assert.equal(applyHorizonVisibility(anchored, facing), false, "a still pose writes nothing");
    // Flat scene modes show everything.
    scene.mode = Cesium.SceneMode.SCENE2D;
    applyHorizonVisibility(anchored, facing);
    assert.deepEqual(
      anchored.map(({ entity }) => entity.show),
      [true, true],
    );
  });

  it("replaces what the source held and skips degenerate geometry", () => {
    const source = new Cesium.CustomDataSource("test");
    const lineGraphic = (coordinates: number[][]) => ({
      layerId: "l",
      featureId: "0",
      properties: {},
      geometry: { type: "LineString" as const, coordinates },
      featureGeometry: { type: "LineString" as const, coordinates },
      symbol: { type: "simple-line", color: [0, 0, 0, 1], width: "1px" },
    });
    drawCesiumOverlayGraphics(Cesium, source, [
      lineGraphic([
        [0, 0],
        [1, 1],
      ]),
    ]);
    assert.equal(source.entities.values.length, 1);
    drawCesiumOverlayGraphics(Cesium, source, [lineGraphic([[0, 0]])]);
    assert.equal(source.entities.values.length, 0);
  });
});

describe("CesiumControlHost recording facade", () => {
  let doc: Document;
  let parent: HTMLElement;

  beforeEach(() => {
    const { document, window } = parseHTML("<html><body><div id='p'></div></body></html>");
    Object.assign(globalThis, { document, HTMLElement: window.HTMLElement });
    doc = document;
    parent = doc.getElementById("p")!;
    useAppStore.setState({
      layers: [],
      mapView: { center: [0, 0], zoom: 5, bearing: 0, pitch: 0 },
    } as never);
  });

  function mount(viewer: ReturnType<typeof makeViewer>, hooks?: object) {
    const host = new CesiumControlHost(viewer as never, parent, Cesium, hooks as never);
    return { host, map: host.getControlMap() as any };
  }

  it("draws a control's unmirrored GeoJSON layer and drops it once a store layer mirrors it", async () => {
    const viewer = makeViewer(doc);
    const { host, map } = mount(viewer);
    map.addSource("grid", {
      type: "geojson",
      data: { type: "Feature", properties: {}, geometry: square },
    });
    map.addLayer({
      id: "grid-line",
      type: "line",
      source: "grid",
      paint: { "line-color": "#f00" },
    });
    await flush();
    assert.equal(viewer.dataSources.length, 1);
    const overlay = viewer.dataSources.get(0) as Cesium.CustomDataSource;
    assert.equal(overlay.entities.values.length, 1);

    // A store record that lists the layer as its native layer is what the globe
    // draws; the host must not draw it a second time.
    useAppStore.setState({
      layers: [{ id: "mirror", metadata: { nativeLayerIds: ["grid-line"] } }],
    } as never);
    await flush();
    assert.equal(overlay.entities.values.length, 0);

    host.destroy();
    assert.equal(viewer.dataSources.length, 0);
  });

  it("redraws the overlay only when what decides mirroring changes", () => {
    const layer = { id: "a", opacity: 1, metadata: { sourceId: "s" } };
    const base = mirrorSignature([layer]);
    const faded = { ...layer, opacity: 0.4 };
    assert.equal(mirrorSignature([faded]), base, "an opacity drag");
    assert.notEqual(
      mirrorSignature([{ ...layer, metadata: { sourceId: "s", nativeLayerIds: ["x"] } }]),
      base,
    );
    assert.notEqual(mirrorSignature([layer, { id: "b", metadata: {} }]), base);
  });

  it("answers layer-scoped queries from the mirroring store layer", () => {
    const viewer = makeViewer(doc);
    const calls: string[] = [];
    const { host, map } = mount(viewer, {
      identify: (_lngLat: [number, number], layerId: string) => {
        calls.push(layerId);
        return [{ layerId, featureId: "7", properties: { a: 1 }, geometry: null }];
      },
      fitBounds: () => {},
    });
    map.addSource("footprints", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({ id: "footprints-fill", type: "fill", source: "footprints" });
    useAppStore.setState({
      layers: [{ id: "store-footprints", metadata: { sourceId: "footprints" } }],
    } as never);
    const hits = host.pickControlLayer([1, 2], "footprints-fill", "footprints");
    assert.deepEqual(calls, ["store-footprints"]);
    assert.equal(hits[0].featureId, "7");
    host.destroy();
  });

  it("keeps a hit tolerance next to the limb and across the antimeridian", () => {
    const viewer = makeViewer(doc);
    const { host } = mount(viewer);
    const internals = host as unknown as {
      facade: {
        project: () => { x: number; y: number };
        pickLngLat: (p: { x: number }) => unknown;
      };
      tolerance: (lngLat: [number, number]) => number;
    };
    internals.facade.project = () => ({ x: 100, y: 50 });
    // Right of the point is space; the left probe still answers.
    internals.facade.pickLngLat = ({ x }) => (x > 100 ? null : [9.5, 0]);
    assert.equal(internals.tolerance([10, 0]), 0.5);
    // A probe that wraps to the other side of the antimeridian.
    internals.facade.pickLngLat = ({ x }) => (x > 100 ? [-179.5, 0] : null);
    assert.equal(internals.tolerance([179.5, 0]), 1);
    host.destroy();
  });

  it("suspends and restores the globe's drag inputs through dragPan", () => {
    const viewer = makeViewer(doc);
    const { host, map } = mount(viewer);
    const camera = viewer.scene.screenSpaceCameraController;
    camera.enableTilt = false;
    map.dragPan.disable();
    assert.equal(map.dragPan.isEnabled(), false);
    assert.equal(camera.enableRotate, false);
    assert.equal(camera.enableTranslate, false);
    map.dragPan.enable();
    assert.equal(camera.enableRotate, true);
    // An input that was already off stays off.
    assert.equal(camera.enableTilt, false);
    host.destroy();
  });

  it("frames an extent through the engine", () => {
    const viewer = makeViewer(doc);
    const framed: number[][] = [];
    const { host, map } = mount(viewer, {
      identify: () => [],
      fitBounds: (bounds: number[]) => framed.push(bounds),
    });
    map.fitBounds([
      [-10, -5],
      [10, 5],
    ]);
    assert.deepEqual(framed, [[-10, -5, 10, 5]]);
    host.destroy();
  });
});

describe("restoreCompatibilityMouseEvents", () => {
  /** A window and canvas from Node's own EventTarget, with a MouseEvent that keeps its init. */
  function fakeDom() {
    class FakeMouseEvent extends Event {
      clientX: number;
      button: number;
      constructor(type: string, init: { clientX?: number; button?: number } & EventInit) {
        super(type, init);
        this.clientX = init.clientX ?? 0;
        this.button = init.button ?? 0;
      }
    }
    const view = Object.assign(new EventTarget(), {
      MouseEvent: FakeMouseEvent,
      Node: EventTarget,
    });
    const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: view } });
    // Bubble the canvas's events to the window, as the DOM does.
    const dispatch = canvas.dispatchEvent.bind(canvas);
    canvas.dispatchEvent = (event: Event) => {
      const result = dispatch(event);
      if (event.bubbles)
        view.dispatchEvent(new (event.constructor as typeof Event)(event.type, event));
      return result;
    };
    const pointer = (type: string, init: { cancel?: boolean; clientX?: number } = {}) => {
      const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
        pointerType: "mouse",
        pointerId: 1,
        clientX: init.clientX ?? 0,
        button: 0,
      });
      // Cesium's own handler on the canvas cancels the press.
      if (init.cancel) event.preventDefault();
      Object.defineProperty(event, "target", { value: canvas });
      view.dispatchEvent(event);
    };
    return { view, canvas, pointer };
  }

  it("re-dispatches the mouse events a cancelled press suppresses, and stops on release", () => {
    const { canvas, view, pointer } = fakeDom();
    const seen: string[] = [];
    for (const type of ["mousedown", "mousemove", "mouseup"])
      canvas.addEventListener(type, (event) =>
        seen.push(`${type}@${(event as MouseEvent).clientX}`),
      );
    const windowSeen: string[] = [];
    view.addEventListener("mouseup", () => windowSeen.push("mouseup"));
    const dispose = restoreCompatibilityMouseEvents(canvas as never);
    pointer("pointerdown", { cancel: true, clientX: 1 });
    pointer("pointermove", { clientX: 2 });
    pointer("pointerup", { clientX: 3 });
    pointer("pointermove", { clientX: 4 });
    assert.deepEqual(seen, ["mousedown@1", "mousemove@2", "mouseup@3"]);
    // Bubbled, so a control listening on the window for the release hears it.
    assert.deepEqual(windowSeen, ["mouseup"]);
    dispose();
  });

  it("leaves a press nothing cancelled to the browser's own mouse events", () => {
    const { canvas, pointer } = fakeDom();
    const seen: string[] = [];
    canvas.addEventListener("mousedown", () => seen.push("mousedown"));
    const dispose = restoreCompatibilityMouseEvents(canvas as never);
    pointer("pointerdown");
    assert.deepEqual(seen, []);
    dispose();
    pointer("pointerdown", { cancel: true });
    assert.deepEqual(seen, [], "no listeners after dispose");
  });
});
