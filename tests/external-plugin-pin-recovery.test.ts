import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { PluginManager } from "../packages/plugins/src/plugin-manager";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";
import { strToU8, zipSync } from "fflate";
import { setDeploymentPolicy } from "../apps/geolibre-desktop/src/lib/deployment-env";

// Recovering from a SHA-256 pin block (#2318). external-plugins pulls in
// browser-only modules through its import chain, so the module is imported
// lazily in `before`, after the shims below are installed.
type ExternalPlugins = typeof import("../apps/geolibre-desktop/src/lib/external-plugins");
type PluginIntegrity = typeof import("../apps/geolibre-desktop/src/lib/plugin-integrity");
type PluginRegistry = typeof import("../apps/geolibre-desktop/src/lib/plugin-registry");
type PluginBlocklist = typeof import("../apps/geolibre-desktop/src/lib/plugin-blocklist");

const app = {} as GeoLibreAppAPI;
const MANIFEST_URL = "http://localhost:7777/pin-demo/plugin.json";
const ENTRY_URL = "http://localhost:7777/pin-demo/entry.js";

// Files the fetch shim serves, keyed by absolute URL.
let served = new Map<string, string>();
let storage = new Map<string, string>();
let requests: string[] = [];

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
    requests.push(url.split("?")[0]);
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
  let registry: PluginRegistry;
  let blocklist: PluginBlocklist;
  let PluginManagerCtor: typeof PluginManager;
  let manager: PluginManager;

  before(async () => {
    installBrowserShims();
    externalPlugins = await import("../apps/geolibre-desktop/src/lib/external-plugins");
    integrity = await import("../apps/geolibre-desktop/src/lib/plugin-integrity");
    registry = await import("../apps/geolibre-desktop/src/lib/plugin-registry");
    blocklist = await import("../apps/geolibre-desktop/src/lib/plugin-blocklist");
    ({ PluginManager: PluginManagerCtor } = await import("../packages/plugins/src/plugin-manager"));
  });

  beforeEach(() => {
    storage = new Map();
    served = pluginBundle();
    requests = [];
    manager = new PluginManagerCtor();
  });

  afterEach(() => {
    // external-plugins keeps its loaded-source map at module scope, so a plugin
    // left registered by one test would be skipped as "already loaded" by the
    // next. Uninstalling every URL is the same teardown the app performs.
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
    blocklist.setPluginBlocklist([]);
  });

  it("reports a blocked ID before fetching entry or style, even when allowed", async () => {
    served.set(
      MANIFEST_URL,
      JSON.stringify({
        id: "pin-demo",
        name: "Pin Demo",
        version: "1.0.0",
        entry: "entry.js",
        style: "style.css",
      }),
    );
    const result = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], {
      policy: { version: 1, plugins: { blocked: ["pin-demo"], allowed: ["pin-demo"] } },
    });
    assert.deepEqual(result.loadedPluginIds, []);
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(requests, [MANIFEST_URL]);
    assert.equal(result.issues[0].sourceUrl, MANIFEST_URL);
    assert.match(result.issues[0].message, /blocked by deployment policy/);
  });

  it("allowed empty denies URLs but exempts bundled drop-ins", async () => {
    const policy = { version: 1 as const, plugins: { allowed: [] } };
    const denied = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], {
      policy,
    });
    assert.deepEqual(requests, [MANIFEST_URL]);
    assert.match(denied.issues[0].message, /not allowed/);
    requests = [];
    const bundled = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], {
      policy,
      bundledManifestUrls: [MANIFEST_URL],
    });
    assert.deepEqual(bundled.loadedPluginIds, ["pin-demo"]);
    assert.deepEqual(bundled.issues, []);
    assert.deepEqual(requests, [MANIFEST_URL, ENTRY_URL]);
  });

  it("sideload false denies stored manual URLs but permits registry URLs", async () => {
    const policy = { version: 1 as const, plugins: { sideload: false } };
    const denied = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], {
      policy,
    });
    assert.deepEqual(requests, []);
    assert.match(denied.issues[0].message, /sideloading/);
    const registry = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], {
      policy,
      registryManifestUrls: [MANIFEST_URL],
    });
    assert.deepEqual(registry.loadedPluginIds, ["pin-demo"]);
    assert.deepEqual(registry.issues, []);
  });

  it("reports every configured directory denied by sideload policy without scanning it", async () => {
    const globals = globalThis as Record<string, unknown>;
    const originalWindow = globals.window;
    globals.window = {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { additionalPluginDirectories: string[] }) => {
          assert.equal(command, "load_external_plugin_bundles");
          if (args.additionalPluginDirectories.length > 0) {
            throw new Error("Policy-denied directories must not be read.");
          }
          return { pluginsDirectories: [], bundles: [], errors: [] };
        },
      },
    };
    const directories = ["/plugins/manual", "/plugins/project"];
    const policy = { version: 1 as const, plugins: { sideload: false } };
    try {
      for (const filteredByHook of [false, true]) {
        const result = await externalPlugins.loadExternalPlugins(
          manager,
          filteredByHook ? [] : directories,
          [],
          { policy, ...(filteredByHook ? { configuredPluginDirectories: directories } : {}) },
        );
        assert.deepEqual(result.loadedPluginIds, []);
        assert.deepEqual(
          result.issues.map((issue) => issue.archiveName),
          directories,
        );
        for (const issue of result.issues) {
          assert.deepEqual(issue.policyDenial, {
            kind: "sideload-disabled",
            pluginId: "",
          });
          assert.match(issue.message, /sideloading is disabled by deployment policy/);
        }
      }
    } finally {
      if (originalWindow === undefined) delete globals.window;
      else globals.window = originalWindow;
    }
  });

  it("programmatic archive installation refuses before unpacking with a load issue", async () => {
    await assert.rejects(
      externalPlugins.installWebPluginArchive(manager, "denied.zip", new Uint8Array(), app, {
        version: 1,
        plugins: { sideload: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof externalPlugins.PluginPolicyError);
        assert.equal(error.archiveName, "denied.zip");
        assert.equal(error.policyDenial.kind, "sideload-disabled");
        assert.equal(error.policyDenial.pluginId, "");
        return true;
      },
    );
    assert.deepEqual(manager.list(), []);
  });

  it("blocked archive code is not evaluated or persisted", async () => {
    const bytes = zipSync({
      "plugin.json": strToU8(served.get(MANIFEST_URL)!),
      "entry.js": strToU8("throw new Error('archive entry executed');"),
    });
    await assert.rejects(
      externalPlugins.installWebPluginArchive(manager, "blocked.zip", bytes, app, {
        version: 1,
        plugins: { blocked: ["pin-demo"] },
      }),
      (error: unknown) => {
        assert.ok(error instanceof externalPlugins.PluginPolicyError);
        assert.equal(error.archiveName, "blocked.zip");
        assert.equal(error.policyDenial.kind, "blocked");
        assert.equal(error.policyDenial.pluginId, "pin-demo");
        return true;
      },
    );
    assert.deepEqual(manager.list(), []);
    assert.deepEqual(await externalPlugins.listInstalledWebPlugins(), []);
  });

  it("policy defaultActive activates only on fresh-project restore", async () => {
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], {
      policy: { version: 1, plugins: { defaultActive: ["pin-demo"] } },
    });
    assert.equal(manager.isActive("pin-demo"), false);
    manager.restoreProjectState(null, app);
    assert.equal(manager.isActive("pin-demo"), true);
    manager.restoreProjectState(
      { manifestUrls: [], activePluginIds: [], mapControlPositions: {}, settings: {} },
      app,
    );
    assert.equal(manager.isActive("pin-demo"), false);
  });

  it("URL updates preserve deployment defaults for later fresh projects", async () => {
    const policy = { version: 1 as const, plugins: { defaultActive: ["pin-demo"] } };
    const emptyState = {
      manifestUrls: [],
      activePluginIds: [],
      mapControlPositions: {},
      settings: {},
    };
    try {
      for (const useRuntimePolicy of [false, true]) {
        served = pluginBundle();
        manager = new PluginManagerCtor();
        setDeploymentPolicy(useRuntimePolicy ? policy : null);
        const options = useRuntimePolicy ? {} : { policy };
        await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], options);
        manager.restoreProjectState(null, app);
        assert.equal(manager.isActive("pin-demo"), true);
        served.set(MANIFEST_URL, served.get(MANIFEST_URL)!.replace("1.0.0", "2.0.0"));
        served.set(ENTRY_URL, served.get(ENTRY_URL)!.replace("1.0.0", "2.0.0"));
        const updated = await externalPlugins.reloadExternalUrlPlugin(
          manager,
          MANIFEST_URL,
          app,
          options,
        );
        assert.equal(updated.version, "2.0.0");
        assert.equal(manager.isActive("pin-demo"), true);
        manager.restoreProjectState(emptyState, app);
        assert.equal(manager.isActive("pin-demo"), false);
        manager.restoreProjectState(null, app);
        assert.equal(manager.isActive("pin-demo"), true);
        externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
      }
    } finally {
      setDeploymentPolicy(null);
    }
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

  it("reports a held-back release and loads it through the update action", async () => {
    // Pinned at 0.9.0 with a different hash; the URL now serves 1.0.0.
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64), "0.9.0");

    const blocked = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(blocked.loadedPluginIds, []);
    assert.deepEqual(blocked.issues[0].heldBack, {
      pluginId: "pin-demo",
      pinnedVersion: "0.9.0",
      version: "1.0.0",
    });

    const plugin = await externalPlugins.reloadExternalUrlPlugin(manager, MANIFEST_URL, app);
    assert.equal(plugin.id, "pin-demo");
    assert.equal(manager.list().length, 1);
    assert.equal(integrity.getPluginBundlePinVersion(MANIFEST_URL), "1.0.0");

    // The next launch matches the new pin and loads without a block.
    // Reset the loader's session state (which also drops the pin), restore the
    // pin the update wrote, and load into a fresh manager as a new launch would.
    const pinnedHash = integrity.getPluginBundlePin(MANIFEST_URL) ?? "";
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
    integrity.pinPluginBundle(MANIFEST_URL, pinnedHash, "1.0.0");
    manager = new PluginManagerCtor();
    const next = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(next.issues, []);
    assert.deepEqual(
      manager.list().map((p) => p.id),
      ["pin-demo"],
    );

    // An update for a version other than the one now served is refused.
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64), "0.9.0");
    manager = new PluginManagerCtor();
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    await assert.rejects(
      externalPlugins.reloadExternalUrlPlugin(manager, MANIFEST_URL, app, {
        expectedVersion: "2.0.0",
      }),
      /expected version 2\.0\.0/,
    );
    assert.equal(manager.list().length, 0);
  });

  it("still clears the pin and unregisters when the plugin did load", async () => {
    const loaded = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(loaded.loadedPluginIds, ["pin-demo"]);
    assert.notEqual(integrity.getPluginBundlePin(MANIFEST_URL), null);

    assert.deepEqual(externalPlugins.unloadRemovedUrlPlugins(manager, [], app), ["pin-demo"]);
    assert.equal(manager.list().length, 0);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), null);
  });

  it("registry denial unloads an active plugin without trusting changed code when approval returns", async () => {
    const policy = { version: 1 as const, plugins: { sideload: false } };
    const approved = { policy, registryManifestUrls: [MANIFEST_URL] };
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL], approved);
    manager.activate("pin-demo", app);
    const pinned = integrity.getPluginBundlePin(MANIFEST_URL);
    assert.notEqual(pinned, null);
    assert.deepEqual(externalPlugins.unloadRemovedUrlPlugins(manager, [], app, [MANIFEST_URL]), [
      "pin-demo",
    ]);
    assert.equal(manager.isActive("pin-demo"), false);
    assert.deepEqual(manager.list(), []);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), pinned);
    served.set(ENTRY_URL, `${served.get(ENTRY_URL)}\n// Changed while delisted`);
    const returned = await externalPlugins.loadExternalPlugins(
      manager,
      [],
      [MANIFEST_URL],
      approved,
    );
    assert.deepEqual(returned.loadedPluginIds, []);
    assert.equal(returned.issues[0]?.integrityStatus, "changed");
    assert.deepEqual(manager.list(), []);
    externalPlugins.unloadRemovedUrlPlugins(manager, [], app);
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

  // The hash of the bundle `pluginBundle()` serves, as the registry publishes it.
  async function servedBundleHash(): Promise<string> {
    return integrity.computePluginBundleHash({ entrySource: served.get(ENTRY_URL) ?? "" });
  }

  function registryEntry(bundleSha256: string) {
    return {
      id: "pin-demo",
      name: "Pin Demo",
      version: "1.0.0",
      manifestUrl: MANIFEST_URL,
      bundleSha256,
    };
  }

  it("a registry install loads a bundle that matches the announced hash", async () => {
    registry.pinRegistryEntryBundle(registryEntry(await servedBundleHash()));

    const loaded = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(loaded.issues, []);
    assert.deepEqual(loaded.loadedPluginIds, ["pin-demo"]);
  });

  it("a registry install holds back a bundle that differs from the announced hash", async () => {
    registry.pinRegistryEntryBundle(registryEntry("0".repeat(64)));

    const loaded = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(loaded.loadedPluginIds, []);
    assert.equal(loaded.issues[0]?.integrityStatus, "changed");
    assert.deepEqual(manager.list(), []);
  });

  it("an update refuses, without evaluating it, a bundle that differs from the registry hash", async () => {
    // Held back at 0.9.0; the URL now serves code the registry did not review.
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64), "0.9.0");
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    const flag = "__pinDemoEvaluated";
    served.set(ENTRY_URL, `globalThis.${flag} = true;\n${served.get(ENTRY_URL) ?? ""}`);
    const registryHash = "1".repeat(64);

    await assert.rejects(
      externalPlugins.reloadExternalUrlPlugin(manager, MANIFEST_URL, app, {
        expectedHash: registryHash,
      }),
      /does not match the version the registry lists/,
    );
    assert.equal((globalThis as Record<string, unknown>)[flag], undefined);
    assert.deepEqual(manager.list(), []);
    // The old pin stands, so the rejected code stays held back.
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), "0".repeat(64));
  });

  it("an update accepts a bundle that matches the registry hash and pins it", async () => {
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64), "0.9.0");
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    const registryHash = await servedBundleHash();

    const plugin = await externalPlugins.reloadExternalUrlPlugin(manager, MANIFEST_URL, app, {
      expectedHash: registryHash,
    });
    assert.equal(plugin.id, "pin-demo");
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), registryHash);
    assert.equal(integrity.getPluginBundlePinVersion(MANIFEST_URL), "1.0.0");
  });

  it("concurrent updates share a reload only when they expect the same hash", async () => {
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64), "0.9.0");
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    const registryHash = await servedBundleHash();
    requests = [];

    const reload = (expectedHash: string) =>
      externalPlugins.reloadExternalUrlPlugin(manager, MANIFEST_URL, app, { expectedHash });
    const first = reload(registryHash);
    const same = reload(registryHash);
    // Started while the first reload is in flight, but announcing other code:
    // it must be checked against its own download, not handed the first result.
    const other = reload("1".repeat(64));

    assert.equal(await same, await first);
    await assert.rejects(other, /does not match the version the registry lists/);
    // One download for the two matching calls, a second for the other hash.
    assert.equal(requests.filter((url) => url === MANIFEST_URL).length, 2);
    assert.equal(integrity.getPluginBundlePin(MANIFEST_URL), registryHash);
  });

  it("never loads a bundle the registry blocklist names", async () => {
    blocklist.setPluginBlocklist([
      { id: "pin-demo", bundleSha256: await servedBundleHash(), reason: "Bad release." },
    ]);

    const loaded = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(loaded.loadedPluginIds, []);
    assert.match(loaded.issues[0]?.message ?? "", /blocked by the plugin registry.*Bad release/);
    // Same translated denial as a whole-plugin block.
    assert.equal(loaded.issues[0]?.policyDenial?.kind, "blocklisted");
    assert.deepEqual(manager.list(), []);
  });

  it("refuses, without evaluating it, an update to a blocklisted bundle", async () => {
    integrity.pinPluginBundle(MANIFEST_URL, "0".repeat(64), "0.9.0");
    await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    const flag = "__pinDemoBlocklistEvaluated";
    served.set(ENTRY_URL, `globalThis.${flag} = true;\n${served.get(ENTRY_URL) ?? ""}`);
    blocklist.setPluginBlocklist([
      { id: "pin-demo", bundleSha256: await servedBundleHash(), reason: "Bad release." },
    ]);

    await assert.rejects(
      externalPlugins.reloadExternalUrlPlugin(manager, MANIFEST_URL, app),
      /blocked by the plugin registry: Bad release/,
    );
    assert.equal((globalThis as Record<string, unknown>)[flag], undefined);
    assert.deepEqual(manager.list(), []);
  });

  it("refuses a whole-plugin block through the policy gate", async () => {
    blocklist.setPluginBlocklist([{ id: "pin-demo", reason: "Malware." }]);

    const loaded = await externalPlugins.loadExternalPlugins(manager, [], [MANIFEST_URL]);
    assert.deepEqual(loaded.loadedPluginIds, []);
    assert.match(JSON.stringify(loaded.issues), /blocked by the plugin registry: Malware/);
  });

  it("refuses, without evaluating it, a zip whose bundle is blocklisted", async () => {
    const flag = "__zipBlocklistEvaluated";
    const entrySource = `globalThis.${flag} = true;\n${served.get(ENTRY_URL) ?? ""}`;
    const bytes = zipSync({
      "plugin.json": strToU8(served.get(MANIFEST_URL)!),
      "entry.js": strToU8(entrySource),
    });
    blocklist.setPluginBlocklist([
      {
        id: "pin-demo",
        bundleSha256: await integrity.computePluginBundleHash({ entrySource }),
        reason: "Bad release.",
      },
    ]);

    await assert.rejects(
      externalPlugins.installWebPluginArchive(manager, "bad.zip", bytes, app, null),
      (error: unknown) => {
        assert.ok(error instanceof externalPlugins.PluginPolicyError);
        assert.equal(error.policyDenial.kind, "blocklisted");
        assert.match(error.message, /blocked by the plugin registry: Bad release/);
        return true;
      },
    );
    assert.equal((globalThis as Record<string, unknown>)[flag], undefined);
    assert.deepEqual(manager.list(), []);
  });
});
