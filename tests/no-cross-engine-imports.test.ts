import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import local from "../eslint-rules/index.mjs";
import { engineOf } from "../eslint-rules/no-cross-engine-imports.mjs";

const MAP_SRC = "packages/map/src";

function lint(code: string, file: string): string[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(
    code,
    [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: {
          parser: tseslint.parser as Linter.Parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { local },
        rules: { "local/no-cross-engine-imports": "error" },
      },
    ],
    `${MAP_SRC}/${file}`,
  );
  return messages.map((m) => m.message);
}

describe("engineOf", () => {
  it("classifies engine files by their prefix or legacy name", () => {
    assert.equal(engineOf("arcgis-layers.ts"), "arcgis");
    assert.equal(engineOf("./ArcgisCanvas"), "arcgis");
    assert.equal(engineOf("cesium-layer-sync.ts"), "cesium");
    assert.equal(engineOf("CesiumCanvas.tsx"), "cesium");
    assert.equal(engineOf("mapbox-layers"), "mapbox");
    assert.equal(engineOf("MapboxCanvas.tsx"), "mapbox");
    assert.equal(engineOf("layer-sync.ts"), "maplibre");
    assert.equal(engineOf("./map-controller"), "maplibre");
    assert.equal(engineOf("MapCanvas.tsx"), "maplibre");
    assert.equal(engineOf("SecondaryMapCanvas.tsx"), "maplibre");
  });

  it("treats shared modules and the Mapbox style-format modules as neutral", () => {
    assert.equal(engineOf("pmtiles-archive.ts"), null);
    assert.equal(engineOf("./gl-style-compiler"), null);
    assert.equal(engineOf("map-engine.ts"), null);
    assert.equal(engineOf("map-capture.ts"), null);
    assert.equal(engineOf("./mapbox-style"), null);
    assert.equal(engineOf("mapbox-style-export.ts"), null);
    assert.equal(engineOf("mapbox-style-import.ts"), null);
  });
});

describe("local/no-cross-engine-imports", () => {
  it("reports an engine file importing another engine's file, in every import form", () => {
    const messages = lint(
      [
        'import { a } from "./cesium-protocol-imagery";',
        'import type { B } from "./MapCanvas";',
        'export { c } from "./mapbox-layers";',
        'export * from "./layer-sync";',
        'const d = () => import("./cesium-engine");',
        'type E = import("./map-controller").MapController;',
      ].join("\n"),
      "arcgis-layers.ts",
    );
    assert.equal(messages.length, 6);
    assert.match(messages[0], /arcgis module imports `\.\/cesium-protocol-imagery`, a cesium/);
  });

  it("allows the same engine's files and neutral modules", () => {
    const code = [
      'import { a } from "./cesium-camera";',
      'import { b } from "./feature-style";',
      'import { c } from "./mapbox-style";',
      'import { d } from "@geolibre/core";',
      'import { e } from "maplibre-gl";',
    ].join("\n");
    assert.deepEqual(lint(code, "cesium-layer-sync.ts"), []);
  });

  it("leaves neutral modules free to import any engine", () => {
    const code = 'import { a } from "./layer-sync";\nimport { b } from "./arcgis-engine";';
    assert.deepEqual(lint(code, "headless.ts"), []);
  });

  it("ignores relative imports that leave the directory", () => {
    assert.deepEqual(lint('import { a } from "../../core/src/arcgis-x";', "MapboxCanvas.tsx"), []);
  });
});
