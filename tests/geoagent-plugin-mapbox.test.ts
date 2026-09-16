import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { geoAgentMapEngine } from "../packages/plugins/src/plugins/geoagent-map-engine";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The plugin's entry module pulls the Earth Engine browser client in at import
// time, so its declaration is read off the source (as the Mapbox web-service
// suite already does for this plugin) while the engine resolver — which has no
// such dependency and lives in its own module for exactly this reason — is
// imported and exercised directly.
const SOURCE = readFileSync(
  new URL("../packages/plugins/src/plugins/maplibre-geoagent.ts", import.meta.url),
  "utf8",
);

describe("maplibreGeoAgentPlugin", () => {
  it("declares both 2D engines", () => {
    assert.match(SOURCE, /engines:\s*\["maplibre",\s*"mapbox"\]/);
  });

  it("hands the control the engine, so its tools follow the host", () => {
    // Without this the marker tool builds MapLibre's Marker, set_projection
    // writes the MapLibre shape, and run_maplibre_script gives user code the
    // wrong namespace — each breaking an agent run partway through.
    assert.match(SOURCE, /mapEngine:\s*geoAgentMapEngine\(app\)/);
  });
});

describe("geoAgentMapEngine", () => {
  it("leaves the upstream default (maplibre-gl) when there is no Mapbox map", () => {
    assert.equal(geoAgentMapEngine(null), undefined);
    assert.equal(geoAgentMapEngine(undefined), undefined);
    assert.equal(geoAgentMapEngine({} as GeoLibreAppAPI), undefined);
    assert.equal(geoAgentMapEngine({ getMapboxGl: () => null } as GeoLibreAppAPI), undefined);
  });

  it("names Mapbox and hands over the whole namespace", () => {
    const namespace = { Marker: class {}, Popup: class {}, LngLatBounds: class {} };
    const engine = geoAgentMapEngine({
      getMapboxGl: () => namespace,
    } as unknown as GeoLibreAppAPI);

    assert.equal(engine?.kind, "mapbox");
    // Not a narrowed subset: run_maplibre_script passes this straight to user
    // code, so a script reaching for LngLatBounds must find the engine's own.
    assert.equal(engine?.namespace, namespace as unknown);
  });
});
