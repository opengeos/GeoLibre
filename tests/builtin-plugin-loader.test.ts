import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { GeoLibrePlugin } from "@geolibre/plugins";
import { createBuiltInPluginModules } from "../packages/plugins/src/builtin-plugin-loader";

function plugin(id: string): GeoLibrePlugin {
  return { id, name: id, version: "1.0.0", activate() {}, deactivate() {} };
}

describe("built-in plugin imports", () => {
  it("reads host registries, labels, and the catalog without importing implementations", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "geolibre-catalog-import-"));
    const guard = path.join(directory, "guard.mjs");
    writeFileSync(
      guard,
      `export async function load(url, context, nextLoad) {
      if (url.includes('/packages/plugins/src/plugins/')) throw new Error('IMPLEMENTATION_IMPORT_BLOCKED: ' + url);
      return nextLoad(url, context);
    }`,
    );
    const catalog = new URL("../packages/plugins/src/builtin-plugins.ts", import.meta.url).href;
    const startupEntries = [
      "../apps/geolibre-desktop/src/hooks/toolbar/usePluginLabelSync.ts",
      "../apps/geolibre-desktop/src/hooks/desktop-shell/useTranslatedPluginLabels.ts",
      "../packages/plugins/src/planetary-computer-labels.ts",
      "../packages/plugins/src/runtime.ts",
    ].map((file) => new URL(file, import.meta.url).href);
    const args = [
      "--loader",
      pathToFileURL(guard).href,
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
    ];
    const cwd = fileURLToPath(new URL("../", import.meta.url));
    try {
      const unloaded = spawnSync(
        process.execPath,
        [
          ...args,
          `for (const module of ${JSON.stringify(startupEntries)}) await import(module);
          const catalog = await import(${JSON.stringify(catalog)});
          console.log(catalog.BUILT_IN_PLUGINS.length);`,
        ],
        { cwd, encoding: "utf8" },
      );
      assert.equal(unloaded.status, 0, unloaded.stderr);
      assert.equal(Number(unloaded.stdout.trim()), 72);
      // Positive control: requesting an implementation must reach the guard.
      const requested = spawnSync(
        process.execPath,
        [
          ...args,
          `const catalog = await import(${JSON.stringify(catalog)}); await catalog.loadBuiltInPlugin('geolibre-sun');`,
        ],
        { cwd, encoding: "utf8" },
      );
      assert.equal(requested.status, 1);
      assert.match(requested.stderr, /IMPLEMENTATION_IMPORT_BLOCKED/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads on demand, coalesces callers, and applies the latest host configuration", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let imports = 0;
    let label = "";
    let saver = "";
    const module = {
      setLabel: (value: string) => {
        label = value;
      },
      setSaver: (value: string) => {
        saver = value;
      },
    };
    const loaders = createBuiltInPluginModules({
      catalog: async () => {
        imports++;
        await gate;
        return module;
      },
    });
    loaders.configure("catalog", { io: (loaded) => loaded.setSaver("save") });
    loaders.configure("catalog", { labels: (loaded) => loaded.setLabel("old") });
    assert.equal(imports, 0);
    assert.equal(loaders.peekModule("catalog"), undefined);
    const first = loaders.loadModule("catalog");
    const second = loaders.loadModule("catalog");
    loaders.configure("catalog", { labels: (loaded) => loaded.setLabel("latest") });
    release();
    const [resolved, resolvedModule] = await Promise.all([first, second]);
    assert.equal(resolved, module);
    assert.equal(resolvedModule, module);
    assert.equal(loaders.peekModule("catalog"), module);
    assert.equal(imports, 1);
    assert.equal(label, "latest");
    assert.equal(saver, "save");
    loaders.configure("catalog", { labels: (loaded) => loaded.setLabel("live") });
    assert.equal(label, "live");
    assert.equal(saver, "save");
    assert.equal(await loaders.loadModule("catalog"), module);
    assert.equal(imports, 1);
  });

  it("retries failed imports and host setup without caching the failed result", async () => {
    let imports = 0;
    const module = {};
    const loaders = createBuiltInPluginModules({
      catalog: async () => {
        if (++imports === 1) throw new Error("Import unavailable");
        return module;
      },
    });
    await assert.rejects(loaders.loadModule("catalog"), /Import unavailable/);
    loaders.configure("catalog", {
      host: () => {
        throw new Error("Setup failed");
      },
    });
    await assert.rejects(loaders.loadModule("catalog"), /Setup failed/);
    loaders.configure("catalog", { host: () => {} });
    assert.equal(await loaders.loadModule("catalog"), module);
    assert.equal(imports, 3);
    assert.throws(
      () =>
        loaders.configure("catalog", {
          host: () => {
            throw new Error("Live setup failed");
          },
        }),
      /Live setup failed/,
    );
    assert.equal(loaders.peekModule("catalog"), undefined);
    loaders.configure("catalog", { host: () => {} });
    assert.equal(await loaders.loadModule("catalog"), module);
    assert.equal(imports, 4);
  });

  it("shares one import and configuration across distinct plugin consumers", async () => {
    let imports = 0;
    let configured = 0;
    const module = { first: plugin("first"), second: plugin("second") };
    const loaders = createBuiltInPluginModules({
      shared: async () => {
        imports++;
        return module;
      },
    });
    loaders.configure("shared", {
      host: () => {
        configured++;
      },
    });
    const [first, second] = await Promise.all([
      loaders.loadModule("shared").then((loaded) => loaded.first),
      loaders.loadModule("shared").then((loaded) => loaded.second),
    ]);
    assert.equal(first, module.first);
    assert.equal(second, module.second);
    assert.equal(imports, 1);
    assert.equal(configured, 1);
  });
});
