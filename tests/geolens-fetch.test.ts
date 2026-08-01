import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createGeoLensHostFetch,
  defaultGeoLensFetch,
  resetGeoLensFetch,
  setGeoLensFetch,
  type GeoLensFetch,
} from "../packages/plugins/src/plugins/geolens-api";
import { GEOLENS_SAMPLE_SERVERS } from "../packages/plugins/src/plugins/maplibre-geolens";

describe("GeoLens fetch override", () => {
  afterEach(() => resetGeoLensFetch());

  it("resolves the default transport lazily so the desktop host can override it", async () => {
    let seen = "";
    const override: GeoLensFetch = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    setGeoLensFetch(override);

    await defaultGeoLensFetch("https://datasets.geolibre.app/api/search/datasets/");
    assert.equal(seen, "https://datasets.geolibre.app/api/search/datasets/");
  });

  it("uses native HTTP only for the listed hosts", async () => {
    const calls: string[] = [];
    const response = { ok: true, status: 200, json: async () => ({}) };
    const nativeFetch: GeoLensFetch = async (url) => {
      calls.push(`native:${url}`);
      return response;
    };
    const browserFetch: GeoLensFetch = async (url) => {
      calls.push(`browser:${url}`);
      return response;
    };
    const fetchImpl = createGeoLensHostFetch(["datasets.geolibre.app"], nativeFetch, browserFetch);

    await fetchImpl("https://datasets.geolibre.app/api/search/datasets/");
    await fetchImpl("https://demo.getgeolens.com/api/search/datasets/");

    assert.deepEqual(calls, [
      "native:https://datasets.geolibre.app/api/search/datasets/",
      "browser:https://demo.getgeolens.com/api/search/datasets/",
    ]);
  });

  /**
   * The desktop transport derives its native-fetch hosts from this registry by
   * `.geolibre.app` suffix, and the Tauri capability scope must list the same
   * hosts. A GeoLibre-operated server added here without a matching
   * `http:default` entry would be routed to a client that is not allowed to
   * reach it, so keep the two in sync.
   */
  it("offers exactly one GeoLibre-operated sample server", () => {
    const geoLibreHosts = GEOLENS_SAMPLE_SERVERS.map((server) => new URL(server.baseUrl).host)
      .filter((host) => host.endsWith(".geolibre.app"))
      .sort();
    assert.deepEqual(geoLibreHosts, ["datasets.geolibre.app"]);
  });
});
