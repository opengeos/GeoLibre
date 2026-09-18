import assert from "node:assert/strict";
import { it } from "node:test";
import * as C from "@cesium/engine";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "../packages/core/src/types";
import { createCesiumLabeler, pickLabelPart } from "../packages/map/src/cesium-labels";
import { zoomToOrthoWidth } from "../packages/map/src/cesium-camera";

const time = C.JulianDate.now();
const viewer = {
  clock: { currentTime: time },
  camera: { frustum: { fovy: Math.PI / 3 } },
  scene: { canvas: { clientHeight: 600 }, globe: { ellipsoid: C.Ellipsoid.WGS84 } },
} as C.CesiumWidget;
function layer(): GeoLibreLayer {
  return {
    id: "cities",
    name: "Cities",
    type: "geojson",
    source: {},
    metadata: {},
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      labels: { ...DEFAULT_LAYER_STYLE.labels, enabled: true, field: "name", minZoom: 4 },
    },
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Knoxville" },
          geometry: { type: "Point", coordinates: [-83.9, 35.9] },
        },
      ],
    },
  };
}
it("uses label settings, expressions, halos and a ground anchor with distance limits", () => {
  const l = layer();
  l.style.labels.expression = '["concat", ["get", "name"], " city"]';
  const entity = new C.Entity({ position: C.Cartesian3.fromDegrees(-83.9, 35.9) });
  createCesiumLabeler(C, viewer, l)(entity, 0);
  assert.equal(entity.label?.text?.getValue(time), "Knoxville city");
  assert.equal(entity.label?.font?.getValue(time), "13px sans-serif");
  assert.equal(entity.label?.heightReference?.getValue(time), C.HeightReference.CLAMP_TO_GROUND);
  assert.equal(entity.label?.outlineWidth?.getValue(time), 1.5);
  const condition = entity.label?.distanceDisplayCondition?.getValue(time);
  assert.equal(condition.near, 0);
  assert.ok(Number.isFinite(condition.far) && condition.far > 0);
});
it("tracks the canvas height so a pane resize keeps zoom limits honest", () => {
  const canvas = { clientHeight: 600 };
  const resizable = { ...viewer, scene: { ...viewer.scene, canvas } } as C.CesiumWidget;
  const entity = new C.Entity({ position: C.Cartesian3.fromDegrees(-83.9, 35.9) });
  createCesiumLabeler(C, resizable, layer())(entity, 0);
  const before = entity.label!.distanceDisplayCondition!.getValue(time).far;
  canvas.clientHeight = 1200;
  const after = entity.label!.distanceDisplayCondition!.getValue(time).far;
  assert.ok(Math.abs(after / before - 2) < 1e-9);
});
it("anchors polygons on the ellipsoid and lines halfway along their length", () => {
  const l = layer();
  const polygon = new C.Entity({
    polygon: { hierarchy: C.Cartesian3.fromDegreesArray([-1, -1, 1, -1, 1, 1, -1, 1]) },
  });
  createCesiumLabeler(C, viewer, l)(polygon, 0);
  const position = polygon.position!.getValue(time)!;
  assert.ok(Math.abs(C.Cartographic.fromCartesian(position).height) < 0.01);
  const points = C.Cartesian3.fromDegreesArray([0, 0, 1, 0, 3, 0]);
  const line = new C.Entity({ polyline: { positions: points } });
  createCesiumLabeler(C, viewer, l)(line, 0);
  const midpoint = C.Cartographic.fromCartesian(line.position!.getValue(time)!);
  assert.ok(Math.abs(C.Math.toDegrees(midpoint.longitude) - 1.5) < 0.01);
  // An empty zoom range yields no label, and then the polygon must not be
  // given an anchor position it did not have.
  l.style.labels.maxZoom = l.style.labels.minZoom;
  const unlabeled = new C.Entity({
    polygon: { hierarchy: C.Cartesian3.fromDegreesArray([-1, -1, 1, -1, 1, 1, -1, 1]) },
  });
  createCesiumLabeler(C, viewer, l)(unlabeled, 0);
  assert.equal(unlabeled.label, undefined);
  assert.equal(unlabeled.position, undefined);
});
it("skips disabled, missing and invalid expression labels without breaking the layer", () => {
  const l = layer();
  const make = () => new C.Entity({ position: C.Cartesian3.fromDegrees(0, 0) });
  l.style.labels.enabled = false;
  let entity = make();
  createCesiumLabeler(C, viewer, l)(entity, 0);
  assert.equal(entity.label, undefined);
  l.style.labels.enabled = true;
  l.style.labels.field = "absent";
  entity = make();
  createCesiumLabeler(C, viewer, l)(entity, 0);
  assert.equal(entity.label, undefined);
  l.style.labels.expression = '["to-number", ["get", "name"]]';
  createCesiumLabeler(C, viewer, l)(entity, 0);
  assert.equal(entity.label, undefined);
});
it("measures the 2D scene against half the orthographic frustum width", () => {
  const scene = { ...viewer.scene, mode: C.SceneMode.SCENE2D, canvas: { clientWidth: 800 } };
  const flat = { ...viewer, scene } as C.CesiumWidget;
  const entity = new C.Entity({ position: C.Cartesian3.fromDegrees(-83.9, 35.9) });
  createCesiumLabeler(C, flat, layer())(entity, 0);
  const far = entity.label!.distanceDisplayCondition!.getValue(time).far;
  assert.ok(Math.abs(far - zoomToOrthoWidth(4, 800) / 2) < 1e-6);
});
it("labels a multipart feature once, on its largest polygon or longest line", () => {
  const polygon = (coords: number[]) =>
    new C.Entity({ polygon: { hierarchy: C.Cartesian3.fromDegreesArray(coords) } });
  const islet = polygon([10, 10, 10.01, 10, 10.01, 10.01, 10, 10.01]);
  const mainland = polygon([0, 0, 2, 0, 2, 2, 0, 2]);
  assert.equal(pickLabelPart(C, viewer, [islet, mainland]), mainland);
  const line = (coords: number[]) =>
    new C.Entity({ polyline: { positions: C.Cartesian3.fromDegreesArray(coords) } });
  const stub = line([0, 0, 0.1, 0]);
  const trunk = line([0, 0, 5, 0]);
  assert.equal(pickLabelPart(C, viewer, [trunk, stub]), trunk);
  const point = new C.Entity({ position: C.Cartesian3.fromDegrees(0, 0) });
  assert.equal(pickLabelPart(C, viewer, [point, islet]), islet);
  assert.equal(pickLabelPart(C, viewer, [point]), point);
});
it("re-evaluates a zoom-dependent expression as the camera zoom changes", () => {
  const l = layer();
  l.style.labels.expression = '["step", ["zoom"], "", 6, ["get", "name"], 10, "KNX"]';
  let zoom = 3;
  const camera = {
    frustum: { fovy: Math.PI / 3 },
    positionWC: new C.Cartesian3(1, 2, 3),
    directionWC: new C.Cartesian3(0, 0, -1),
  };
  const canvas = { clientWidth: 800, clientHeight: 600 };
  const live = {
    ...viewer,
    camera,
    scene: { ...viewer.scene, canvas },
  } as unknown as C.CesiumWidget;
  const entity = new C.Entity({ position: C.Cartesian3.fromDegrees(-83.9, 35.9) });
  createCesiumLabeler(C, live, l, () => zoom)(entity, 0);
  // Empty at this zoom, but the label stays so a later zoom can fill it in.
  assert.equal(entity.label?.text?.getValue(time), "");
  // The reader is memoised on the camera pose: a zoom change with the camera
  // still is not seen until the camera moves.
  zoom = 8;
  assert.equal(entity.label?.text?.getValue(time), "");
  camera.positionWC = new C.Cartesian3(1, 2, 4);
  assert.equal(entity.label?.text?.getValue(time), "Knoxville");
  zoom = 12;
  camera.directionWC = new C.Cartesian3(0, 1, 0);
  assert.equal(entity.label?.text?.getValue(time), "KNX");
  // A pane resize changes the zoom a still camera shows, so it re-reads too.
  zoom = 8;
  canvas.clientHeight = 300;
  assert.equal(entity.label?.text?.getValue(time), "Knoxville");
  // A static expression still drops an empty label outright.
  l.style.labels.expression = '["get", "absent"]';
  const empty = new C.Entity({ position: C.Cartesian3.fromDegrees(-83.9, 35.9) });
  createCesiumLabeler(C, live, l, () => zoom)(empty, 0);
  assert.equal(empty.label, undefined);
});
