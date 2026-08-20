import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import {
  modelProviderCatalog,
  translateModelToolGroup,
  toolGroupKey,
  translateParameter,
  translateToolDescription,
  translateToolGroup,
  translateToolName,
} from "../apps/geolibre-desktop/src/lib/processing-tool-i18n";

function fakeT(catalog: Record<string, string> = {}): TFunction {
  return ((key: string, options?: { defaultValue?: string }) =>
    catalog[key] ?? options?.defaultValue ?? key) as unknown as TFunction;
}

describe("toolGroupKey", () => {
  it("camel-cases a free-text group label", () => {
    assert.equal(toolGroupKey("Geometry"), "geometry");
    assert.equal(toolGroupKey("Raster to Vector"), "rasterToVector");
    assert.equal(toolGroupKey("Data quality"), "dataQuality");
  });

  it("drops punctuation that JSON nesting cannot carry", () => {
    // A dot would split the key into two levels in the catalog; an ampersand
    // would survive but read badly for translators.
    assert.equal(toolGroupKey("Movement & time"), "movementTime");
    assert.equal(toolGroupKey("Vector to Raster"), "vectorToRaster");
    assert.ok(!toolGroupKey("Movement & time").includes("."));
  });

  it("keeps distinct labels distinct", () => {
    assert.notEqual(toolGroupKey("Raster to Vector"), toolGroupKey("Vector to Raster"));
  });

  it("falls back for a label with no word characters", () => {
    assert.equal(toolGroupKey("—"), "other");
  });

  it("can produce an inherited member name", () => {
    // Pins the input behind the null-prototype accumulator in
    // scripts/gen-processing-i18n-catalog.mjs: on a plain object, looking this
    // key up finds Object.prototype.constructor and the generator's collision
    // guard would fire on a group that has no collision at all.
    assert.equal(toolGroupKey("Constructor"), "constructor");
    assert.equal(toolGroupKey("To String"), "toString");
  });
});

describe("tool metadata translation", () => {
  const tool = {
    id: "buffer",
    name: "Buffer",
    description: "Create a buffer polygon around each feature by a fixed distance",
    group: "Geometry",
  };

  it("translates a tool's name and description", () => {
    const t = fakeT({
      "processing.toolMeta.vector.buffer.name": "缓冲区",
      "processing.toolMeta.vector.buffer.description": "围绕每个要素生成缓冲区",
    });
    assert.equal(translateToolName(t, "vector", tool), "缓冲区");
    assert.equal(translateToolDescription(t, "vector", tool), "围绕每个要素生成缓冲区");
  });

  it("falls back to the registry's English text with no catalog entry", () => {
    // English must stay correct without any catalog work, so a newly added tool
    // reads right the moment it is registered.
    const t = fakeT();
    assert.equal(translateToolName(t, "vector", tool), "Buffer");
    assert.equal(translateToolDescription(t, "vector", tool), tool.description);
  });

  it("namespaces by catalog so same-id tools in two registries do not collide", () => {
    // `reproject` is both a vector tool (reproject a GeoJSON layer) and a raster
    // tool (warp a GeoTIFF); one key for both would mistranslate one of them.
    const t = fakeT({
      "processing.toolMeta.vector.reproject.name": "重投影矢量",
      "processing.toolMeta.raster.reproject.name": "重投影栅格",
    });
    assert.equal(
      translateToolName(t, "vector", { id: "reproject", name: "Reproject" }),
      "重投影矢量",
    );
    assert.equal(
      translateToolName(t, "raster", { id: "reproject", name: "Reproject" }),
      "重投影栅格",
    );
  });

  it("returns an empty description for a tool that has none", () => {
    assert.equal(translateToolDescription(fakeT(), "vector", { id: "x", name: "X" }), "");
  });

  it("translates group labels through the shared namespace", () => {
    const t = fakeT({ "processing.toolGroup.movementTime": "移动与时间" });
    assert.equal(translateToolGroup(t, "Movement & time"), "移动与时间");
    assert.equal(translateToolGroup(t, "Geometry"), "Geometry");
  });
});

describe("translateParameter", () => {
  const param = {
    id: "units",
    label: "Units",
    type: "select" as const,
    description: "Distance unit",
    options: [
      { value: "kilometers", label: "Kilometers" },
      { value: "meters", label: "Meters" },
    ],
  };

  it("translates the label, help text and every option label", () => {
    const t = fakeT({
      "processing.toolMeta.vector.buffer.params.units.label": "单位",
      "processing.toolMeta.vector.buffer.params.units.description": "距离单位",
      "processing.toolMeta.vector.buffer.params.units.options.kilometers": "千米",
    });
    const translated = translateParameter(t, "vector", "buffer", param);
    assert.equal(translated.label, "单位");
    assert.equal(translated.description, "距离单位");
    assert.deepEqual(
      translated.options?.map((option) => option.label),
      ["千米", "Meters"],
    );
  });

  it("never mutates the registry's parameter object", () => {
    // The registries are module-level singletons shared by every dialog, so an
    // in-place rewrite would freeze the first-rendered language into them.
    const t = fakeT({ "processing.toolMeta.vector.buffer.params.units.label": "单位" });
    translateParameter(t, "vector", "buffer", param);
    assert.equal(param.label, "Units");
    assert.equal(param.options[0].label, "Kilometers");
  });

  it("leaves a parameter without a description or options alone", () => {
    const plain = { id: "distance", label: "Distance", type: "number" as const };
    const translated = translateParameter(fakeT(), "vector", "buffer", plain);
    assert.equal(translated.description, undefined);
    assert.equal(translated.options, undefined);
    assert.equal(translated.label, "Distance");
  });
});

describe("translateModelToolGroup", () => {
  const t = fakeT({ "processing.toolGroup.terrain": "地形" });

  it("translates a heading whose tools come from an owned catalog", () => {
    assert.equal(
      translateModelToolGroup(t, { group: "Terrain", tools: [{ provider: "vector" }] }),
      "地形",
    );
  });

  it("leaves a Whitebox-only heading verbatim", () => {
    // The WASM catalog ships a lowercase `terrain` category beside the raster
    // registry's `Terrain`; both slug to `terrain`, so translating this one
    // would put two identically-labelled headings in the palette.
    assert.equal(
      translateModelToolGroup(t, { group: "terrain", tools: [{ provider: "whitebox" }] }),
      "terrain",
    );
  });

  it("treats a mixed group as owned", () => {
    assert.equal(
      translateModelToolGroup(t, {
        group: "Terrain",
        tools: [{ provider: "whitebox" }, { provider: "vector" }],
      }),
      "地形",
    );
  });

  it("leaves an empty group verbatim", () => {
    assert.equal(translateModelToolGroup(t, { group: "Terrain", tools: [] }), "Terrain");
  });
});

describe("modelProviderCatalog", () => {
  it("maps the vector provider to its catalog", () => {
    assert.equal(modelProviderCatalog("vector"), "vector");
  });

  it("returns null for metadata GeoLibre does not own", () => {
    // Whitebox tool names/descriptions come from the bundled WASM binary, so
    // the host has no keys for them and must render them verbatim.
    assert.equal(modelProviderCatalog("whitebox"), null);
  });

  it("passes registry text straight through for a null catalog", () => {
    const t = fakeT({ "processing.toolMeta.vector.slope.name": "should not be used" });
    const tool = { id: "slope", name: "Slope", description: "Compute slope" };
    assert.equal(translateToolName(t, null, tool), "Slope");
    assert.equal(translateToolDescription(t, null, tool), "Compute slope");
    const param = { id: "zfactor", label: "Z factor", type: "number" as const };
    assert.equal(translateParameter(t, null, "slope", param), param);
  });
});
