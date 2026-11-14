import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// app.resolvePluginAssetUrl and app.readPluginAsset must name the same file for
// a URL-installed plugin (#3448). The read used to encode the path while the
// resolver did not, so an asset name with "#" or "?" resolved to a truncated
// URL. external-plugins pulls in browser-only modules through its import chain,
// so it is imported lazily in `before`, after the shims below are installed.
type ExternalPlugins = typeof import("../apps/geolibre-desktop/src/lib/external-plugins");

const BASE = "http://localhost:7778/asset-demo/";
const MANIFEST_URL = `${BASE}plugin.json`;
const ASSET_NAMES = ["data/run #1.json", "data/what?.json", "data/100%.json", "data/my file.json"];

// Files the fetch shim serves, keyed by the exact URL path (only the loader's
// own cache token is stripped), so a truncated or mis-encoded URL 404s.
const served = new Map<string, string>([
  [
    MANIFEST_URL,
    JSON.stringify({ id: "asset-demo", name: "Asset Demo", version: "1.0.0", entry: "entry.js" }),
  ],
  [
    `${BASE}entry.js`,
    `export default { id: "asset-demo", name: "Asset Demo", version: "1.0.0",
       activate() {}, deactivate() {} };`,
  ],
]);
for (const name of ASSET_NAMES) {
  const encoded = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  served.set(`${BASE}${encoded}`, JSON.stringify({ name }));
}

const SHIMMED_GLOBALS = ["self", "localStorage", "document", "fetch", "Blob"] as const;

/**
 * Install the minimal browser globals the plugin loader touches in Node.
 *
 * Returns a function that puts back every global and `URL` static it replaced.
 */
function installBrowserShims(): () => void {
  const globals = globalThis as Record<string, unknown>;
  const saved = SHIMMED_GLOBALS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globals, key)] as const,
  );
  const { createObjectURL, revokeObjectURL } = URL;
  globals.self = globalThis;
  const storage = new Map<string, string>();
  globals.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  globals.document = { getElementById: () => null };
  globals.fetch = (input: unknown) => {
    const url = new URL(String(input));
    url.searchParams.delete("__geolibre_plugin_cache");
    const body = served.get(url.toString());
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
  // importExternalPlugin evaluates the entry through a blob URL; Node has no
  // object URLs, so hand back an equivalent data: URL.
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
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
    }
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  };
}

describe("plugin asset URL and read APIs agree", () => {
  let externalPlugins: ExternalPlugins;
  let manager: PluginManager;
  let restoreGlobals: () => void = () => undefined;
  const app = {} as GeoLibreAppAPI;

  before(async () => {
    restoreGlobals = installBrowserShims();
    externalPlugins = await import("../apps/geolibre-desktop/src/lib/external-plugins");
    const { PluginManager: PluginManagerCtor } =
      await import("../packages/plugins/src/plugin-manager");
    manager = new PluginManagerCtor();
    const result = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.loadedPluginIds, ["asset-demo"]);
  });

  after(() => {
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
    restoreGlobals();
  });

  for (const name of ASSET_NAMES) {
    it(`resolves and reads the same file for ${JSON.stringify(name)}`, async () => {
      const url = externalPlugins.resolvePluginAssetUrlForLoadedPlugin("asset-demo", name);
      assert.ok(url, "expected a resolved URL");
      const fetched = await fetch(url);
      assert.equal(fetched.ok, true, `resolved URL 404s: ${url}`);
      assert.deepEqual(await fetched.json(), { name });

      const bytes = await externalPlugins.readPluginAssetForLoadedPlugin("asset-demo", name);
      assert.ok(bytes, "expected readPluginAsset to find the file");
      assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), { name });
    });
  }
});
