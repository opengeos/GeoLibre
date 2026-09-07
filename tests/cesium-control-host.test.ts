import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { useAppStore } from "@geolibre/core";
import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import {
  CesiumControlHost,
  getPrimaryCesiumControlHost,
  setPrimaryCesiumControlHost,
} from "../packages/map/src/cesium-control-host";

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  setPrimaryCesiumControlHost(null);
  Object.assign(globalThis, {
    document: originalDocument,
    HTMLElement: originalHTMLElement,
  });
});

function installDom() {
  const { document, window } = parseHTML(
    "<html><body><div id='cesium-parent'></div></body></html>",
  );
  Object.assign(globalThis, { document, HTMLElement: window.HTMLElement });
  return document;
}

function makeFakeViewer(document: Document) {
  const canvas = document.createElement("canvas");
  return {
    canvas,
    scene: { canvas },
    camera: { heading: 0, pitch: -Math.PI / 2 },
  };
}

describe("CesiumControlHost", () => {
  let doc: Document;
  let parent: HTMLElement;
  let viewer: ReturnType<typeof makeFakeViewer>;

  beforeEach(() => {
    doc = installDom();
    parent = doc.getElementById("cesium-parent")!;
    viewer = makeFakeViewer(doc);
    useAppStore.setState({
      mapView: { center: [-122.4, 37.7], zoom: 10, bearing: 15, pitch: 45 },
    } as never);
  });

  it("moves a control without remounting its widget and rejects invalid corners", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const element = doc.createElement("button");
    let mounts = 0;
    let removals = 0;
    const control = {
      onAdd: () => {
        mounts++;
        return element;
      },
      onRemove: () => {
        removals++;
      },
    };
    host.addControl(control);
    assert.equal(host.setControlPosition(control, "bottom-left"), true);
    assert.equal(element.parentElement?.className, "maplibregl-ctrl-bottom-left");
    assert.equal(mounts, 1);
    assert.equal(removals, 0);
    assert.equal(host.setControlPosition(control, "constructor" as never), false);
    host.destroy();
    assert.equal(removals, 1);
  });

  it("creates corner containers with pointer-events: none over the parent", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const container = host.getContainer();
    assert.ok(container);
    assert.equal(container.className, "maplibregl-control-container");
    assert.equal(container.parentElement, parent);

    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    for (const corner of corners) {
      const el = container.querySelector(`.maplibregl-ctrl-${corner}`) as HTMLElement;
      assert.ok(el, `missing corner ${corner}`);
      assert.equal(el.style.pointerEvents, "none");
      assert.equal(el.style.position, "absolute");
      assert.equal(el.style.zIndex, "2");
    }
    host.destroy();
  });

  it("mounts controls with pointer-events: auto in the requested corner", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    ctrlEl.className = "test-control";

    let passedMap: MapLibreMap | null = null;
    const control: IControl = {
      onAdd: (map) => {
        passedMap = map;
        return ctrlEl;
      },
      onRemove: () => {},
    };

    const added = host.addControl(control, "bottom-left");
    assert.equal(added, true);
    assert.ok(passedMap, "control onAdd must receive map facade");
    assert.equal(ctrlEl.style.pointerEvents, "auto");

    const corner = host.getContainer().querySelector(".maplibregl-ctrl-bottom-left")!;
    assert.ok(corner.contains(ctrlEl));

    // Refuses duplicate control
    assert.equal(host.addControl(control), false);

    host.destroy();
  });

  it("falls back to top-right corner when position is not recognized", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {},
    };

    const added = host.addControl(control, "unknown-corner" as never);
    assert.equal(added, true);
    const corner = host.getContainer().querySelector(".maplibregl-ctrl-top-right")!;
    assert.ok(corner.contains(ctrlEl));
    host.destroy();
  });

  it("handles throwing control.onAdd gracefully without adding to registry", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const control: IControl = {
      onAdd: () => {
        throw new Error("Plugin failed to construct DOM");
      },
      onRemove: () => {},
    };

    const added = host.addControl(control);
    assert.equal(added, false);
    host.destroy();
  });

  it("rejects controls returning invalid elements or duck-typed objects from onAdd", () => {
    const host = new CesiumControlHost(viewer as never, parent);

    const duckTypedObj = { style: {} };
    const controlWithDuckType: IControl = {
      onAdd: () => duckTypedObj as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithDuckType), false);

    const forgedNode = { nodeType: 1, style: {} };
    const controlWithForgedNode: IControl = {
      onAdd: () => forgedNode as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithForgedNode), false);

    const controlWithNull: IControl = {
      onAdd: () => null as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithNull), false);

    const controlWithNumber: IControl = {
      onAdd: () => 42 as never,
      onRemove: () => {},
    };
    assert.equal(host.addControl(controlWithNumber), false);

    host.destroy();
  });

  it("safely falls back to top-right on inherited prototype properties as position", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {},
    };

    const added = host.addControl(control, "__proto__" as never);
    assert.equal(added, true);
    const corner = host.getContainer().querySelector(".maplibregl-ctrl-top-right")!;
    assert.ok(corner.contains(ctrlEl));
    host.destroy();
  });

  it("handles control whose onRemove detaches its container from parentNode directly", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");
    let onRemoveCalled = false;

    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {
        onRemoveCalled = true;
        // Classic MapLibre control pattern that throws if detached beforehand
        ctrlEl.parentNode!.removeChild(ctrlEl);
      },
    };

    host.addControl(control, "top-left");
    assert.doesNotThrow(() => host.removeControl(control));
    assert.equal(onRemoveCalled, true);
    assert.equal(ctrlEl.parentElement, null);
    host.destroy();
  });

  it("safeguards removeControl when control.onRemove throws", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const ctrlEl = doc.createElement("div");

    const control: IControl = {
      onAdd: () => ctrlEl,
      onRemove: () => {
        throw new Error("Teardown error in third-party control");
      },
    };

    host.addControl(control, "top-right");
    assert.doesNotThrow(() => host.removeControl(control));
    assert.equal(ctrlEl.parentElement, null, "DOM element must still be detached");
    host.destroy();
  });

  it("safely tears down all controls and container in destroy even if a control throws", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    const el1 = doc.createElement("div");
    const el2 = doc.createElement("div");
    let c2Removed = false;

    const c1: IControl = {
      onAdd: () => el1,
      onRemove: () => {
        throw new Error("c1 explode");
      },
    };
    const c2: IControl = {
      onAdd: () => el2,
      onRemove: () => {
        c2Removed = true;
      },
    };

    host.addControl(c1);
    host.addControl(c2);
    assert.doesNotThrow(() => host.destroy());

    assert.equal(c2Removed, true, "subsequent controls must still be unmounted");
    assert.equal(host.getContainer().parentElement, null, "container must be detached from parent");
  });

  it("provides active camera view getters on CesiumMapFacade", () => {
    const host = new CesiumControlHost(viewer as never, parent);
    let facade: any = null;
    const control: IControl = {
      onAdd: (map) => {
        facade = map;
        return doc.createElement("div");
      },
      onRemove: () => {},
    };

    host.addControl(control);
    assert.ok(facade);
    assert.equal(facade.getCanvas(), viewer.canvas);
    assert.equal(facade.isStyleLoaded(), true);
    assert.equal(facade.getZoom(), 10);
    assert.equal(facade.getBearing(), 15);
    assert.equal(facade.getPitch(), 45);
    assert.equal(facade.getCenter().lng, -122.4);
    assert.equal(facade.getCenter().lat, 37.7);

    // Unsupported style-spec mutations throw explicitly
    assert.throws(() => facade.addLayer({}), /addLayer is not supported/);
    assert.throws(() => facade.setPaintProperty(), /setPaintProperty is not supported/);
    assert.throws(() => facade.setLayoutProperty(), /setLayoutProperty is not supported/);
    assert.throws(() => facade.getStyle(), /getStyle is not supported/);
    assert.throws(() => facade.getBounds(), /getBounds not implemented/);

    // Source management works
    facade.addSource("test-src", { type: "geojson" });
    assert.deepEqual(facade.getSource("test-src"), { type: "geojson" });
    facade.removeSource("test-src");
    assert.equal(facade.getSource("test-src"), undefined);

    host.destroy();
  });

  it("tracks primaryCesiumControlHost singleton", () => {
    assert.equal(getPrimaryCesiumControlHost(), null);
    const host = new CesiumControlHost(viewer as never, parent);
    setPrimaryCesiumControlHost(host);
    assert.equal(getPrimaryCesiumControlHost(), host);
    setPrimaryCesiumControlHost(null);
    assert.equal(getPrimaryCesiumControlHost(), null);
    host.destroy();
  });
});
