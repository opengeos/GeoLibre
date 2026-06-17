import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { KIND_I18N_KEY } from "../apps/geolibre-desktop/src/components/layout/add-data/constants";

// The Add Data dialog resolves its title/description with a runtime-interpolated
// key (`t(`addData.kind.${KIND_I18N_KEY[kind]}.label`)`), which TypeScript and
// i18next's typed `t` cannot validate against en.json. Guard the full key shape
// here so a renamed/removed `addData.kind.*` subtree fails CI instead of
// silently rendering the raw key at runtime.
const en = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../apps/geolibre-desktop/src/i18n/locales/en.json", import.meta.url),
    ),
    "utf8",
  ),
) as { addData: { kind: Record<string, { label?: string; description?: string }> } };

describe("Add Data dialog kind i18n keys", () => {
  for (const [kind, key] of Object.entries(KIND_I18N_KEY)) {
    it(`${kind}: addData.kind.${key} has a label and description`, () => {
      const entry = en.addData.kind[key];
      assert.ok(entry, `addData.kind.${key} is missing from en.json`);
      assert.equal(
        typeof entry.label,
        "string",
        `addData.kind.${key}.label is missing or not a string`,
      );
      assert.ok(
        entry.label.trim().length > 0,
        `addData.kind.${key}.label is empty`,
      );
      assert.equal(
        typeof entry.description,
        "string",
        `addData.kind.${key}.description is missing or not a string`,
      );
      assert.ok(
        entry.description.trim().length > 0,
        `addData.kind.${key}.description is empty`,
      );
    });
  }
});
