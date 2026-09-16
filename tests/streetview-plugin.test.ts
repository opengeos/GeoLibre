import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  maplibreStreetViewPlugin as plugin,
  streetViewMarkerFactory,
} from "../packages/plugins/src/plugins/maplibre-streetview";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

describe("maplibreStreetViewPlugin", () => {
  it("declares both 2D engines", () => {
    // The control only needs the Style Spec surface the two share; the one
    // MapLibre class it built itself is now supplied per engine.
    assert.deepEqual(plugin.engines, ["maplibre", "mapbox"]);
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
