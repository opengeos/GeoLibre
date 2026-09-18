import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { toPublishManifest } from "../scripts/prepare-npm-package.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function manifest(workspace: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repoRoot, workspace, "package.json"), "utf8"));
}

describe("toPublishManifest", () => {
  it("hoists the entry fields npm ignores inside publishConfig", () => {
    const published = toPublishManifest({
      name: "@scope/pkg",
      version: "1.0.0",
      main: "./src/index.ts",
      types: "./src/index.ts",
      exports: { ".": "./src/index.ts" },
      publishConfig: {
        access: "public",
        main: "./dist/index.mjs",
        types: "./dist/index.d.mts",
        exports: { ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" } },
      },
    });

    assert.equal(published.main, "./dist/index.mjs");
    assert.equal(published.types, "./dist/index.d.mts");
    assert.deepEqual(published.exports, {
      ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    });
    // Only publish-time npm config is left behind.
    assert.deepEqual(published.publishConfig, { access: "public" });
  });

  it("pins a '*' workspace dependency to the version being published", () => {
    const published = toPublishManifest(
      {
        name: "@scope/b",
        version: "2.0.0",
        dependencies: { "@scope/a": "*", "maplibre-gl": "^6.3.0" },
      },
      (name) => (name === "@scope/a" ? "2.0.0" : undefined),
    );

    assert.deepEqual(published.dependencies, { "@scope/a": "^2.0.0", "maplibre-gl": "^6.3.0" });
  });

  it("leaves a '*' range alone when it names no workspace", () => {
    const published = toPublishManifest({
      name: "@scope/b",
      version: "2.0.0",
      dependencies: { "some-package": "*" },
    });

    assert.deepEqual(published.dependencies, { "some-package": "*" });
  });

  it("publishes core and map from dist, with core pinned to the same version", () => {
    const core = manifest("packages/core");
    const map = manifest("packages/map");
    const version = (name: string) => (name === core.name ? (core.version as string) : undefined);

    const publishedCore = toPublishManifest(core, version) as Record<string, string>;
    const publishedMap = toPublishManifest(map, version) as Record<string, string> & {
      dependencies: Record<string, string>;
      exports: Record<string, unknown>;
    };

    assert.equal(publishedCore.main, "./dist/index.mjs");
    assert.equal(publishedMap.main, "./dist/headless.mjs");
    assert.equal(publishedMap.dependencies["@geolibre/core"], `^${core.version}`);
    // Every subpath the repo exports stays reachable from the published package.
    assert.deepEqual(Object.keys(publishedMap.exports), Object.keys(map.exports as object));
  });

  // The build scripts are not part of `npm run ci`, so nothing else notices if
  // a published entry names a file tsdown does not emit -- which would leave a
  // consumer with no types (or no module at all) and no error anywhere here.
  it("only publishes files the package's own tsdown entries produce", () => {
    for (const workspace of ["packages/core", "packages/map"]) {
      const pkg = manifest(workspace) as {
        scripts: { build: string };
        publishConfig: Record<string, unknown>;
      };
      const entries = pkg.scripts.build
        .split(/\s+/)
        .filter((token) => token.startsWith("src/") && token.endsWith(".ts"))
        .map((token) => path.basename(token, ".ts"));
      assert.ok(entries.length > 0, `${workspace}: no tsdown entries found`);
      // `tsdown --format esm --dts` writes dist/<entry>.mjs and .d.mts.
      const emitted = new Set(
        entries.flatMap((name) => [`./dist/${name}.mjs`, `./dist/${name}.d.mts`]),
      );

      const published = toPublishManifest(manifest(workspace)) as Record<string, unknown>;
      const targets = JSON.stringify([published.main, published.types, published.exports]).match(
        /\.\/dist\/[^"]+/g,
      );
      for (const target of targets ?? []) {
        assert.ok(emitted.has(target), `${workspace}: ${target} is not emitted by the build`);
      }
    }
  });

  it("declares public access so the scoped packages are not published private", () => {
    for (const workspace of ["packages/core", "packages/map"]) {
      const published = toPublishManifest(manifest(workspace)) as {
        publishConfig: { access?: string };
      };
      assert.equal(published.publishConfig.access, "public", workspace);
    }
  });
});
