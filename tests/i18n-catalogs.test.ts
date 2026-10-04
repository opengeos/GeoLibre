import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

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

  it("keeps optional Whitebox metadata out of bundled locale catalogs", () => {
    for (const code of localeCodes) {
      const processing = loadCatalog(code).processing as {
        toolMeta?: Record<string, unknown>;
        whitebox?: Record<string, unknown>;
      };
      assert.equal(processing.toolMeta?.whitebox, undefined, `${code}.json bundles Whitebox tools`);
      assert.equal(processing.whitebox?.categories, undefined, `${code}.json bundles categories`);
      assert.equal(processing.whitebox?.menuTool, undefined, `${code}.json bundles menu tools`);
      assert.equal(
        processing.whitebox?.menuSubcategory,
        undefined,
        `${code}.json bundles menu subcategories`,
      );
    }
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

  // Non-English catalogs may lag behind en.json: a missing key falls back to
  // English at runtime, and the catalogs are filled in before each release
  // (the geolibre-i18n audit), so a PR that adds UI strings does not have to
  // touch every catalog. This reports coverage rather than failing. Plural
  // suffixes are normalized: a locale needs the base key in whatever plural
  // forms its language uses (zh drops `_one`, ru adds `_few`/`_many`).
  it("reports per-locale coverage vs the English baseline", () => {
    for (const code of localeCodes.filter((c) => c !== "en")) {
      const have = new Set(leafKeys(loadCatalog(code)).map(normalizePluralKey));
      const missing = [...enBaseKeys].filter((k) => !have.has(k));
      if (missing.length === 0) continue;
      console.log(
        `  ${code}: missing ${missing.length} key(s): ${missing.slice(0, 10).join(", ")}` +
          (missing.length > 10 ? ", …" : ""),
      );
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
});
