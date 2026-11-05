import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPresentationAnnotation,
  presentationAnnotationsCollection,
  presentationGeometry,
  presentationMeasurementLabel,
  type PresentationCoordinate,
} from "../apps/geolibre-desktop/src/lib/storymap-presentation-annotations";

describe("presentation annotations", () => {
  it("refuses unfinished geometry and repeated vertices", () => {
    assert.equal(presentationGeometry("line", [[117, 39]]), null);
    assert.equal(
      presentationGeometry("line", [
        [117, 39],
        [117, 39],
      ]),
      null,
    );
    assert.equal(
      presentationGeometry("polygon", [
        [117, 39],
        [118, 39],
      ]),
      null,
    );
    assert.equal(presentationGeometry("point", [[Number.NaN, 39]]), null);
    assert.equal(presentationGeometry("point", [[117, 91]]), null);
  });

  it("closes polygons without changing the draft or double-closing a ring", () => {
    const draft: PresentationCoordinate[] = [
      [117, 39],
      [117.01, 39],
      [117.01, 39.01],
    ];
    const geometry = presentationGeometry("polygon", draft);
    assert.equal(draft.length, 3);
    assert.equal(geometry?.type, "Polygon");
    if (geometry?.type !== "Polygon") throw new Error("expected Polygon");
    assert.deepEqual(geometry.coordinates[0][3], [117, 39]);
    assert.equal(presentationGeometry("area", [...draft, [117, 39]])?.type, "Polygon");
    geometry.coordinates[0][0][0] = 118;
    assert.equal(draft[0][0], 117);
  });

  it("keeps chapter ownership and measurement values when saving a result layer", () => {
    const line = createPresentationAnnotation(
      "distance",
      [
        [0, 0],
        [1, 0],
      ],
      "chapter-a",
      " Equator ",
      "distance-1",
    );
    assert.ok(line);
    assert.equal(line.properties.chapterId, "chapter-a");
    assert.equal(line.properties.label, "Equator");
    // 1° of the equator on WGS 84, 111,319.491 m (GeographicLib via pyproj).
    assert.ok(Math.abs(line.properties.distanceMeters! - 111319.491) < 0.001);
    assert.match(presentationMeasurementLabel(line, "en"), /111\.\d+ km/);
    const collection = presentationAnnotationsCollection([line]);
    collection.features[0].properties.label = "Changed in project";
    assert.equal(line.properties.label, "Equator");
    assert.equal(collection.features[0].properties.distanceMeters, line.properties.distanceMeters);
  });

  it("measures areas in square units and keeps ordinary annotations unmeasured", () => {
    const area = createPresentationAnnotation(
      "area",
      [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
      ],
      "a",
      "",
      "area-1",
    );
    assert.ok(area);
    // 1,230,907.205 m² on WGS 84 (GeographicLib via pyproj).
    assert.ok(Math.abs(area.properties.areaSquareMeters! - 1230907.205) < 0.001);
    assert.match(presentationMeasurementLabel(area, "en"), /km²$/);
    const point = createPresentationAnnotation("text", [[117, 39]], "b", "Site", "point-1");
    assert.ok(point);
    assert.equal(presentationMeasurementLabel(point, "en"), "");
    assert.equal(point.properties.areaSquareMeters, undefined);
  });
});
