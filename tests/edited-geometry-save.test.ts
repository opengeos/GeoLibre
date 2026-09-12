import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createEmptyProject,
  parseProject,
  projectFromStore,
  serializeProject,
} from "@geolibre/core";
import {
  embedEditedGeometry,
  hasEditedGeometry,
} from "../apps/geolibre-desktop/src/lib/edited-geometry-save";
import {
  geometryEditMetadata,
  tagFeatureKeys,
  captureEditedGeometries,
  reconcileEditedFeatures,
} from "../packages/plugins/src/plugins/geo-editor-geometry";
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
  const baseline = captureEditedGeometries(tagFeatureKeys(layer.geojson!));
  const unchanged = tagFeatureKeys(layer.geojson!);
  assert.equal(geometryEditMetadata(layer, unchanged, baseline).geometryEdited, undefined);
  const edited = structuredClone(unchanged);
  edited.features[0].geometry = { type: "Point", coordinates: [3, 4] };
  assert.equal(geometryEditMetadata(layer, edited, baseline).geometryEdited, true);
  assert.equal(
    geometryEditMetadata(layer, { type: "FeatureCollection", features: [] }, baseline)
      .geometryEdited,
    true,
  );
  const previouslyEdited = { ...layer, metadata: geometryEditMetadata(layer, edited, baseline) };
  assert.equal(geometryEditMetadata(previouslyEdited, edited, baseline).geometryEdited, true);
});

for (const localFile of [false, true]) {
  it(`does not persist an edit flag when saving ${localFile ? "file" : "URL"} references`, () => {
    const layer = geojsonLayer({
      source: {
        type: "geojson",
        ...(localFile ? {} : { url: "https://example.com/buildings.geojson" }),
      },
      metadata: {
        geometryEdited: true,
        externalNativeLayer: !localFile,
        localFileReloadable: localFile,
      },
    });
    const project = createEmptyProject();
    const saved = projectFromStore({ ...project, projectName: project.name, layers: [layer] });
    const restored = parseProject(serializeProject(saved)).layers[0];
    assert.equal(restored.geojson, undefined);
    assert.equal(restored.metadata.geometryEdited, undefined);
    assert.equal(hasEditedGeometry({ ...restored, geojson: layer.geojson }), false);
    assert.equal(layer.metadata.geometryEdited, true, "saving must retain the live edit warning");
  });
}

it("compares reconciled geometry identities independently of editor order", () => {
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2] } },
        { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [3, 4] } },
      ],
    },
  });
  const tagged = tagFeatureKeys(layer.geojson!);
  const reordered = { ...tagged, features: [...tagged.features].reverse() };
  const baseline = captureEditedGeometries(tagged);
  assert.equal(geometryEditMetadata(layer, reordered, baseline).geometryEdited, undefined);
  // Swapping feature geometries must still count as edits even when their
  // coordinate array order now happens to match the original collection.
  [reordered.features[0].geometry, reordered.features[1].geometry] = [
    reordered.features[1].geometry,
    reordered.features[0].geometry,
  ];
  assert.equal(geometryEditMetadata(layer, reordered, baseline).geometryEdited, true);
});

it("marks a recreated feature even when reconciliation reuses its id and geometry", () => {
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "original" },
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    },
  });
  const tagged = tagFeatureKeys(layer.geojson!);
  const baseline = captureEditedGeometries(tagged);
  const replacement = structuredClone(layer.geojson!);
  replacement.features[0].properties = { name: "replacement" };
  const reconciled = reconcileEditedFeatures(replacement);
  assert.equal(reconciled.features[0].id, tagged.features[0].id);
  assert.deepEqual(reconciled.features[0].geometry, tagged.features[0].geometry);
  assert.equal(geometryEditMetadata(layer, replacement, baseline).geometryEdited, true);
});
