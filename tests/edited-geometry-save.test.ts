import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createEmptyProject,
  parseProject,
  projectFromStore,
  serializeProject,
} from "@geolibre/core";
import {
  discardEditedWfsGeometry,
  embedEditedGeometry,
  hasEditedGeometry,
  markAttributeEdit,
} from "../apps/geolibre-desktop/src/lib/edited-geometry-save";
import { calculateField } from "../apps/geolibre-desktop/src/lib/attribute-columns";
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

it("keeps edited WFS references only when the user chooses no embedding", () => {
  const editedGeojson = {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { name: "Edited" },
        geometry: { type: "Point" as const, coordinates: [1, 2] as [number, number] },
      },
    ],
  };
  const layer = geojsonLayer({
    geojson: editedGeojson,
    source: { type: "geojson", url: "https://example.com/wfs?request=GetFeature" },
    metadata: { sourceKind: "wfs-getfeature", geometryEdited: true },
  });
  const referenced = discardEditedWfsGeometry(layer);
  const project = createEmptyProject();
  const saved = projectFromStore({
    ...project,
    projectName: project.name,
    layers: [referenced],
  });

  assert.deepEqual(layer.geojson, editedGeojson, "the live layer remains unchanged");
  assert.equal(referenced.source.url, layer.source.url);
  assert.equal(referenced.geojson, undefined);
  assert.equal(referenced.metadata.geometryEdited, undefined);
  const reopened = parseProject(serializeProject(saved)).layers[0];
  assert.equal(reopened.source.url, layer.source.url);
  assert.equal(reopened.geojson, undefined);
});

it("preserves edited WFS features when no-embed has no reload URL", () => {
  const original = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "First edit" },
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    },
    source: { type: "geojson", url: "https://example.com/wfs?request=GetFeature" },
    metadata: { sourceKind: "wfs-getfeature", geometryEdited: true },
  });
  const embedded = embedEditedGeometry(original);
  const editedAgain = {
    ...embedded,
    geojson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { name: "Second edit" },
          geometry: { type: "Point" as const, coordinates: [3, 4] as [number, number] },
        },
      ],
    },
    metadata: { ...embedded.metadata, geometryEdited: true },
  };
  const noEmbed = discardEditedWfsGeometry(editedAgain);
  const project = createEmptyProject();
  const saved = projectFromStore({
    ...project,
    projectName: project.name,
    layers: [noEmbed],
  });
  const reopened = parseProject(serializeProject(saved)).layers[0];

  assert.deepEqual(noEmbed.geojson, editedAgain.geojson);
  assert.deepEqual(reopened.geojson, editedAgain.geojson);
  assert.equal(reopened.source.url, undefined);
});

it("keeps edited WFS features when only metadata.originalUrl looks reloadable", () => {
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Edited" },
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    },
    source: { type: "geojson" },
    metadata: {
      sourceKind: "wfs-getfeature",
      geometryEdited: true,
      originalUrl: "https://example.com/wfs",
    },
  });

  // Hydration re-fetches from the layer's own HTTP(S) `source.url`; a
  // `metadata.originalUrl` (a tile-layer field) restores nothing, so a no-embed
  // save must keep the only copy of the features.
  assert.equal(discardEditedWfsGeometry(layer), layer);
});

it("scrubs plugin WFS URL credentials and embeds the collection on save", () => {
  const url =
    "https://alice:secret@example.com/wfs?service=WFS&request=GetFeature&token=secret-token&api_key=secret-key";
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Saved" },
          geometry: { type: "Point", coordinates: [1, 2] },
        },
      ],
    },
    source: { type: "geojson", url },
    sourcePath: url,
    metadata: { sourceKind: "wfs-getfeature", geometryEdited: true },
  });
  const project = createEmptyProject();
  const saved = projectFromStore({
    ...project,
    projectName: project.name,
    layers: [discardEditedWfsGeometry(layer)],
  });
  const serialized = serializeProject(saved);
  const reopened = parseProject(serialized).layers[0];
  const cleanUrl = "https://example.com/wfs?service=WFS&request=GetFeature";

  assert.doesNotMatch(serialized, /alice|secret-token|secret-key|token=|api_key=/);
  assert.equal(reopened.source.url, undefined, "edited WFS saves omit the re-fetch URL");
  assert.equal(reopened.sourcePath, cleanUrl);
  assert.deepEqual(reopened.geojson, layer.geojson);
  const unedited = { ...layer, metadata: { sourceKind: "wfs-getfeature" } };
  const uneditedSaved = projectFromStore({
    ...project,
    projectName: project.name,
    layers: [unedited],
  });
  const uneditedSerialized = serializeProject(uneditedSaved);
  const uneditedReopened = parseProject(uneditedSerialized).layers[0];
  assert.doesNotMatch(uneditedSerialized, /alice|secret-token|secret-key|token=|api_key=/);
  assert.equal(uneditedReopened.source.url, cleanUrl);
  assert.equal(uneditedReopened.sourcePath, cleanUrl);
  assert.deepEqual(uneditedReopened.geojson, layer.geojson);
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

function countyLayer(patch: Parameters<typeof geojsonLayer>[0] = {}) {
  return geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "f1",
          properties: { NAME: "White Pine" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-115, 39],
                [-114, 39],
                [-114, 40],
                [-115, 40],
                [-115, 39],
              ],
            ],
          },
        },
      ],
    },
    ...patch,
  });
}

it("keeps a Field Calculator field on an Add Vector Layer URL layer through save and reopen", () => {
  // Add Data -> Vector layer with a URL adopts the layer into the store. Before
  // the fix, a save kept only the URL, so the calculated column vanished on
  // reopen without any prompt.
  const url = "https://example.com/nv_counties.geojson";
  const layer = countyLayer({
    source: { type: "geojson", url },
    sourcePath: url,
    metadata: { sourceKind: "maplibre-gl-vector-adopted" },
  });
  const result = calculateField(layer, ["NAME"], "area_km2", true, "$area() / 1e6", "number");
  assert.ok(result && "patch" in result);
  const patch = markAttributeEdit(layer, result.patch);
  assert.equal(patch.metadata?.geometryEdited, true);
  // `updateLayer` replaces metadata wholesale: the flag must not drop the rest.
  assert.equal(patch.metadata?.sourceKind, "maplibre-gl-vector-adopted");
  const edited = { ...layer, ...patch };
  assert.equal(hasEditedGeometry(edited), true, "the save prompt must offer to embed it");

  const project = createEmptyProject();
  const saveAndReopen = (saved: typeof edited) =>
    parseProject(
      serializeProject(
        projectFromStore({ ...project, projectName: project.name, layers: [saved] }),
      ),
    ).layers[0];
  const referenceOnly = saveAndReopen(edited);
  assert.equal(referenceOnly.geojson, undefined, "a reference save carries only the URL");

  const restored = saveAndReopen(embedEditedGeometry(edited));
  const area = restored.geojson?.features[0].properties?.area_km2;
  assert.equal(typeof area, "number");
  assert.ok((area as number) > 1000, `expected a county-sized area, got ${area}`);
  assert.equal(restored.source.url, undefined, "reopen must not refetch the original data");
});

it("marks attribute edits only on layers that reload their features from a source", () => {
  const edit = (layer: ReturnType<typeof countyLayer>) =>
    markAttributeEdit(layer, { geojson: structuredClone(layer.geojson) }).metadata?.geometryEdited;
  const urlLayer = countyLayer({ source: { type: "geojson", url: "https://e.x/a.geojson" } });
  assert.equal(edit(urlLayer), true);
  assert.equal(edit(countyLayer({ metadata: { sourceKind: "maplibre-gl-vector" } })), true);
  assert.equal(edit(countyLayer({ sourcePath: "/data/counties.geojson" })), true);
  // An embedded layer (a web drop, a processing output) already saves its edits.
  assert.equal(edit(countyLayer()), undefined);
  assert.equal(edit(countyLayer({ sourcePath: "counties.geojson" })), undefined);
  // View-only patches (no feature data) are never edits.
  const viewPatch = { fieldVisibility: { NAME: "hidden" as const } };
  assert.equal(markAttributeEdit(urlLayer, viewPatch), viewPatch);
});
