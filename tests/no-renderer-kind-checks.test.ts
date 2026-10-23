import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import local from "../eslint-rules/index.mjs";

function lint(code: string): string[] {
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
        rules: { "local/no-renderer-kind-checks": "error" },
      },
    ],
    "apps/geolibre-desktop/src/example.tsx",
  );
  return messages.map((m) => m.message);
}

describe("local/no-renderer-kind-checks", () => {
  it("reports renderer-kind expressions compared against renderer names", () => {
    const messages = lint(
      [
        'const a = primaryRenderer === "cesium";',
        'const b = s.primaryRenderer !== "maplibre";',
        'const c = "mapbox" == renderer;',
        'const d = engine?.kind === "arcgis";',
        'const e = app.getMapRenderer?.() === "arcgis";',
        'const f = pane.viewKind === "cesium";',
        'const g = this.engine.kind !== "mapbox";',
        'const h = (renderer as string) === "cesium";',
        "const i = renderer === `mapbox`;",
        'const j = activeThreeDTilesRenderer() === "cesium";',
      ].join("\n"),
    );
    assert.equal(messages.length, 10);
    assert.match(messages[0], /renderer name "cesium"/);
    assert.match(messages[0], /MapEngineCapabilities/);
  });

  it("reports switch cases and includes() lists of renderer names", () => {
    const messages = lint(
      [
        "switch (renderer) {",
        '  case "arcgis": break;',
        '  case "cesium": break;',
        "  default: break;",
        "}",
        'const x = ["mapbox", "arcgis"].includes(app.getMapRenderer?.());',
      ].join("\n"),
    );
    assert.equal(messages.length, 3);
  });

  it("reports includes() on a local const list of renderer names", () => {
    const messages = lint(
      [
        'const unsupported = ["cesium"] as const;',
        "function f() { return unsupported.includes(primaryRenderer); }",
        // A `let` list can be reassigned, so it is not resolved.
        'let maybe = ["cesium"];',
        "maybe.includes(renderer);",
      ].join("\n"),
    );
    assert.equal(messages.length, 1);
  });

  it("ignores other kinds that share a renderer's name", () => {
    const messages = lint(
      [
        // An ArcGIS service layer, a catalog entry, an imagery provider.
        'const a = layer.type === "arcgis";',
        'const b = resource.kind === "arcgis";',
        'const c = entry.kind === "arcgis";',
        'const d = target.kind === "cesium";',
        'switch (kind) { case "arcgis": break; }',
        // Not a renderer name.
        'const e = primaryRenderer === "deck";',
        // Assignment and non-equality operators are not checks.
        'const f: string = "cesium";',
        'renderer = "mapbox";',
        'const g = ["mapbox"].includes(layer.type);',
        // Capability gates are the replacement.
        "const h = capabilities.nativeZarr;",
      ].join("\n"),
    );
    assert.deepEqual(messages, []);
  });

  it("honours a reasoned inline disable", () => {
    const messages = lint(
      [
        "// eslint-disable-next-line local/no-renderer-kind-checks -- picks which engine's canvas to mount",
        'const a = primaryRenderer === "mapbox";',
      ].join("\n"),
    );
    assert.deepEqual(messages, []);
  });
});
