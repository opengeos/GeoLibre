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
