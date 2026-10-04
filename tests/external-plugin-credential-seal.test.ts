import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type { PluginManager } from "../packages/plugins/src/plugin-manager";

// External plugins run in the app's webview and can call any Tauri command, so
// the desktop loader closes credential-store reads before it evaluates the
// first plugin (issue #2858). external-plugins pulls in browser-only modules
// through its import chain, so it is imported lazily after the shims below.
type ExternalPlugins = typeof import("../apps/geolibre-desktop/src/lib/external-plugins");

/** Commands sent to the native side and plugin evaluations, in order. */
const events: string[] = [];
let sealFails = false;
let bundleIds: string[] = [];

function entrySource(id: string): string {
  return `globalThis.__sealTestEvents.push("evaluate ${id}");
    export default { id: "${id}", name: "${id}", version: "1.0.0", activate() {}, deactivate() {} };`;
}

function installShims(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.__sealTestEvents = events;
  // shpjs (reached through the plugin-archive import chain) reads `self` at
  // module scope.
  globals.self = globalThis;
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  };
  globals.localStorage = localStorage;
  globals.document = { getElementById: () => null };
  globals.window = {
    localStorage,
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string) => {
        events.push(cmd);
        if (cmd === "secure_store_seal") {
          if (sealFails) throw new Error("seal failed");
          return null;
        }
        if (cmd === "load_external_plugin_bundles") {
          return {
            pluginsDirectories: ["/plugins"],
            bundles: bundleIds.map((id) => ({
              archiveName: `${id}.zip`,
              manifest: { id, name: id, version: "1.0.0", entry: "index.js" },
              entrySource: entrySource(id),
            })),
            errors: [],
          };
        }
        throw new Error(`unexpected command ${cmd}`);
      },
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
  };
  // importExternalPlugin evaluates the entry through a blob URL. Node has no
  // object URLs, so hand back an equivalent data: URL, which import() accepts.
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

describe("external plugin loading closes credential reads", () => {
  let externalPlugins: ExternalPlugins;
  let PluginManagerCtor: typeof PluginManager;

  before(async () => {
    installShims();
    externalPlugins = await import("../apps/geolibre-desktop/src/lib/external-plugins");
    ({ PluginManager: PluginManagerCtor } = await import("../packages/plugins/src/plugin-manager"));
  });

  beforeEach(() => {
    events.length = 0;
  });

  // Runs first: the seal is remembered for the rest of the page load.
  it("does not evaluate a plugin when reads could not be closed", async () => {
    sealFails = true;
    bundleIds = ["seal-blocked"];
    const manager = new PluginManagerCtor();
    const result = await externalPlugins.loadExternalPlugins(manager, [], [], { policy: null });
    assert.deepEqual(result.loadedPluginIds, []);
    assert.match(result.issues[0].message, /seal failed/);
    assert.deepEqual(events, ["load_external_plugin_bundles", "secure_store_seal"]);
    sealFails = false;
  });

  it("closes reads before the first plugin is evaluated, and only once", async () => {
    bundleIds = ["seal-first", "seal-second"];
    const manager = new PluginManagerCtor();
    const result = await externalPlugins.loadExternalPlugins(manager, [], [], { policy: null });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.loadedPluginIds, ["seal-first", "seal-second"]);
    assert.deepEqual(events, [
      "load_external_plugin_bundles",
      "secure_store_seal",
      "evaluate seal-first",
      "evaluate seal-second",
    ]);
  });
});
