import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createEmptyProject,
  parseProject,
  projectFromStore,
  serializeProject,
} from "@geolibre/core";
import { embedEditedGeometry } from "../apps/geolibre-desktop/src/lib/edited-geometry-save";
import { geometryEditPatch } from "../packages/plugins/src/plugins/geo-editor-geometry";
import { geojsonLayer } from "./helpers/layer-fixtures";

for (const vectorControl of [false, true]) {
  it(`round-trips edited URL geometries (${vectorControl ? "vector control" : "native"})`, () => {
    const layer = geojsonLayer({
      source: { type: "geojson", url: "https://example.com/buildings.geojson" },
      metadata: {
        externalNativeLayer: true,
        sourceKind: vectorControl ? "maplibre-gl-vector" : "geojson-url",
        originalUrl: "https://example.com/buildings.geojson",
        geometryEdited: true,
      },
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-115, 36] } },
        ],
      },
    });
    const project = createEmptyProject();
    const saved = projectFromStore({
      ...project,
      projectName: project.name,
      layers: [embedEditedGeometry(layer)],
    });
    const restored = parseProject(serializeProject(saved)).layers[0];
    assert.deepEqual(
      vectorControl ? restored.metadata.embeddedGeoJSON : restored.geojson,
      layer.geojson,
    );
    assert.equal(restored.source.url, undefined, "reopen must not fetch the original geometry");
    assert.equal(
      layer.source.url,
      "https://example.com/buildings.geojson",
      "saving must not mutate the live source",
    );
  });
}

it("preserves an empty edited layer and clears local reload precedence", () => {
  const layer = geojsonLayer({
    sourcePath: "/tmp/buildings.geojson",
    metadata: { geometryEdited: true, localFileReloadable: true },
  });
  const embedded = embedEditedGeometry(layer);
  assert.deepEqual(embedded.geojson?.features, []);
  assert.equal(embedded.metadata.localFileReloadable, undefined);
  assert.equal(embedded.metadata.geometryEdited, undefined);
  assert.equal(layer.metadata.localFileReloadable, true);
});

it("leaves unedited URL layers as references", () => {
  const layer = geojsonLayer({
    source: { type: "geojson", url: "https://example.com/buildings.geojson" },
  });
  assert.equal(embedEditedGeometry(layer), layer);
});

it("marks committed changes but not a no-op editor session", () => {
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } },
      ],
    },
  });
  assert.equal(
    geometryEditPatch(layer, structuredClone(layer.geojson!)).metadata.geometryEdited,
    undefined,
  );
  const edited = structuredClone(layer.geojson!);
  edited.features[0].geometry = { type: "Point", coordinates: [3, 4] };
  assert.equal(geometryEditPatch(layer, edited).metadata.geometryEdited, true);
  assert.equal(
    geometryEditPatch(layer, { type: "FeatureCollection", features: [] }).metadata.geometryEdited,
    true,
  );
  const previouslyEdited = { ...layer, ...geometryEditPatch(layer, edited) };
  assert.equal(geometryEditPatch(previouslyEdited, edited).metadata.geometryEdited, true);
});
