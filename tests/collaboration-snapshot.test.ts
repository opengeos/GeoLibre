import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { prepareCollaborationLayers } from "../apps/geolibre-desktop/src/lib/collaboration-layers";
import { geojsonLayer } from "./helpers/layer-fixtures";

const FEATURES: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "shared" },
      geometry: { type: "Point", coordinates: [1, 2] },
    },
  ],
};

describe("collaboration vector snapshots", () => {
  it("makes path-backed plain GeoJSON portable", () => {
    const layer = geojsonLayer({
      id: "plain-local",
      geojson: FEATURES,
      metadata: { localFileReloadable: true },
    });

    const [portable] = prepareCollaborationLayers([layer], new Map());

    assert.equal(portable.metadata.localFileReloadable, undefined);
    assert.equal(portable.geojson, FEATURES);
  });

  it("embeds control-managed local vectors for collaborators", () => {
    const layer = geojsonLayer({
      id: "control-local",
      geojson: undefined,
      metadata: {
        externalNativeLayer: true,
        sourceKind: "maplibre-gl-vector",
        localFileReloadable: true,
      },
    });

    const [portable] = prepareCollaborationLayers([layer], new Map([["control-local", FEATURES]]));

    assert.equal(portable.metadata.localFileReloadable, undefined);
    assert.equal(portable.metadata.embeddedGeoJSON, FEATURES);
  });
});
