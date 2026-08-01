import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createGeoLensHostFetch,
  defaultGeoLensFetch,
  resetGeoLensFetch,
  setGeoLensFetch,
  type GeoLensFetch,
} from "../packages/plugins/src/plugins/geolens-api";

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

  it("uses native HTTP only for datasets.geolibre.app", async () => {
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
    const fetchImpl = createGeoLensHostFetch("datasets.geolibre.app", nativeFetch, browserFetch);

    await fetchImpl("https://datasets.geolibre.app/api/search/datasets/");
    await fetchImpl("https://demo.getgeolens.com/api/search/datasets/");

    assert.deepEqual(calls, [
      "native:https://datasets.geolibre.app/api/search/datasets/",
      "browser:https://demo.getgeolens.com/api/search/datasets/",
    ]);
  });
});
