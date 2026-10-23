import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createEmptyProject,
  redactProjectCredentials,
  setRegistryPublishableSettings,
} from "@geolibre/core";
import {
  fetchPluginRegistry,
  reserveBuiltInPluginIds,
} from "../apps/geolibre-desktop/src/lib/plugin-registry";

const realFetch = globalThis.fetch;

function stubRegistry(plugins: unknown[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ plugins }), { status: 200 })) as typeof fetch;
}

function entry(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    version: "1.0.0",
    manifestUrl: `https://example.com/${id}/plugin.json`,
    ...extra,
  };
}

describe("registry publishableSettings", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    setRegistryPublishableSettings([]);
  });

  it("normalizes true, key lists and invalid values", async () => {
    stubRegistry([
      entry("all", { publishableSettings: true }),
      entry("some", { publishableSettings: ["search", " ", 5, "area"] }),
      entry("none", { publishableSettings: "search" }),
      entry("plain"),
    ]);
    const { entries } = await fetchPluginRegistry("https://example.com/registry.json");
    const byId = Object.fromEntries(entries.map((e) => [e.id, e.publishableSettings]));
    assert.equal(byId.all, null);
    assert.deepEqual(byId.some, ["search", "area"]);
    assert.equal(byId.none, undefined);
    assert.equal(byId.plain, undefined);
  });

  it("makes a fetched declaration keep that plugin's state on redaction", async () => {
    stubRegistry([entry("ext", { publishableSettings: ["search"] })]);
    await fetchPluginRegistry("https://example.com/registry.json");
    const project = createEmptyProject("Search");
    project.plugins = {
      manifestUrls: [],
      activePluginIds: ["ext"],
      mapControlPositions: {},
      settings: { ext: { search: "idrografia", secret: "k" } },
    };
    const { project: out } = redactProjectCredentials(project);
    assert.deepEqual(out.plugins!.settings.ext, { search: "idrografia" });
  });

  it("ignores a declaration for a built-in plugin id", async () => {
    reserveBuiltInPluginIds(["builtin-x"]);
    try {
      stubRegistry([entry("builtin-x", { publishableSettings: true })]);
      await fetchPluginRegistry("https://example.com/registry.json");
      const project = createEmptyProject("Built-in");
      project.plugins = {
        manifestUrls: [],
        activePluginIds: [],
        mapControlPositions: {},
        settings: { "builtin-x": { a: 1 } },
      };
      const { project: out } = redactProjectCredentials(project);
      assert.equal(out.plugins!.settings["builtin-x"], undefined);
    } finally {
      reserveBuiltInPluginIds([]);
    }
  });
});
