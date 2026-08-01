import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    assert.deepEqual(geoLibreSampleHosts(), ["datasets.geolibre.app"]);
  });

  /**
   * The other half of that contract: every host `geolens-fetch.ts` routes to
   * the native client must be inside the Tauri `http:default` scope. Narrowing
   * or dropping the capability entry would otherwise leave the transport
   * selecting a client the capability forbids — a runtime failure the
   * registry-only assertion above cannot see.
   */
  it("keeps every natively-routed GeoLens host in the Tauri capability scope", () => {
    const capabilities = JSON.parse(
      readFileSync(
        new URL("../apps/geolibre-desktop/src-tauri/capabilities/default.json", import.meta.url),
        "utf8",
      ),
    ) as { permissions: ({ identifier: string; allow?: { url?: string }[] } | string)[] };
    const httpScope = capabilities.permissions.find(
      (permission) => typeof permission === "object" && permission.identifier === "http:default",
    );
    assert.ok(httpScope && typeof httpScope === "object", "no http:default permission");

    const allowedHosts = new Set(
      (httpScope.allow ?? []).flatMap((entry) =>
        entry.url ? [new URL(entry.url.replace(/\*$/, "")).host] : [],
      ),
    );
    for (const host of geoLibreSampleHosts()) {
      assert.ok(allowedHosts.has(host), `${host} is missing from the http:default scope`);
    }
  });
});

/** GeoLibre-operated GeoLens hosts, derived exactly as `geolens-fetch.ts` does. */
function geoLibreSampleHosts(): string[] {
  return GEOLENS_SAMPLE_SERVERS.map((server) => new URL(server.baseUrl).host)
    .filter((host) => host.endsWith(".geolibre.app"))
    .sort();
}
