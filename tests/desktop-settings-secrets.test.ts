import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDesktopSettings } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";
import {
  desktopSettingsSecretAccounts,
  mergeDesktopSettingsSecrets,
  splitDesktopSettingsSecrets,
} from "../apps/geolibre-desktop/src/lib/desktop-settings-secrets";

const GOOGLE_ID = "7d3f5a8e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const OLLAMA_ID = "0c9b8a7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

const settings = normalizeDesktopSettings({
  shareToken: "glb_x",
  aiProfiles: [
    { id: GOOGLE_ID, name: "Gemini", provider: "google", fieldValues: { GEMINI_API_KEY: "AIza1" } },
    {
      id: OLLAMA_ID,
      name: "Local",
      provider: "ollama",
      fieldValues: { OLLAMA_BASE_URL: "http://localhost:11434" },
    },
  ],
});

describe("desktop settings secrets", () => {
  it("moves tokens and secret AI fields out of the public settings", () => {
    const { publicSettings, secrets } = splitDesktopSettingsSecrets(settings);
    assert.equal(publicSettings.shareToken, "");
    assert.deepEqual(publicSettings.aiProfiles[0].fieldValues, {});
    assert.deepEqual(publicSettings.aiProfiles[1].fieldValues, {
      OLLAMA_BASE_URL: "http://localhost:11434",
    });
    assert.deepEqual(secrets, {
      "settings.shareToken": "glb_x",
      [`ai.${GOOGLE_ID}.GEMINI_API_KEY`]: "AIza1",
    });
    assert.equal(settings.shareToken, "glb_x", "the input is not mutated");
  });

  it("merging the split secrets restores the settings", () => {
    const { publicSettings, secrets } = splitDesktopSettingsSecrets(settings);
    assert.deepEqual(mergeDesktopSettingsSecrets(publicSettings, secrets), settings);
  });

  it("reads alias accounts for secret fields but none for non-secret ones", () => {
    const accounts = desktopSettingsSecretAccounts(settings);
    assert.ok(accounts.includes(`ai.${GOOGLE_ID}.GOOGLE_API_KEY`));
    assert.ok(accounts.includes(`ai.${GOOGLE_ID}.GOOGLE_GENAI_API_KEY`));
    assert.ok(!accounts.some((account) => account.startsWith(`ai.${OLLAMA_ID}.`)));
  });
});
