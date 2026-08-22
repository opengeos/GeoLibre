import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { WHITEBOX_MENU_CATALOG } from "../apps/geolibre-desktop/src/lib/whitebox-menu-catalog";

const localesDir = fileURLToPath(
  new URL("../apps/geolibre-desktop/src/i18n/locales/", import.meta.url),
);

function leafKeys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

// Collapse i18next plural suffixes so a locale can carry the plural forms its
// language needs (e.g. Russian `_few`/`_many`) without being flagged as having
// keys absent from `en`, which only ships `_one`/`_other`.
function normalizePluralKey(key: string): string {
  return key.replace(/_(zero|one|two|few|many|other)$/, "");
}

function loadCatalog(code: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${localesDir}${code}.json`, "utf8"));
}

// Flatten to a map of dotted key -> string value (skips nested objects).
function flatStrings(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof obj === "string") {
    out.set(prefix, obj);
    return out;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      for (const [kk, vv] of flatStrings(v, prefix ? `${prefix}.${k}` : k)) {
        out.set(kk, vv);
      }
    }
  }
  return out;
}

// The interpolation placeholders / markup tags a translation must carry over
// verbatim: i18next `{{vars}}` and the <tokenLink> markup used by <Trans>.
function placeholders(value: string): string[] {
  return (value.match(/\{\{\s*\w+\s*\}\}|<\/?\w+>/g) ?? []).sort();
}

const localeCodes = readdirSync(localesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""));

describe("i18n catalogs", () => {
  const enKeys = new Set(leafKeys(loadCatalog("en")));
  const enBaseKeys = new Set([...enKeys].map(normalizePluralKey));

  it("ships an English baseline catalog", () => {
    assert.ok(localeCodes.includes("en"));
    assert.ok(enKeys.size > 0);
  });

  for (const code of localeCodes.filter((c) => c !== "en")) {
    it(`${code}: every key exists in the English catalog (no typos/extra keys)`, () => {
      const extra = leafKeys(loadCatalog(code)).filter(
        (k) => !enBaseKeys.has(normalizePluralKey(k)),
      );
      assert.deepEqual(extra, [], `${code}.json has keys absent from en.json: ${extra.join(", ")}`);
    });
  }

  const enStrings = flatStrings(loadCatalog("en"));

  it("covers the WASM-only Whitebox tools used by local Processing mode", () => {
    const en = loadCatalog("en").processing as {
      toolMeta: {
        whitebox: Record<
          string,
          {
            name?: string;
            description?: string;
            params?: Record<string, { label?: string }>;
          }
        >;
      };
      whitebox: { categories: Record<string, string> };
    };
    const zh = loadCatalog("zh").processing as typeof en;
    const tool = en.toolMeta.whitebox.write_geoparquet;
    assert.equal(tool.name, "Write GeoParquet");
    assert.equal(tool.params?.input?.label, "Input");
    assert.equal(zh.toolMeta.whitebox.write_geoparquet.name, "写入 GeoParquet");
    assert.equal(zh.toolMeta.whitebox.write_geoparquet.params?.input?.label, "输入");
    assert.match(zh.toolMeta.whitebox.write_geoparquet.description ?? "", /[\p{Script=Han}]/u);

    assert.deepEqual(
      Object.keys(zh.whitebox.categories).sort(),
      Object.keys(en.whitebox.categories).sort(),
    );
    for (const value of Object.values(zh.whitebox.categories)) {
      assert.match(value, /[\p{Script=Han}]/u);
    }
  });

  it("covers every Whitebox Processing menu key in English and Chinese", () => {
    const subcategoryKey = (label: string) =>
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/_+$/, "");
    const expectedTools = new Map(
      WHITEBOX_MENU_CATALOG.flatMap((category) =>
        category.subcategories.flatMap((subcategory) =>
          subcategory.tools.map((tool) => [tool.id, tool.name] as const),
        ),
      ),
    );
    const expectedSubcategories = new Map(
      WHITEBOX_MENU_CATALOG.flatMap((category) =>
        category.subcategories.map(
          (subcategory) => [subcategoryKey(subcategory.label), subcategory.label] as const,
        ),
      ),
    );
    assert.equal(expectedTools.size, 1066);
    assert.equal(expectedSubcategories.size, 45);

    const untranslatedMenuTools = new Set(["landtrendr", "ripleys_k"]);
    const untranslatedMenuSubcategories = new Set(["geolibre_wasm"]);

    for (const code of ["en", "zh"]) {
      const whitebox = loadCatalog(code).processing as {
        whitebox: {
          menuTool: Record<string, unknown>;
          menuSubcategory: Record<string, unknown>;
        };
      };
      assert.deepEqual(
        Object.keys(whitebox.whitebox.menuTool).sort(),
        [...expectedTools.keys()].sort(),
        `${code}.json Whitebox menuTool keys do not match the menu catalog`,
      );
      assert.deepEqual(
        Object.keys(whitebox.whitebox.menuSubcategory).sort(),
        [...expectedSubcategories.keys()].sort(),
        `${code}.json Whitebox menuSubcategory keys do not match the menu catalog`,
      );
    }

    type WhiteboxMenuCatalog = {
      whitebox: {
        menuTool: Record<string, string>;
        menuSubcategory: Record<string, string>;
      };
    };
    const enWhitebox = loadCatalog("en").processing as WhiteboxMenuCatalog;
    const zhWhitebox = loadCatalog("zh").processing as WhiteboxMenuCatalog;
    for (const [key, value] of expectedTools) {
      assert.equal(enWhitebox.whitebox.menuTool[key], value);
      if (!untranslatedMenuTools.has(key)) {
        assert.notEqual(zhWhitebox.whitebox.menuTool[key], enWhitebox.whitebox.menuTool[key]);
      } else {
        assert.equal(zhWhitebox.whitebox.menuTool[key], value);
      }
    }
    for (const [key, value] of expectedSubcategories) {
      assert.equal(enWhitebox.whitebox.menuSubcategory[key], value);
      if (!untranslatedMenuSubcategories.has(key)) {
        assert.notEqual(
          zhWhitebox.whitebox.menuSubcategory[key],
          enWhitebox.whitebox.menuSubcategory[key],
        );
      } else {
        assert.equal(zhWhitebox.whitebox.menuSubcategory[key], value);
      }
    }
  });

  it("zh covers every Whitebox tool name, parameter label, and description in the baseline", () => {
    type WhiteboxMeta = Record<
      string,
      {
        name: string;
        description?: string;
        params?: Record<string, { label: string; description?: string }>;
      }
    >;
    const enTools = (
      loadCatalog("en").processing as {
        toolMeta: { whitebox: WhiteboxMeta };
      }
    ).toolMeta.whitebox;
    const zhTools = (
      loadCatalog("zh").processing as {
        toolMeta: { whitebox: WhiteboxMeta };
      }
    ).toolMeta.whitebox;
    const untranslatedToolNames = new Set(["LandTrendr", "Ripley's K"]);
    const symbolLabels = /^(?:[A-Z](?:\d+)?|Alpha|Beta|Gamma|Sigma\d?|Epsilon|Kappa|Lambda|D[xy])$/;
    const missing: string[] = [];

    for (const [toolId, tool] of Object.entries(enTools)) {
      const zhTool = zhTools[toolId];
      if (!zhTool?.name || (zhTool.name === tool.name && !untranslatedToolNames.has(tool.name))) {
        missing.push(`${toolId}.name`);
      }
      for (const [paramId, param] of Object.entries(tool.params ?? {})) {
        const zhLabel = zhTool?.params?.[paramId]?.label;
        if (!zhLabel || (zhLabel === param.label && !symbolLabels.test(param.label))) {
          missing.push(`${toolId}.params.${paramId}.label`);
        }
        const zhDescription = zhTool?.params?.[paramId]?.description;
        if (param.description && (!zhDescription || zhDescription === param.description)) {
          missing.push(`${toolId}.params.${paramId}.description`);
        }
      }
      if (tool.description && (!zhTool?.description || zhTool.description === tool.description)) {
        missing.push(`${toolId}.description`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `zh.json has untranslated Whitebox labels or descriptions: ${missing.length}`,
    );
  });

  it("covers the Processing vector toolbar keys in English and Chinese", () => {
    const keys = [
      "decodePolyline",
      "encodePolyline",
      "reproject",
      "explode",
      "aggregate",
      "smooth",
    ];
    for (const code of ["en", "zh"]) {
      const toolbar = loadCatalog(code).toolbar as {
        vectorTool: Record<string, unknown>;
      };
      for (const key of keys) {
        assert.equal(
          typeof toolbar.vectorTool[key],
          "string",
          `${code}.json toolbar.vectorTool.${key}`,
        );
      }
    }
  });

  for (const code of localeCodes.filter((c) => c !== "en")) {
    it(`${code}: preserves interpolation placeholders for translated keys`, () => {
      const strings = flatStrings(loadCatalog(code));
      const mismatches: string[] = [];
      for (const [key, value] of strings) {
        // Compare against the matching en string; for plural variants the en
        // key may differ (e.g. _few has no en counterpart), so fall back to the
        // plural base's _other / _one form.
        const ref =
          enStrings.get(key) ??
          enStrings.get(`${normalizePluralKey(key)}_other`) ??
          enStrings.get(`${normalizePluralKey(key)}_one`);
        if (ref === undefined) continue;
        const want = placeholders(ref);
        const got = placeholders(value);
        if (JSON.stringify(want) !== JSON.stringify(got)) {
          mismatches.push(`${key}: expected [${want}] got [${got}]`);
        }
      }
      assert.deepEqual(mismatches, [], mismatches.join("\n"));
    });
  }

  // Non-English catalogs may be partial (missing keys fall back to en at
  // runtime), so this reports coverage rather than asserting parity — it lets a
  // reviewer see how complete each translation is without failing CI.
  it("reports per-locale coverage vs the English baseline", () => {
    const enBaseList = [...enBaseKeys];
    for (const code of localeCodes.filter((c) => c !== "en")) {
      const have = new Set(leafKeys(loadCatalog(code)).map(normalizePluralKey));
      const missing = enBaseList.filter((k) => !have.has(k));
      const pct = Math.round((1 - missing.length / enBaseList.length) * 100);
      console.log(
        `  ${code}: ${pct}% (${enBaseList.length - missing.length}/${enBaseList.length})` +
          (missing.length ? ` — missing: ${missing.join(", ")}` : ""),
      );
    }
    assert.ok(true);
  });
});
