import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// The run_python tool description is the model's only reference for the
// in-app `geolibre` console API, so its examples have to match
// console_api.py. They drifted once (issue #2397): the description showed
// `add_geojson(name, data)` while the real method is data-first, so every
// model-written call raised a TypeError.
const toolsSource = readFileSync(
  fileURLToPath(new URL("../apps/geolibre-desktop/src/lib/assistant/tools.ts", import.meta.url)),
  "utf8",
);
const consoleApiSource = readFileSync(
  fileURLToPath(
    new URL("../apps/geolibre-desktop/src/lib/pyodide/console_api.py", import.meta.url),
  ),
  "utf8",
);

/** The positional parameter names of a `def <name>(self, ...)` in console_api.py. */
function consoleApiParams(method: string): string[] {
  const match = new RegExp(`def ${method}\\(self,([^)]*)\\)`).exec(consoleApiSource);
  assert.ok(match, `console_api.py has no ${method} method`);
  return match[1]
    .split(",")
    .map((param) => param.trim().split("=")[0].trim())
    .filter((param) => param.length > 0 && !param.startsWith("*"));
}

/** The argument text of a `geolibre.<method>(...)` example in the tool descriptions. */
function describedArgs(method: string): string[] {
  const match = new RegExp(`geolibre\\.${method}\\(([^)]*)\\)`).exec(toolsSource);
  assert.ok(match, `no geolibre.${method}() example in tools.ts`);
  return match[1]
    .split(",")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
}

describe("run_python tool description", () => {
  it("documents add_geojson data-first, as console_api.py defines it", () => {
    const params = consoleApiParams("add_geojson");
    assert.deepEqual(params, ["data", "name"]);

    const args = describedArgs("add_geojson");
    assert.equal(args[0], "data", "the first argument must be the GeoJSON data, not the name");
    assert.ok(
      args.slice(1).every((arg) => arg.includes("=")),
      "every argument after the data must be passed by keyword",
    );
    for (const arg of args.slice(1)) {
      const keyword = arg.split("=")[0].trim();
      assert.ok(params.includes(keyword), `add_geojson has no ${keyword} parameter`);
    }
  });

  it("only names methods the console API actually defines", () => {
    const mentioned = new Set(
      [...toolsSource.matchAll(/geolibre\.(\w+)\(/g)].map(([, method]) => method),
    );
    // Guard the loop below against a regex that quietly matches nothing.
    assert.ok(mentioned.size > 0, "no geolibre.*() examples found in tools.ts");
    for (const method of mentioned) {
      assert.match(
        consoleApiSource,
        new RegExp(`def ${method}\\(`),
        `tools.ts mentions geolibre.${method}(), which console_api.py does not define`,
      );
    }
  });
});
