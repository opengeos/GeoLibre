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

  it("forgets an import that failed, so the next activation retries it", () => {
    // A rejected promise memoizes like any other: without the catch, one
    // offline activation would reject every later one until a page reload.
    assert.match(
      SOURCE,
      /geoAgentModulePromise \?\?= import\("maplibre-gl-geoagent"\)\.catch\([\s\S]*?geoAgentModulePromise = null;\s*\n\s*throw error;/,
    );
  });

  it("lets only the current activation build the shared control", () => {
    // The module import is shared, and its continuations run in registration
    // order — so without this check an activation superseded mid-import would
    // construct the singleton first, with its stale engine baked in, and the
    // activation that is actually current would mount that instance.
    assert.match(
      SOURCE,
      /if \(!geoAgentActive \|\| activationGeneration !== geoAgentActivationGeneration\) return null;\s*\n\s*geoAgentControl \?\?= new GeoAgentControl/,
    );
  });
});

describe("geoAgentMapEngine", () => {
  it("leaves the upstream default (maplibre-gl) when there is no Mapbox map", () => {
    assert.equal(geoAgentMapEngine(null), undefined);
    assert.equal(geoAgentMapEngine(undefined), undefined);
    assert.equal(geoAgentMapEngine({} as GeoLibreAppAPI), undefined);
    assert.equal(geoAgentMapEngine({ getMapboxGl: () => null } as GeoLibreAppAPI), undefined);
    assert.equal(
      geoAgentMapEngine({
        getMapRenderer: () => "maplibre",
        getMapboxGl: () => null,
      } as unknown as GeoLibreAppAPI),
      undefined,
    );
  });

  it("lets the renderer overrule a namespace the outgoing engine still answers", () => {
    // Swapping Mapbox out flips `primaryRenderer` first and clears the engine
    // after, so the two disagree for a moment. Reading the namespace as a
    // second vote would build a Mapbox descriptor for a MapLibre host.
    assert.equal(
      geoAgentMapEngine({
        getMapRenderer: () => "maplibre",
        getMapboxGl: () => ({ Marker: class {} }),
      } as unknown as GeoLibreAppAPI),
      undefined,
    );
  });

  it("commits on the renderer and resolves the namespace on access", () => {
    // The store flips `primaryRenderer` synchronously, but GeoAgent is built
    // behind a dynamic import, so its control can be constructed well before
    // MapboxEngine has mounted. Reading the namespace then would hand the
    // agent's tools maplibre-gl for the control's whole lifetime.
    const namespace = { Marker: class {}, Popup: class {} };
    let mounted: typeof namespace | null = null;
    const engine = geoAgentMapEngine({
      getMapRenderer: () => "mapbox",
      getMapboxGl: () => mounted,
    } as unknown as GeoLibreAppAPI);

    assert.equal(engine?.kind, "mapbox", "the renderer alone must be enough to commit");
    mounted = namespace;
    assert.equal(engine?.namespace, namespace as unknown);
  });

  it("refuses loudly rather than handing the agent MapLibre's classes", () => {
    const engine = geoAgentMapEngine({
      getMapRenderer: () => "mapbox",
      getMapboxGl: () => null,
    } as unknown as GeoLibreAppAPI);
    assert.ok(engine);
    assert.throws(() => engine!.namespace, /mapbox-gl namespace/);
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
