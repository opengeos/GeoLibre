import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import { type GeoLibreLayer, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  flyToGeocodeMatch,
  selectAndFitLayer,
  selectFeatureMatch,
} from "../apps/geolibre-desktop/src/lib/search-actions";
import { POINT_RESULT_ZOOM } from "../apps/geolibre-desktop/src/lib/geocode-camera";

/** A map engine stub that records the camera and highlight calls it gets. */
function stubEngine(
  options: { kind?: string; fits?: boolean; outsideMapCrs?: boolean; zoom?: number } = {},
) {
  const calls: unknown[][] = [];
  const engine = {
    kind: options.kind ?? "maplibre",
    readView: () => ({ center: [0, 0], zoom: options.zoom ?? 3 }),
    fitBounds: (bounds: unknown) => calls.push(["fitBounds", bounds]),
    flyTo: (camera: unknown) => calls.push(["flyTo", camera]),
    fitLayer: (layer: GeoLibreLayer) => {
      calls.push(["fitLayer", layer.id]);
      return options.fits ?? true;
    },
    isLayerOutsideMapCrs: () => options.outsideMapCrs ?? false,
    highlightFeature: (layer: GeoLibreLayer, featureId: string, opts: unknown) =>
      calls.push(["highlightFeature", layer.id, featureId, opts]),
  } as unknown as MapEngine;
  return { engine, calls };
}

const PARCELS: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "a",
      properties: { pin: "14-200-001" },
      geometry: { type: "Point", coordinates: [-9.14, 38.72] },
    },
  ],
};

/** Add a GeoJSON layer to a fresh project and return its id. */
function addParcels(): string {
  return useAppStore.getState().addGeoJsonLayer("Parcels", PARCELS);
}

describe("search actions", () => {
  beforeEach(() => {
    useAppStore.getState().newProject({ name: "Search actions" });
  });

  it("selects a matched feature on its layer and frames it", () => {
    const layerId = addParcels();
    const { engine, calls } = stubEngine();
    assert.equal(selectFeatureMatch(engine, { layerId, featureId: "a" }), true);
    const state = useAppStore.getState();
    assert.equal(state.selectedLayerId, layerId);
    assert.deepEqual(state.selectedFeatureIds, ["a"]);
    assert.deepEqual(calls, [["highlightFeature", layerId, "a", { fit: true }]]);
  });

  it("selects nothing for a feature whose layer has been removed", () => {
    const { engine, calls } = stubEngine();
    assert.equal(selectFeatureMatch(engine, { layerId: "gone", featureId: "a" }), false);
    assert.equal(useAppStore.getState().selectedLayerId, null);
    assert.deepEqual(calls, []);
  });

  it("selects a layer and frames it", () => {
    const layerId = addParcels();
    const { engine, calls } = stubEngine();
    assert.equal(selectAndFitLayer(engine, layerId), null);
    assert.equal(useAppStore.getState().selectedLayerId, layerId);
    assert.deepEqual(calls, [["fitLayer", layerId]]);
  });

  it("says why a layer could not be framed, and still selects it", () => {
    const layerId = addParcels();
    assert.equal(selectAndFitLayer(stubEngine({ fits: false }).engine, layerId), "unknownExtent");
    assert.equal(
      selectAndFitLayer(stubEngine({ fits: false, outsideMapCrs: true }).engine, layerId),
      "outsideMapCrs",
    );
    assert.equal(useAppStore.getState().selectedLayerId, layerId);
    assert.equal(selectAndFitLayer(stubEngine().engine, "gone"), "missing");
  });

  it("frames a place's extent when the geocoder reports one", () => {
    const { engine, calls } = stubEngine();
    flyToGeocodeMatch(engine, {
      lat: 38.72,
      lon: -9.14,
      displayName: "Lisbon",
      score: null,
      bbox: [-9.23, 38.69, -9.09, 38.8],
    });
    assert.deepEqual(calls, [["fitBounds", [-9.23, 38.69, -9.09, 38.8]]]);
  });

  it("flies to a point-only place, never zooming the map out", () => {
    const { engine, calls } = stubEngine({ zoom: 15 });
    flyToGeocodeMatch(engine, { lat: 38.72, lon: -9.14, displayName: "Lisbon", score: null });
    assert.deepEqual(calls, [["flyTo", { center: [-9.14, 38.72], zoom: 15 }]]);
  });

  it("places a point-only result on the globe through the store's view", () => {
    const { engine, calls } = stubEngine({ kind: "cesium" });
    useAppStore.getState().setMapView({ center: [0, 0], zoom: 2 });
    flyToGeocodeMatch(engine, { lat: 38.72, lon: -9.14, displayName: "Lisbon", score: null });
    assert.deepEqual(calls, []);
    const view = useAppStore.getState().mapView;
    assert.deepEqual(view.center, [-9.14, 38.72]);
    assert.equal(view.zoom, POINT_RESULT_ZOOM);
  });
});
