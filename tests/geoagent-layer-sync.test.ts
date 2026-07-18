import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer, useAppStore } from "@geolibre/core";
import {
  createGeoAgentStoreLayer,
  geoAgentStoreLayerId,
  isGeoAgentStoreLayer,
  removeGeoAgentStoreLayers,
  syncGeoAgentOverlaysToStore,
  unwireGeoAgentStoreSync,
  wireGeoAgentStoreSync,
  type GeoAgentOverlayRecord,
} from "../packages/plugins/src/plugins/geoagent-layer-sync";

function overlayMap(...overlays: GeoAgentOverlayRecord[]): Map<string, GeoAgentOverlayRecord> {
  return new Map(overlays.map((overlay) => [overlay.name, overlay]));
}

function geojsonOverlay(patch: Partial<GeoAgentOverlayRecord> = {}): GeoAgentOverlayRecord {
  return {
    kind: "geojson",
    name: "Rivers",
    sourceIds: ["rivers-source"],
    layerIds: ["rivers-fill", "rivers-line"],
    style: { "fill-color": "#ff0000", "line-color": "#00ff00" },
    data: { type: "FeatureCollection", features: [] },
    ...patch,
  };
}

function geeOverlay(patch: Partial<GeoAgentOverlayRecord> = {}): GeoAgentOverlayRecord {
  return {
    kind: "gee",
    name: "NDVI",
    sourceIds: ["ndvi-source"],
    layerIds: ["ndvi"],
    url: "https://earthengine.googleapis.com/tiles/{z}/{x}/{y}",
    attribution: "Google Earth Engine",
    ...patch,
  };
}

function otherStoreLayer(id = "unrelated"): GeoLibreLayer {
  return {
    id,
    name: "Unrelated",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
  };
}

describe("syncGeoAgentOverlaysToStore", () => {
  beforeEach(() => {
    useAppStore.setState({ layers: [] });
  });

  it("adds a store layer for a GeoAgent geojson overlay", () => {
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 1);

    const layer = layers[0];
    assert.equal(layer.id, geoAgentStoreLayerId("Rivers"));
    assert.equal(layer.name, "Rivers");
    assert.equal(layer.type, "geojson");
    assert.equal(layer.visible, true);
    assert.equal(layer.metadata.externalNativeLayer, true);
    assert.deepEqual(layer.metadata.nativeLayerIds, ["rivers-fill", "rivers-line"]);
    assert.deepEqual(layer.metadata.sourceIds, ["rivers-source"]);
    assert.equal(layer.metadata.sourceKind, "geoagent-overlay");
    assert.equal(layer.metadata.geoAgentOverlayName, "Rivers");
    assert.ok(isGeoAgentStoreLayer(layer));
  });

  it("maps GeoAgent geojson overlay style onto the store layer style", () => {
    const layer = createGeoAgentStoreLayer(geojsonOverlay());

    assert.equal(layer.style.fillColor, "#ff0000");
    assert.equal(layer.style.strokeColor, "#00ff00");
    // geojsonLayerPaint in maplibre-gl-geoagent defaults fill-opacity to 0.35.
    assert.equal(layer.style.fillOpacity, 0.35);
  });

  it("adds a raster store layer for a GeoAgent Earth Engine overlay", () => {
    syncGeoAgentOverlaysToStore(overlayMap(geeOverlay()));

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.type, "raster");
    assert.equal(layer.opacity, 1);
    assert.equal(layer.metadata.identifiable, false);
    assert.equal(layer.metadata.tileType, "raster");
    assert.equal(layer.metadata.geoAgentOverlayKind, "gee");
    assert.equal(layer.metadata.tileUrl, "https://earthengine.googleapis.com/tiles/{z}/{x}/{y}");
    assert.deepEqual(layer.metadata.nativeLayerIds, ["ndvi"]);
  });

  it("maps raster and basemap overlays to raster store layers", () => {
    // raster and basemap share the single raster-tile branch in
    // createGeoAgentStoreLayer (gee is covered by the Earth Engine test above).
    // Pin that here so a future `kind` added to the union that should NOT be a
    // raster layer fails visibly instead of silently falling through.
    for (const kind of ["raster", "basemap"] as const) {
      const layer = createGeoAgentStoreLayer({
        kind,
        name: `Overlay ${kind}`,
        sourceIds: [`${kind}-source`],
        layerIds: [kind],
        url: `https://tiles.example.com/${kind}/{z}/{x}/{y}.png`,
        attribution: "Example",
      });

      assert.equal(layer.type, "raster");
      assert.equal(layer.opacity, 1);
      assert.equal(layer.metadata.identifiable, false);
      assert.equal(layer.metadata.tileType, "raster");
      assert.equal(layer.metadata.geoAgentOverlayKind, kind);
      assert.equal(layer.metadata.tileUrl, `https://tiles.example.com/${kind}/{z}/{x}/{y}.png`);
    }
  });

  it("removes store layers whose overlays are gone, leaving others alone", () => {
    useAppStore.getState().addLayer(otherStoreLayer());
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay(), geeOverlay()));
    assert.equal(useAppStore.getState().layers.length, 3);

    syncGeoAgentOverlaysToStore(overlayMap(geeOverlay()));

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 2);
    assert.ok(layers.some((layer) => layer.id === "unrelated"));
    assert.ok(layers.some((layer) => layer.id === geoAgentStoreLayerId("NDVI")));
  });

  it("skips markers and internal overlays", () => {
    syncGeoAgentOverlaysToStore(
      overlayMap(
        {
          kind: "marker",
          name: "Pin",
          sourceIds: [],
          layerIds: [],
        },
        {
          kind: "native",
          name: "__terrain",
          sourceIds: ["terrain-source"],
          layerIds: ["terrain-hillshade"],
        },
      ),
    );

    assert.equal(useAppStore.getState().layers.length, 0);
  });

  it("preserves user edits on re-sync but refreshes native ids", () => {
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));

    const id = geoAgentStoreLayerId("Rivers");
    useAppStore.getState().updateLayer(id, {
      name: "My Rivers",
      visible: false,
      opacity: 0.5,
    });

    // The agent re-adds the overlay; unique id allocation produces new ids.
    syncGeoAgentOverlaysToStore(
      overlayMap(
        geojsonOverlay({
          sourceIds: ["rivers-source-2"],
          layerIds: ["rivers-fill-2", "rivers-line-2"],
        }),
      ),
    );

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.name, "My Rivers");
    assert.equal(layer.visible, false);
    assert.equal(layer.opacity, 0.5);
    assert.deepEqual(layer.metadata.nativeLayerIds, ["rivers-fill-2", "rivers-line-2"]);
    assert.deepEqual(layer.metadata.sourceIds, ["rivers-source-2"]);
  });

  it("refreshes geojson data when an overlay is re-added with the same ids", () => {
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));

    // GeoAgent's removeOverlay-then-add flow frees the old ids, so the re-add
    // reuses them while the payload changes.
    const updatedData: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [0, 0] },
          properties: {},
        },
      ],
    };
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay({ data: updatedData })));

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.geojson, updatedData);
  });

  it("initializes native symbol overlay opacity from icon/text opacity", () => {
    const layer = createGeoAgentStoreLayer({
      kind: "native",
      name: "Labels",
      sourceIds: ["labels-source"],
      layerIds: ["labels"],
      layerSpecs: [
        {
          layer: {
            id: "labels",
            type: "symbol",
            paint: { "text-opacity": 0.4 },
          },
        },
      ],
    });

    assert.equal(layer.opacity, 0.4);
  });

  it("refreshes the layer type when an overlay is re-added as another kind", () => {
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));
    syncGeoAgentOverlaysToStore(overlayMap(geeOverlay({ name: "Rivers" })));

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.type, "raster");
  });

  it("preserves the panel selection when sync adds layers", () => {
    useAppStore.getState().addLayer(otherStoreLayer());
    assert.equal(useAppStore.getState().selectedLayerId, "unrelated");

    // Agent-driven adds happen in the background; they must not steal the
    // user's current layer-panel selection.
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));

    assert.equal(useAppStore.getState().selectedLayerId, "unrelated");
  });

  it("clears customLayerType when a native overlay is re-added as geojson", () => {
    syncGeoAgentOverlaysToStore(
      overlayMap({
        kind: "native",
        name: "Rivers",
        sourceIds: ["rivers-source"],
        layerIds: ["rivers-fill"],
        layerSpecs: [{ layer: { id: "rivers-fill", type: "fill" } }],
      }),
    );
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.type, "geojson");
    assert.ok(
      typeof layer.metadata.customLayerType !== "string",
      "customLayerType must be absent so layer-sync uses the normal geojson path",
    );
  });

  it("reseeds the style when an overlay changes kind", () => {
    syncGeoAgentOverlaysToStore(overlayMap(geeOverlay()));
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay({ name: "NDVI" })));

    const layer = useAppStore.getState().layers[0];
    assert.equal(layer.type, "geojson");
    // The old kind's style carries no meaning across the switch; the new
    // geojson style mapped from the overlay must win.
    assert.equal(layer.style.fillColor, "#ff0000");
  });

  it("omits sourceId for overlays without their own sources", () => {
    // Native overlays may reference sources that already exist on the map,
    // leaving their own sourceSpecs (and thus sourceIds) empty.
    const layer = createGeoAgentStoreLayer({
      kind: "native",
      name: "Sky Layer",
      sourceIds: [],
      layerIds: ["sky-fill"],
    });

    assert.ok(!("sourceId" in layer.source));
    assert.ok(!("sourceId" in layer.metadata));
  });

  it("treats empty-string style numbers as absent and clamps negatives", () => {
    const raster = createGeoAgentStoreLayer(geeOverlay({ style: { opacity: "" } }));
    assert.equal(raster.opacity, 1);

    const geojson = createGeoAgentStoreLayer(
      geojsonOverlay({ style: { "line-width": -3, "circle-radius": -1 } }),
    );
    assert.equal(geojson.style.strokeWidth, 0);
    assert.equal(geojson.style.circleRadius, 0);
  });

  it("seeds opacity only for layer types the panel can later control", () => {
    // hillshade has no *-opacity paint property; seeding from a made-up key
    // would desync the panel from what opacity changes can actually affect.
    const layer = createGeoAgentStoreLayer({
      kind: "native",
      name: "Relief",
      sourceIds: ["relief-source"],
      layerIds: ["relief"],
      layerSpecs: [
        {
          layer: {
            id: "relief",
            type: "hillshade",
            paint: { "hillshade-opacity": 0.5 },
          },
        },
      ],
    });

    assert.equal(layer.opacity, 1);
  });

  it("does not echo removeOverlay during deactivate cleanup", () => {
    const removed: string[] = [];
    wireGeoAgentStoreSync({
      removeOverlay: (name) => {
        removed.push(name);
        return true;
      },
    });

    try {
      syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));
      removeGeoAgentStoreLayers();

      assert.equal(useAppStore.getState().layers.length, 0);
      assert.deepEqual(removed, []);
    } finally {
      unwireGeoAgentStoreSync();
    }
  });

  it("removes only GeoAgent layers when the plugin deactivates", () => {
    useAppStore.getState().addLayer(otherStoreLayer());
    syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay(), geeOverlay()));

    removeGeoAgentStoreLayers();

    const layers = useAppStore.getState().layers;
    assert.equal(layers.length, 1);
    assert.equal(layers[0].id, "unrelated");
  });

  it("drops GeoAgent's overlay record when the layer is removed in the panel", () => {
    const removed: string[] = [];
    wireGeoAgentStoreSync({
      removeOverlay: (name) => {
        removed.push(name);
        return true;
      },
    });

    try {
      syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));
      useAppStore.getState().removeLayer(geoAgentStoreLayerId("Rivers"));

      assert.deepEqual(removed, ["Rivers"]);
    } finally {
      unwireGeoAgentStoreSync();
    }
  });

  it("does not call removeOverlay for sync-driven store removals", () => {
    const removed: string[] = [];
    wireGeoAgentStoreSync({
      removeOverlay: (name) => {
        removed.push(name);
        return true;
      },
    });

    try {
      syncGeoAgentOverlaysToStore(overlayMap(geojsonOverlay()));
      // GeoAgent already dropped the overlay from its registry; the sync
      // prunes the store layer and must not echo a removeOverlay back.
      syncGeoAgentOverlaysToStore(overlayMap());

      assert.equal(useAppStore.getState().layers.length, 0);
      assert.deepEqual(removed, []);
    } finally {
      unwireGeoAgentStoreSync();
    }
  });

  it("applies visibility and opacity to custom native layers via the map", () => {
    const layout: Array<[string, string, unknown]> = [];
    const paint: Array<[string, string, unknown]> = [];
    wireGeoAgentStoreSync({
      map: {
        getLayer: (id: string) => (id === "buildings-3d" ? { type: "fill-extrusion" } : undefined),
        setLayoutProperty: (id: string, property: string, value: unknown) => {
          layout.push([id, property, value]);
        },
        setPaintProperty: (id: string, property: string, value: unknown) => {
          paint.push([id, property, value]);
        },
      },
    });

    try {
      syncGeoAgentOverlaysToStore(
        overlayMap({
          kind: "native",
          name: "3D Buildings",
          sourceIds: ["buildings-source"],
          layerIds: ["buildings-3d"],
          layerSpecs: [
            {
              layer: {
                id: "buildings-3d",
                type: "fill-extrusion",
                source: "buildings-source",
                paint: { "fill-extrusion-opacity": 0.6 },
              },
            },
          ],
        }),
      );

      const id = geoAgentStoreLayerId("3D Buildings");
      useAppStore.getState().setLayerVisibility(id, false);
      useAppStore.getState().setLayerOpacity(id, 0.25);

      // Each store mutation applies only the dimension that changed.
      assert.deepEqual(layout, [["buildings-3d", "visibility", "none"]]);
      assert.deepEqual(paint, [["buildings-3d", "fill-extrusion-opacity", 0.25]]);
    } finally {
      unwireGeoAgentStoreSync();
    }
  });

  it("registers native overlays as custom layers with their initial opacity", () => {
    const layer = createGeoAgentStoreLayer({
      kind: "native",
      name: "3D Buildings",
      sourceIds: ["buildings-source"],
      layerIds: ["buildings-3d"],
      layerSpecs: [
        {
          layer: {
            id: "buildings-3d",
            type: "fill-extrusion",
            source: "buildings-source",
            paint: { "fill-extrusion-opacity": 0.6 },
          },
        },
      ],
    });

    assert.equal(layer.metadata.customLayerType, "fill-extrusion");
    assert.equal(layer.opacity, 0.6);
    assert.equal(layer.metadata.geoAgentOverlayKind, "native");
  });
});
