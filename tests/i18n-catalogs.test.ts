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
      assert.deepEqual(
        extra,
        [],
        `${code}.json has keys absent from en.json: ${extra.join(", ")}`,
      );
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
