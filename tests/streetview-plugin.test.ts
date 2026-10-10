import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { StreetViewControl } from "maplibre-gl-streetview";
import {
  maplibreStreetViewPlugin as plugin,
  streetViewMarkerFactory,
} from "../packages/plugins/src/plugins/maplibre-streetview";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import * as Cesium from "@cesium/engine";
import { createCesiumDomMarker } from "../packages/plugins/src/plugins/cesium-dom-marker";

describe("maplibreStreetViewPlugin", () => {
  it("declares both 2D engines and the globe", () => {
    // The control only needs the Style Spec surface they share (the globe's
    // control facade included); the one MapLibre class it built itself, the
    // location marker, is supplied per engine.
    assert.deepEqual(plugin.engines, ["maplibre", "mapbox", "cesium"]);
  });
});

describe("streetViewMarkerFactory", () => {
  it("leaves the upstream default (MapLibre's Marker) when there is no Mapbox map", () => {
    // `undefined` is meaningful: maplibre-gl-streetview falls back to its own
    // `new Marker(...)`, which is exactly right on a MapLibre host.
    assert.equal(streetViewMarkerFactory(null), undefined);
    assert.equal(streetViewMarkerFactory({} as GeoLibreAppAPI), undefined);
    assert.equal(streetViewMarkerFactory({ getMapboxGl: () => null } as GeoLibreAppAPI), undefined);
    assert.equal(
      streetViewMarkerFactory({
        getMapRenderer: () => "maplibre",
        getMapboxGl: () => null,
      } as unknown as GeoLibreAppAPI),
      undefined,
    );
  });

  it("commits to Mapbox on the renderer, before the engine has published itself", () => {
    // The store flips `primaryRenderer` synchronously but MapboxEngine mounts a
    // beat later. A plugin activated in that window must not be handed
    // `undefined` and keep MapLibre's Marker for the control's whole lifetime.
    const built: unknown[] = [];
    class FakeMapboxMarker {
      constructor(public options: unknown) {
        built.push(options);
      }
    }
    let namespace: { Marker: typeof FakeMapboxMarker } | null = null;
    const app = {
      getMapRenderer: () => "mapbox",
      getMapboxGl: () => namespace,
    } as unknown as GeoLibreAppAPI;

    const create = streetViewMarkerFactory(app);
    assert.ok(create, "the renderer alone must be enough to commit");

    // The namespace arrives before any marker is built — the control only does
    // that from onAdd, which needs a mounted map.
    namespace = { Marker: FakeMapboxMarker };
    const element = { nodeType: 1 } as unknown as HTMLElement;
    assert.ok(create!({ element, anchor: "center" }) instanceof FakeMapboxMarker);
    assert.deepEqual(built, [{ element, anchor: "center" }]);
  });

  it("does not commit to Mapbox while a swap away from it is still in flight", () => {
    // The mirror of the case above. The store flips `primaryRenderer` to
    // "maplibre" synchronously, but `getMapboxGl()` answers off the engine ref,
    // which still holds the outgoing MapboxEngine for a beat. Trusting the
    // namespace there would hand a control being rebuilt for MapLibre a Mapbox
    // marker factory — which, by the time `onAdd` builds a marker, has no
    // namespace left and throws.
    const stale = { Marker: class {} };
    assert.equal(
      streetViewMarkerFactory({
        getMapRenderer: () => "maplibre",
        getMapboxGl: () => stale,
      } as unknown as GeoLibreAppAPI),
      undefined,
    );
  });

  it("falls back to the namespace only for a host that reports no renderer", () => {
    const namespace = { Marker: class {} };
    assert.ok(
      streetViewMarkerFactory({ getMapboxGl: () => namespace } as unknown as GeoLibreAppAPI),
    );
  });

  it("refuses loudly rather than placing a marker that would throw later", () => {
    const create = streetViewMarkerFactory({
      getMapRenderer: () => "mapbox",
      getMapboxGl: () => null,
    } as unknown as GeoLibreAppAPI);
    assert.ok(create);
    assert.throws(
      () => create!({ element: {} as HTMLElement, anchor: "center" }),
      /mapbox-gl namespace/,
    );
  });

  it("builds the marker with mapbox-gl's own class on a Mapbox host", () => {
    const built: unknown[] = [];
    class FakeMapboxMarker {
      constructor(public options: unknown) {
        built.push(options);
      }
    }
    const app = {
      getMapboxGl: () => ({ Marker: FakeMapboxMarker }),
    } as unknown as GeoLibreAppAPI;

    const create = streetViewMarkerFactory(app);
    assert.ok(create, "a Mapbox host must get a factory");

    const element = { nodeType: 1 } as unknown as HTMLElement;
    const marker = create!({ element, anchor: "center" });
    assert.ok(marker instanceof FakeMapboxMarker, "MapLibre's Marker throws on a mapbox-gl map");
    assert.deepEqual(built, [{ element, anchor: "center" }]);
  });
});

describe("Street View API keys", () => {
  // The control's Keys form is real DOM, so give it a minimal document.
  const dom = parseHTML("<html><body></body></html>");
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of ["document", "window", "HTMLElement", "Event"]) {
    globals[key] ??=
      key === "window"
        ? dom.window
        : ((dom as unknown as Record<string, unknown>)[key] ??
          (dom.window as unknown as Record<string, unknown>)[key]);
  }
  globals.requestAnimationFrame ??= (callback: () => void) => setTimeout(callback, 0);
  globals.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };

  /**
   * Types `values` into the control's Keys form and submits it, as the Apply
   * keys button does, so the test covers the upstream form-to-setApiKeys wiring.
   */
  function applyThroughForm(control: StreetViewControl, values: Record<string, string>): void {
    const container = dom.document.createElement("div");
    const map = { getContainer: () => container, on() {}, off() {}, once() {} };
    const element = control.onAdd(map as never);
    container.appendChild(element);
    const form: Element | null = container.querySelector("form[aria-label='Street view API keys']");
    assert.ok(form, "the control renders its API keys form");
    for (const [label, value] of Object.entries(values)) {
      const input: HTMLInputElement | null = form.querySelector(`input[aria-label='${label}']`);
      assert.ok(input, `no ${label} input`);
      input.value = value;
    }
    form.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  }

  /** A fake app with an in-memory `app.credentials` that records each added control. */
  function appWithCredentials(saved: Map<string, string>) {
    const controls: StreetViewControl[] = [];
    const app = {
      addMapControl: (control: StreetViewControl) => {
        controls.push(control);
        return true;
      },
      removeMapControl: () => {},
      credentials: {
        get: (name: string) => saved.get(name) ?? "",
        set: (name: string, value: string) => {
          if (value) saved.set(name, value);
          else saved.delete(name);
          return true;
        },
        location: () => "browser",
      },
    } as unknown as GeoLibreAppAPI;
    return { app, controls };
  }

  /** The keys a control currently holds (the upstream options are private). */
  function keysOf(control: StreetViewControl) {
    const { googleApiKey, mapillaryAccessToken } = (
      control as unknown as { _options: Record<string, string | undefined> }
    )._options;
    return { googleApiKey, mapillaryAccessToken };
  }

  it("saves keys applied in the panel and seeds them on reactivation", () => {
    const saved = new Map<string, string>();
    const { app, controls } = appWithCredentials(saved);
    plugin.activate(app);
    try {
      // Unset keys reach the control as "", which its inputs show as empty
      // (undefined would render as the literal text "undefined").
      assert.deepEqual(keysOf(controls[0]), { googleApiKey: "", mapillaryAccessToken: "" });
      applyThroughForm(controls[0], {
        "Google Maps API key": " g-key ",
        "Mapillary access token": "m-token",
      });
      assert.deepEqual(Object.fromEntries(saved), { google: "g-key", mapillary: "m-token" });
    } finally {
      plugin.deactivate?.(app);
    }

    plugin.activate(app);
    try {
      assert.deepEqual(keysOf(controls[1]), {
        googleApiKey: "g-key",
        mapillaryAccessToken: "m-token",
      });
      // Clearing a key deletes the saved one; an omitted key is left alone.
      controls[1].setApiKeys({ googleApiKey: null });
      assert.deepEqual(Object.fromEntries(saved), { mapillary: "m-token" });
    } finally {
      plugin.deactivate?.(app);
    }
  });
});

describe("Street View on the globe", () => {
  /** A scene handle whose camera looks straight down on (0°, 0°) from `height`. */
  function makeScene(document: Document, height = 1e6) {
    const container = document.createElement("div");
    const canvas = Object.assign(document.createElement("canvas"), {
      clientWidth: 800,
      clientHeight: 600,
    });
    container.appendChild(canvas);
    const postRender = new Cesium.Event();
    const projected: { x: number; y: number } = { x: 400, y: 300 };
    const scene = {
      mode: Cesium.SceneMode.SCENE3D,
      globe: { getHeight: () => 12 },
      postRender,
    };
    const original = Cesium.SceneTransforms.worldToWindowCoordinates;
    Cesium.SceneTransforms.worldToWindowCoordinates = (() =>
      new Cesium.Cartesian2(projected.x, projected.y)) as never;
    const camera = { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, height) };
    const handle = {
      Cesium,
      scene,
      camera,
      canvas,
      requestRender: () => {},
    };
    return {
      handle,
      container,
      projected,
      postRender,
      restore: () => (Cesium.SceneTransforms.worldToWindowCoordinates = original),
    };
  }

  it("builds a globe marker for the cesium renderer", () => {
    const factory = streetViewMarkerFactory({
      getMapRenderer: () => "cesium",
      getCesiumScene: () => null,
    } as unknown as GeoLibreAppAPI);
    assert.equal(typeof factory, "function");
  });

  it("follows the camera and hides past the horizon or off the canvas", () => {
    const { document } = parseHTML("<html><body></body></html>");
    const { handle, container, projected, postRender, restore } = makeScene(document);
    try {
      const element = document.createElement("div");
      const marker = createCesiumDomMarker(() => handle as never, element);
      marker.setLngLat([0, 0]).addTo({});
      assert.equal(element.parentElement, container);
      assert.equal(element.style.display, "");
      assert.equal(element.style.left, "400px");
      projected.x = 500;
      postRender.raiseEvent();
      assert.equal(element.style.left, "500px", "follows each frame");
      projected.x = 900;
      postRender.raiseEvent();
      assert.equal(element.style.display, "none", "off the canvas");
      projected.x = 400;
      marker.setLngLat([180, 0]);
      assert.equal(element.style.display, "none", "past the horizon");
      marker.remove();
      assert.equal(element.parentElement, null);
      assert.equal(postRender.numberOfListeners, 0);
    } finally {
      restore();
    }
  });
});
