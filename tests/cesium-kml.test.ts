import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as C from "@cesium/engine";
import { parseHTML } from "linkedom";
import {
  createCesiumKmlLayer,
  cesiumKmlSource,
  isCesiumOnlyLayer,
} from "../packages/core/src/index";
import { CesiumLayerSync, isCesiumSupportedLayerType } from "../packages/map/src/cesium-layer-sync";
import { bindDocumentOpacity } from "../packages/map/src/cesium-document-opacity";

const originalDocument = globalThis.document;
afterEach(() => {
  globalThis.document = originalDocument;
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function globe(load: () => Promise<void> = async () => {}) {
  const { document } = parseHTML("<html><body><div><canvas></canvas></div></body></html>");
  globalThis.document = document;
  const sources: NativeKml[] = [];
  class NativeKml extends C.CustomDataSource {
    destroyed = 0;
    target: unknown;
    options: unknown;
    constructor() {
      super();
      sources.push(this);
    }
    async load(target: unknown, options: unknown) {
      this.target = target;
      this.options = options;
      await load();
      this.entities.add({ id: "landmark", point: { color: C.Color.RED.withAlpha(0.8) } });
      return this;
    }
    destroy() {
      this.destroyed++;
    }
  }
  const viewer = {
    canvas: document.querySelector("canvas")!,
    camera: { moveEnd: new C.Event(), changed: new C.Event() },
    clock: new C.Clock(),
    dataSources: new C.DataSourceCollection(),
    scene: { requestRender() {}, primitives: new C.PrimitiveCollection() },
    imageryLayers: { raiseToTop() {} },
  };
  const sync = new CesiumLayerSync(
    { ...C, KmlDataSource: NativeKml } as never,
    viewer as never,
    () => 10,
  );
  return { sync, viewer, sources };
}

describe("native KML documents", () => {
  it("preserves inline XML and archive data URLs through a JSON project round trip", () => {
    for (const data of [
      '<kml xmlns="http://www.opengis.net/kml/2.2"/>',
      "data:application/vnd.google-earth.kmz;base64,UEs=",
    ]) {
      const layer = JSON.parse(JSON.stringify(createCesiumKmlLayer({ name: "Document", data })));
      assert.equal(cesiumKmlSource(layer), data);
      assert.equal(isCesiumOnlyLayer(layer), true);
      assert.equal(isCesiumSupportedLayerType(layer), true);
    }
    assert.throws(() => createCesiumKmlLayer({ name: "Empty", url: " " }), /Provide/);
  });

  it("loads native documents, preserves colors while fading, and removes their overlays", async () => {
    const { sync, viewer, sources } = globe();
    const layer = createCesiumKmlLayer({ name: "KML", url: "https://example.org/map.kmz" });
    sync.sync([layer]);
    await flush();
    assert.equal(sources[0].target, layer.source.url);
    assert.equal(viewer.dataSources.length, 1);
    const point = sources[0].entities.getById("landmark")!.point!;
    sync.sync([{ ...layer, opacity: 0.5 }]);
    assert.equal(point.color!.getValue(viewer.clock.currentTime).alpha, 0.4);
    sync.sync([{ ...layer, visible: false }]);
    assert.equal(sources[0].show, false);
    sync.sync([]);
    assert.equal(viewer.dataSources.length, 0);
    assert.equal(sources[0].destroyed, 1);
    assert.equal(viewer.canvas.parentElement!.children.length, 1);
    sync.destroy();
  });

  it("destroys a document removed before its load completes", async () => {
    let finish!: () => void;
    const { sync, viewer, sources } = globe(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    sync.sync([createCesiumKmlLayer({ name: "Slow", url: "https://example.org/map.kml" })]);
    sync.sync([]);
    finish();
    await flush();
    assert.equal(viewer.dataSources.length, 0);
    assert.equal(sources[0].destroyed, 1);
    assert.equal(viewer.canvas.parentElement!.children.length, 1);
    sync.destroy();
  });

  it("reports loader failures and cleans up the overlay container", async () => {
    const { sync, sources, viewer } = globe(async () => {
      throw new Error("Invalid XML");
    });
    sync.sync([createCesiumKmlLayer({ name: "Broken", url: "https://example.org/broken.kml" })]);
    await flush();
    assert.ok(JSON.stringify(sync.getRenderStatus()).includes("Invalid XML"));
    assert.equal(sources[0].destroyed, 1);
    assert.equal(viewer.canvas.parentElement!.children.length, 1);
    sync.destroy();
  });
});

it("native opacity retains time-varying colors and styles refreshed entities", () => {
  const ds = new C.CustomDataSource();
  let alpha = 0.5;
  const stop = bindDocumentOpacity(C, ds, () => alpha);
  const original = new C.CallbackProperty(
    (time) => (time!.secondsOfDay < 100 ? C.Color.RED : C.Color.BLUE),
    false,
  );
  const entity = ds.entities.add({
    point: { color: original },
    label: { text: "Landmark", fillColor: C.Color.YELLOW },
  });
  const time = new C.JulianDate(2451545, 0);
  assert.equal(entity.point!.color!.getValue(time).red, 1);
  assert.equal(entity.point!.color!.getValue(time).alpha, 0.5);
  assert.equal(entity.label!.fillColor!.getValue(time).alpha, 0.5);
  assert.equal(entity.label!.fillColor!.getValue(time).red, 1);
  time.secondsOfDay = 200;
  assert.equal(entity.point!.color!.getValue(time).blue, 1);
  alpha = 1;
  assert.equal(entity.point!.color!.getValue(time).alpha, 1);
  stop();
  assert.equal(ds.entities.collectionChanged.numberOfListeners, 0);
});
