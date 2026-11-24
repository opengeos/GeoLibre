import assert from "node:assert/strict";
import { it } from "node:test";
import { geojsonLayer } from "./helpers/layer-fixtures";
import {
  fieldsOf,
  hasPolygons,
  selectImportVectorLayers,
} from "../apps/geolibre-desktop/src/lib/obia/obia-import-layers";

it("lists importable vectors, filters object layers, and preserves slices on restyling", () => {
  const input = geojsonLayer();
  const objects = geojsonLayer({ id: "objects", metadata: { obiaRole: "objects" } });
  const select = selectImportVectorLayers();
  const first = select({ layers: [input, objects] });
  assert.deepEqual(
    first.map((layer) => layer.id),
    [input.id],
  );
  assert.equal(select({ layers: [{ ...input, opacity: 0.2 }, objects] })[0], first[0]);
  assert.notEqual(selectImportVectorLayers()({ layers: [input] })[0], first[0]);
});

it("detects polygon inputs and samples their property names", () => {
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          properties: { object_id: 1 },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: { class_name: "forest" },
        },
      ],
    },
  });
  assert.equal(hasPolygons(layer), true);
  assert.equal(hasPolygons(geojsonLayer()), false);
  assert.deepEqual(fieldsOf(layer), ["object_id", "class_name"]);
  assert.deepEqual(fieldsOf(undefined), []);
});
