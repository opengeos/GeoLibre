import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { TFunction } from "i18next";
import {
  DECK_VIZ_CATEGORY_LABELS,
  listDeckVizLayerDefs,
} from "../packages/plugins/src/plugins/deckgl-viz/registry";
import {
  deckVizCategoryKey,
  deckVizCategoryLabel,
  deckVizKindDescriptionKey,
  deckVizKindLabel,
  deckVizKindLabelKey,
  deckVizRoleKey,
  deckVizRoleLabel,
} from "../apps/geolibre-desktop/src/lib/deck-viz-i18n";

const en = JSON.parse(
  readFileSync(
    new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

function lookup(key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    return node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
  }, en);
}

// A t() that knows only the given entries and otherwise returns defaultValue,
// like i18next does for a key missing from the active and fallback catalogs.
function fakeT(entries: Record<string, string>): TFunction {
  return ((key: string, options?: { defaultValue?: string }) =>
    entries[key] ?? options?.defaultValue ?? key) as unknown as TFunction;
}

describe("Deck.gl Layer dialog catalog keys", () => {
  // The registry is the English source; en.json carries the same text under
  // keys derived from registry ids so translators have something to translate.
  // If this fails after a registry change, update en.json to match.
  it("has an en.json entry matching every registry kind, category, and role", () => {
    const mismatches: string[] = [];
    const expect = (key: string, english: string) => {
      if (lookup(key) !== english) mismatches.push(`${key}: expected ${JSON.stringify(english)}`);
    };
    for (const def of listDeckVizLayerDefs()) {
      expect(deckVizKindLabelKey(def.kind), def.label);
      expect(deckVizKindDescriptionKey(def.kind), def.description);
      for (const role of def.roles) expect(deckVizRoleKey(role.key), role.label);
    }
    for (const [category, label] of Object.entries(DECK_VIZ_CATEGORY_LABELS)) {
      expect(deckVizCategoryKey(category), label);
    }
    assert.deepEqual(mismatches, []);
  });

  it("gives every role key a single label across layer kinds", () => {
    const labels = new Map<string, string>();
    for (const def of listDeckVizLayerDefs()) {
      for (const role of def.roles) {
        const seen = labels.get(role.key);
        assert.ok(seen === undefined || seen === role.label, `role ${role.key} has two labels`);
        labels.set(role.key, role.label);
      }
    }
  });
});

describe("Deck.gl Layer dialog labels", () => {
  const def = { kind: "arc", label: "Arc", description: "Curved arcs." };

  it("uses the active catalog when it has the key", () => {
    const t = fakeT({
      [deckVizKindLabelKey("arc")]: "Arco",
      [deckVizRoleKey("lng")]: "Longitud",
      [deckVizCategoryKey("flow")]: "Flujo",
    });
    assert.equal(deckVizKindLabel(t, def), "Arco");
    assert.equal(deckVizRoleLabel(t, { key: "lng", label: "Longitude" }), "Longitud");
    assert.equal(deckVizCategoryLabel(t, "flow", "Flow / origin-destination"), "Flujo");
  });

  it("falls back to the registry English for a key no catalog has", () => {
    const t = fakeT({});
    assert.equal(deckVizKindLabel(t, def), "Arc");
    assert.equal(deckVizRoleLabel(t, { key: "custom", label: "Custom field" }), "Custom field");
  });
});
