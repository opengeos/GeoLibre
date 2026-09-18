import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Recovering from a SHA-256 pin block (#2318). external-plugins pulls in
// browser-only modules through its import chain, so the module is imported
// lazily in `before`, after the shims below are installed.
type ExternalPlugins = typeof import("../apps/geolibre-desktop/src/lib/external-plugins");
type PluginIntegrity = typeof import("../apps/geolibre-desktop/src/lib/plugin-integrity");

const app = {} as GeoLibreAppAPI;
const MANIFEST_URL = "http://localhost:7777/pin-demo/plugin.json";
const ENTRY_URL = "http://localhost:7777/pin-demo/entry.js";

// Files the fetch shim serves, keyed by absolute URL.
let served = new Map<string, string>();
let storage = new Map<string, string>();

function pluginBundle(): Map<string, string> {
  return new Map([
    [
      MANIFEST_URL,
      JSON.stringify({ id: "pin-demo", name: "Pin Demo", version: "1.0.0", entry: "entry.js" }),
    ],
    [
      ENTRY_URL,
      `export default {
         id: "pin-demo",
         name: "Pin Demo",
         version: "1.0.0",
         activate() {},
         deactivate() {},
       };`,
    ],
  ]);
}

// The loader appends a cache-busting token to asset URLs, so match on the path.
function serve(url: string): string | undefined {
  const withoutQuery = url.split("?")[0];
  return served.get(withoutQuery);
}

function installBrowserShims(): void {
  const globals = globalThis as Record<string, unknown>;
  // shpjs (reached through the plugin-archive import chain) reads `self` at
  // module scope.
  globals.self = globalThis;
  globals.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  // Only the style teardown touches the DOM, and these bundles carry no style.
  globals.document = { getElementById: () => null };
  globals.fetch = (input: unknown) => {
    const url = String(input);
    const body = serve(url);
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404 } as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(JSON.parse(body) as unknown),
      text: () => Promise.resolve(body),
    } as unknown as Response);
  };
  // importExternalPlugin evaluates the entry through a blob URL. Node has no
  // object URLs, so capture the source and hand back an equivalent data: URL,
  // which `import()` does accept. That keeps the real registration path under
  // test instead of stubbing it out.
  class SourceBlob {
    readonly source: string;
    constructor(parts: string[]) {
      this.source = parts.join("");
    }
  }
  globals.Blob = SourceBlob;
  URL.createObjectURL = (blob: unknown) =>
    `data:text/javascript;base64,${Buffer.from((blob as SourceBlob).source).toString("base64")}`;
  URL.revokeObjectURL = () => undefined;
}

describe("recovering a URL plugin blocked by its integrity pin", () => {
  let externalPlugins: ExternalPlugins;
  let integrity: PluginIntegrity;
  let PluginManagerCtor: typeof PluginManager;
  let manager: PluginManager;

  before(async () => {
    installBrowserShims();
    externalPlugins = await import("../apps/geolibre-desktop/src/lib/external-plugins");
    integrity = await import("../apps/geolibre-desktop/src/lib/plugin-integrity");
    ({ PluginManager: PluginManagerCtor } = await import("../packages/plugins/src/plugin-manager"));
  });

  beforeEach(() => {
    storage = new Map();
    served = pluginBundle();
    manager = new PluginManagerCtor();
  });

  afterEach(() => {
    // external-plugins keeps its loaded-source map at module scope, so a plugin
    // left registered by one test would be skipped as "already loaded" by the
    // next. Uninstalling every URL is the same teardown the app performs.
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
  });

  it("clears the pin on uninstall even though the blocked plugin never registered", async () => {
    // A bundle whose hash no longer matches the pin recorded on an earlier
    // visit: held back, so nothing registers and no loaded source is recorded.
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64));

    const blocked = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(blocked.loadedPluginIds, []);
    assert.equal(manager.list().length, 0);
    assert.match(blocked.issues[0].message, /changed since you last trusted it/);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), "0".repeat(64));

    // Uninstalling drops the URL from settings. Before #2318 this left the
    // stale pin behind, because only plugins that had registered were known.
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), null);

    // So reinstalling now re-pins the published bundle and loads it.
    const reinstalled = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(reinstalled.loadedPluginIds, ["pin-demo"]);
    assert.deepEqual(reinstalled.issues, []);
    assert.equal(
      integrity.getPluginBundlePin(MANIFEST_URL),
      await integrity.computePluginBundleHash({
        entrySource: served.get(ENTRY_URL) ?? "",
        styleSource: null,
      }),
    );
  });

  it("still clears the pin and unregisters when the plugin did load", async () => {
    const loaded = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(loaded.loadedPluginIds, ["pin-demo"]);
    assert.notEqual(integrity.getPluginBundlePin(MANIFEST_URL), null);

    assert.deepEqual(externalPlugins.unloadRemovedUrlPlugins(manager, [], app), ["pin-demo"]);
    assert.equal(manager.list().length, 0);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), null);
  });

  it("keeps the pin for a URL that is still installed", async () => {
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    const pinned = integrity.getPluginBundlePin(MANIFEST_URL);
    assert.notEqual(pinned, null);

    externalPlugins.unloadRemovedUrlPlugins(manager, [MANIFEST_URL], app);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), pinned);
    assert.equal(manager.list().length, 1);
  });
});
