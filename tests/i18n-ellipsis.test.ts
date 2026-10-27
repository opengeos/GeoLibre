import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const enPath = join(repoRoot, "apps/geolibre-desktop/src/i18n/locales/en.json");

function flatStrings(obj: unknown, prefix = ""): [string, string][] {
  if (typeof obj === "string") return [[prefix, obj]];
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flatStrings(v, prefix ? `${prefix}.${k}` : k),
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// A `t("some.key", "Fallback...")` pair: the fallback shows whenever the
// catalog is not loaded, so it must match the en.json value's ellipsis. The
// fallback runs to its own closing quote, skipping escaped characters, so
// "We're searching..." and "Say \"hi\" and wait..." both match. A backslash
// only ever starts an escape pair, which keeps the scan linear.
const FALLBACK_PAIR = /["']([\w-]+(?:\.[\w-]+)+)["']\s*,\s*(["'`])((?:\\.|(?!\2)[^\\\n])*\.{3})\2/g;

describe("en.json ellipses", () => {
  it("ends strings with the single … character, not three dots", () => {
    const en = JSON.parse(readFileSync(enPath, "utf8"));
    // Three dots inside a value (URL placeholders like https://.../MapServer)
    // are left alone; only a trailing "..." is prose that should read "…".
    const offenders = flatStrings(en)
      .filter(([, value]) => /\.{3}$/.test(value))
      .map(([key]) => key);
    assert.deepEqual(offenders, [], `Use "…" instead of "...": ${offenders.join(", ")}`);
  });

  it("keeps code fallbacks for en.json keys on the … character", () => {
    const keys = new Set(flatStrings(JSON.parse(readFileSync(enPath, "utf8"))).map(([key]) => key));
    const offenders = ["packages", "apps/geolibre-desktop/src"]
      .flatMap((dir) => sourceFiles(join(repoRoot, dir)))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(FALLBACK_PAIR)]
          .filter(([, key]) => keys.has(key))
          .map(([, key]) => `${file.slice(repoRoot.length)}: ${key}`),
      );
    assert.deepEqual(offenders, [], `Use "…" instead of "...": ${offenders.join(", ")}`);
  });

  it("finds a three-dot fallback past an escaped quote", () => {
    const source = String.raw`t("key.path", "Say \"hi\" and wait...")`;
    const match = [...source.matchAll(FALLBACK_PAIR)][0];
    assert.equal(match?.[1], "key.path");
    assert.equal(match?.[3], String.raw`Say \"hi\" and wait...`);
  });
});
