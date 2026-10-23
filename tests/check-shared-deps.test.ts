import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  declaredDependencies,
  findRangeMismatches,
  MANIFESTS,
} from "../scripts/check-shared-deps.mjs";

describe("check-shared-deps", () => {
  it("reports a dependency shared with different ranges", () => {
    const app = {
      dependencies: { "maplibre-gl-lidar": "^0.21.0", shared: "^1.0.0", appOnly: "^2.0.0" },
    };
    const plugins = {
      dependencies: { "maplibre-gl-lidar": "^0.20.0", shared: "^1.0.0", pluginsOnly: "^3.0.0" },
    };
    assert.deepEqual(findRangeMismatches(app, plugins), [
      {
        name: "maplibre-gl-lidar",
        a: { range: "^0.21.0", section: "dependencies" },
        b: { range: "^0.20.0", section: "dependencies" },
      },
    ]);
  });

  it("compares across dependency sections", () => {
    const app = { devDependencies: { typescript: "^5.0.0" } };
    const plugins = { peerDependencies: { typescript: "^5.1.0" } };
    assert.deepEqual(findRangeMismatches(app, plugins), [
      {
        name: "typescript",
        a: { range: "^5.0.0", section: "devDependencies" },
        b: { range: "^5.1.0", section: "peerDependencies" },
      },
    ]);
  });

  it("prefers the runtime section when a manifest lists a package twice", () => {
    const declared = declaredDependencies({
      devDependencies: { pkg: "^2.0.0" },
      dependencies: { pkg: "^1.0.0" },
    });
    assert.deepEqual(declared.get("pkg"), { range: "^1.0.0", section: "dependencies" });
  });

  it("passes on the checked-in manifests", () => {
    const [app, plugins] = MANIFESTS.map(
      (file) =>
        JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")) as Record<
          string,
          unknown
        >,
    );
    assert.deepEqual(findRangeMismatches(app, plugins), []);
  });
});
