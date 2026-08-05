import { test, describe } from "node:test";
import assert from "node:assert";
import type { GeoLibreProject } from "@geolibre/core";
import { excludeHiddenFieldsFromProject } from "../packages/core/src/visibility";

describe("visibility", () => {
  test("excludeHiddenFieldsFromProject strips excluded fields from geojson and embeddedGeoJSON", () => {
    const project: GeoLibreProject = {
      id: "proj-1",
      name: "Test",
      version: 1,
      viewState: {
        longitude: 0,
        latitude: 0,
        zoom: 0,
        pitch: 0,
        bearing: 0,
      },
      layers: [
        {
          id: "layer-1",
          name: "Layer",
          type: "geojson",
          visible: true,
          metadata: {
            embeddedGeoJSON: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: { type: "Point", coordinates: [0, 0] },
                  properties: { keep: 1, drop: 2 },
                },
              ],
            },
          },
          fieldVisibility: { drop: "excluded" },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [0, 0] },
                properties: { keep: 1, drop: 2 },
              },
            ],
          },
        },
      ],
    };

    const stripped = excludeHiddenFieldsFromProject(project);

    // Check main geojson
    const feature1 = stripped.layers[0].geojson!.features[0];
    assert.strictEqual(feature1.properties?.keep, 1);
    assert.strictEqual(feature1.properties?.drop, undefined);

    // Check embedded geojson
    const embeddedFeature = (stripped.layers[0].metadata.embeddedGeoJSON as any).features[0];
    assert.strictEqual(embeddedFeature.properties?.keep, 1);
    assert.strictEqual(embeddedFeature.properties?.drop, undefined);
  });
});
