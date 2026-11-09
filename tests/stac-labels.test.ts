import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TFunction } from "i18next";
import { buildStacLabels } from "../apps/geolibre-desktop/src/lib/stac-labels";

const catalog = JSON.parse(
  readFileSync(
    new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

/** The catalog value at a dotted key, or undefined when any step is missing. */
function lookup(key: string): unknown {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** A translator that records every key asked for and echoes it, so a typo shows up as a miss. */
function recordingTranslator(asked: string[]): TFunction {
  return ((key: string) => {
    asked.push(key);
    return key;
  }) as unknown as TFunction;
}

test("every string the STAC panel asks for is in the English catalog", () => {
  const asked: string[] = [];
  const t = recordingTranslator(asked);
  const labels = buildStacLabels(t, { t });
  // Labels built from a function ask for their key only when called, so call each one.
  for (const value of Object.values(labels)) {
    if (typeof value === "function") {
      (value as (...args: unknown[]) => unknown)("group", 1, 2);
    }
  }
  assert.ok(asked.length > 100, "builds the whole label set");
  const missing = [...new Set(asked)].filter((key) => typeof lookup(key) !== "string");
  assert.deepEqual(missing, [], "every key resolves to a string in en.json");
});

test("the new search, menu and rendering labels are all provided", () => {
  const t = recordingTranslator([]);
  const labels = buildStacLabels(t, { t });
  for (const key of [
    "areaLabel",
    "drawPoint",
    "drawLine",
    "drawPolygon",
    "useSelection",
    "loadAreaFile",
    "clearArea",
    "bufferLabel",
    "cloudLabel",
    "sortLabel",
    "sortNewest",
    "sortOldest",
    "addAsset",
    "addRendering",
    "groupCombinations",
    "groupIndices",
  ] as const) {
    assert.equal(typeof labels[key], "string", `${key} is a string`);
  }
  assert.equal(typeof labels.areaSet, "function");
  assert.equal(typeof labels.renderMissingBand, "function");
});

test("the panel title follows later language changes", () => {
  let language = "en";
  const t = ((key: string) => `${language}:${key}`) as unknown as TFunction;
  const labels = buildStacLabels(t, { t });
  const first = labels.title;
  language = "fr";
  // The static value was fixed when built; the getter reads the language as it is now.
  assert.equal(first, "en:stacPlugin.title");
  assert.equal(labels.getTitle?.(), "fr:stacPlugin.title");
});
