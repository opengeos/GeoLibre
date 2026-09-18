import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { useAppStore } from "@geolibre/core";
import { addArcGISLayer } from "../packages/plugins/src/plugins/arcgis-layer";

test("ArcGIS import prefixes SDK copies and persists the same style on either renderer", async () => {
  // The SDK defines a browser control at module scope; this test only calls
  // its mocked static loader and does not construct that control.
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  try {
    const { VectorTileLayer } = await import("@esri/maplibre-arcgis");
    for (const hasMap of [false, true]) {
      let sourceId = "parcels";
      const runtime = {
        get sources() {
          return {
            [sourceId]: {
              type: "vector",
              bounds: [-119, 33, -118, 35],
              tiles: ["https://example.com/{z}/{x}/{y}.pbf"],
            },
          };
        },
        get layers() {
          return [{ id: "parcel-fill", type: "fill", source: sourceId, "source-layer": "parcels" }];
        },
        setSourceId(_old: string, next: string) {
          sourceId = next;
        },
      };
      const loader = mock.method(VectorTileLayer, "fromUrl", async () => runtime as never);
      const added: { id: string; source: string }[] = [];
      const map = {
        getSource: () => undefined,
        getLayer: () => undefined,
        addSource: () => {},
        addLayer: (spec: { id: string; source: string }) => added.push(spec),
      };
      try {
        const id = await addArcGISLayer({ getMap: () => (hasMap ? map : null) } as never, {
          layerType: "vector-tile",
          sourceType: "url",
          url: "https://example.com/VectorTileServer",
          zoomTo: false,
        });
        const layer = useAppStore.getState().layers.find((item) => item.id === id)!;
        const specs = layer.source.arcgisLayers as { id: string; source: string }[];
        assert.deepEqual(
          specs.map((spec) => spec.id),
          layer.metadata.nativeLayerIds,
        );
        assert.ok(specs.every((spec) => spec.id.startsWith(id)));
        assert.ok(Object.hasOwn(layer.source.arcgisSources as object, specs[0].source));
        assert.equal(
          runtime.layers[0].id,
          "parcel-fill",
          "the SDK's original style stays untouched",
        );
        assert.deepEqual(added, hasMap ? specs : []);
        useAppStore.getState().removeLayer(id);
      } finally {
        loader.mock.restore();
      }
    }
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldElement) Object.defineProperty(globalThis, "HTMLElement", oldElement);
    else Reflect.deleteProperty(globalThis, "HTMLElement");
  }
});
