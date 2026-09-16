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
