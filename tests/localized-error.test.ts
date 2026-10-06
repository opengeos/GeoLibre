import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  LocalizedError,
  localizedMessage,
  setLocalizedErrorTranslator,
} from "../packages/plugins/src/localized-error";

describe("LocalizedError", () => {
  afterEach(() => setLocalizedErrorTranslator(null));

  it("keeps the interpolated English without a translator", () => {
    const error = new LocalizedError("a.b", "Failed with {{status}}.", { status: 502 });
    assert.equal(error.message, "Failed with 502.");
    assert.equal(error.englishMessage, "Failed with 502.");
    assert.equal(error.key, "a.b");
    assert.ok(error instanceof Error);
  });

  it("translates through the registered translator at construction", () => {
    const seen: unknown[] = [];
    setLocalizedErrorTranslator((key, defaultValue, params) => {
      seen.push([key, defaultValue, params]);
      return `Fehler ${params?.status}`;
    });
    const error = new LocalizedError("a.b", "Failed with {{status}}.", { status: 502 });
    assert.equal(error.message, "Fehler 502");
    assert.equal(error.englishMessage, "Failed with 502.");
    assert.deepEqual(seen, [["a.b", "Failed with {{status}}.", { status: 502 }]]);
  });

  it("falls back to English when the translator throws or returns nothing", () => {
    setLocalizedErrorTranslator(() => {
      throw new Error("i18n not ready");
    });
    assert.equal(localizedMessage("a.b", "Plain."), "Plain.");
    setLocalizedErrorTranslator(() => "");
    assert.equal(new LocalizedError("a.b", "Plain.").message, "Plain.");
  });

  it("keeps the cause", () => {
    const cause = new Error("root");
    assert.equal(new LocalizedError("a.b", "Wrapped.", undefined, { cause }).cause, cause);
  });
});

// Every LocalizedError / localizedMessage call in the plugins package names a
// catalog key and its English template. The key must exist in en.json with the
// same English, or other locales have nothing to translate and the English
// shown here drifts from the catalog.
describe("LocalizedError catalog keys", () => {
  const en = JSON.parse(
    readFileSync(
      new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const lookup = (key: string): unknown =>
    key.split(".").reduce<unknown>((node, part) => {
      return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    }, en);

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
    });
  }

  const root = new URL("../packages/plugins/src/", import.meta.url).pathname;
  const calls: { file: string; key: string; template: string }[] = [];
  for (const file of sourceFiles(root)) {
    if (file.endsWith("localized-error.ts")) continue;
    const text = readFileSync(file, "utf8");
    // `const ERROR_KEY = "arcgisService.errors";` style prefixes.
    const prefixes = new Map<string, string>();
    for (const m of text.matchAll(/const (\w+) = "([\w.-]+)";/g)) prefixes.set(m[1], m[2]);
    // Constants used as templates, e.g. ARCGIS_MAP_SERVICE_URL_ERROR.
    const constants = new Map<string, string>();
    for (const m of text.matchAll(/export const (\w+) =\s*"((?:[^"\\]|\\.)*)";/g)) {
      constants.set(m[1], JSON.parse(`"${m[2]}"`));
    }
    const pattern =
      /(?:new LocalizedError|localizedMessage)\(\s*(?:"([\w.-]+)"|`\$\{(\w+)\}\.([\w-]+)`)\s*,\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\w+))/g;
    for (const m of text.matchAll(pattern)) {
      const key = m[1] ?? `${prefixes.get(m[2]!)}.${m[3]}`;
      const template =
        m[4] !== undefined
          ? JSON.parse(`"${m[4]}"`)
          : m[5] !== undefined
            ? m[5].replace(/\\'/g, "'")
            : constants.get(m[6]!);
      calls.push({ file: file.slice(root.length), key, template: template ?? `<${m[6]}>` });
    }
  }

  it("finds the call sites", () => {
    // A guard against the scan silently matching nothing after a refactor.
    assert.ok(calls.length >= 30, `only ${calls.length} LocalizedError calls found`);
  });

  it("has an en.json entry with the same English for every key", () => {
    const problems = calls
      .filter(({ key, template }) => lookup(key) !== template)
      .map(
        ({ file, key, template }) =>
          `${file}: ${key} (en.json ${JSON.stringify(lookup(key))}, code ${JSON.stringify(template)})`,
      );
    assert.deepEqual(problems, []);
  });
});
