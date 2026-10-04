import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  changedPreferenceCredentials,
  createEmptyProject,
  overlayStoredPreferenceCredentials,
  redactProjectCredentials,
  setProjectCredentialLookup,
  resolveProjectHeaderReferences,
  splitProjectCredentials,
  useAppStore,
  type ProjectPreferences,
} from "@geolibre/core";

function projectWithCredentials() {
  const project = createEmptyProject("Keychain fixture");
  project.preferences.geocoding = {
    ...project.preferences.geocoding,
    apiKeys: { mapbox: "gk" },
  };
  project.preferences.environmentVariables = [
    { key: "GOOGLE_MAPS_API_KEY", value: "g1", enabled: true },
    { key: "ENDPOINT", value: "https://x", enabled: true, secret: false },
  ];
  project.layers = [
    {
      id: "tiles-1",
      name: "Tiles",
      type: "3d-tiles",
      source: {
        url: "https://t/tileset.json",
        requestHeaders: { Authorization: "Bearer ${TILES_TOKEN}" },
      },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    },
  ];
  return project;
}

function withStored(values: Record<string, string>) {
  setProjectCredentialLookup((account) => values[account]);
}

after(() => setProjectCredentialLookup(null));

describe("splitProjectCredentials", () => {
  it("moves uniquely named preference credentials out and leaves header references on the layer", () => {
    const original = projectWithCredentials();
    const snapshot = structuredClone(original);
    const { project, secrets } = splitProjectCredentials(original);

    assert.deepEqual(secrets, {
      "project.geocoding.apiKey.mapbox": "gk",
      "project.env.GOOGLE_MAPS_API_KEY": "g1",
    });
    assert.deepEqual(project.preferences.geocoding.apiKeys, {});
    assert.deepEqual(project.preferences.environmentVariables, [
      { key: "GOOGLE_MAPS_API_KEY", value: "", enabled: true },
      { key: "ENDPOINT", value: "https://x", enabled: true, secret: false },
    ]);
    assert.deepEqual(project.layers[0].source.requestHeaders, {
      Authorization: "Bearer ${TILES_TOKEN}",
    });
    assert.deepEqual(original, snapshot);
    assert.equal(redactProjectCredentials(project).redactedCount, 0);
  });

  it("keeps duplicate names for the keep/strip prompt instead of losing either value", () => {
    const original = createEmptyProject("Duplicate credential names");
    original.preferences.environmentVariables = [
      { key: "TOKEN", value: "first", enabled: true },
      { key: " TOKEN ", value: "second", enabled: true },
      { key: "UNIQUE", value: "third", enabled: true },
      { key: "PUBLIC", value: "plain", enabled: true, secret: false },
    ];

    const { project, secrets } = splitProjectCredentials(original);
    assert.deepEqual(secrets, { "project.env.UNIQUE": "third" });
    assert.deepEqual(project.preferences.environmentVariables, [
      original.preferences.environmentVariables[0],
      original.preferences.environmentVariables[1],
      { key: "UNIQUE", value: "", enabled: true },
      original.preferences.environmentVariables[3],
    ]);
    const redacted = redactProjectCredentials(project);
    assert.equal(redacted.redactedCount, 2);
    assert.deepEqual(redacted.project.preferences.environmentVariables, [
      original.preferences.environmentVariables[3],
    ]);
  });

  it("keeps a nameless secret for an explicit keep/strip choice", () => {
    const original = createEmptyProject("Nameless credential");
    original.preferences.environmentVariables = [{ key: " ", value: "secret", enabled: true }];

    const { project, secrets } = splitProjectCredentials(original);
    assert.deepEqual(secrets, {});
    assert.deepEqual(
      project.preferences.environmentVariables,
      original.preferences.environmentVariables,
    );
    assert.equal(redactProjectCredentials(project).redactedCount, 1);
  });
});

describe("overlayStoredPreferenceCredentials", () => {
  it("fills only empty values; a value in the project wins", () => {
    withStored({
      "project.geocoding.apiKey.mapbox": "stored-geo",
      "project.env.A": "stored-a",
      "project.env.B": "stored-b",
      "project.env.C": "stored-c",
    });
    const preferences = createEmptyProject("Overlay").preferences;
    preferences.geocoding.apiKeys = {};
    preferences.environmentVariables = [
      { key: "A", value: "", enabled: true },
      { key: "B", value: "from-file", enabled: true },
      { key: "C", value: "", enabled: true, secret: false },
    ];
    const overlaid = overlayStoredPreferenceCredentials(preferences);
    assert.equal(overlaid.geocoding.apiKeys.mapbox, "stored-geo");
    assert.deepEqual(
      overlaid.environmentVariables.map(({ value }) => value),
      ["stored-a", "from-file", ""],
    );
  });
});

describe("changedPreferenceCredentials", () => {
  function prefs(
    apiKeys: Record<string, string>,
    rows: Array<[string, string]>,
  ): ProjectPreferences {
    const preferences = createEmptyProject("Commit").preferences;
    return {
      ...preferences,
      geocoding: { ...preferences.geocoding, apiKeys },
      environmentVariables: rows.map(([key, value]) => ({ key, value, enabled: true })),
    };
  }

  it("returns only edits, keeping untouched overrides out of the keychain", () => {
    // OVERRIDE is plaintext from the opened file; the others were stored.
    withStored({ "project.env.CLEARED": "stored-cleared" });
    const seeded = prefs({ mapbox: "file-geo", maptiler: "stored-mt" }, [
      ["EDITED", "stored"],
      ["OVERRIDE", "file-value"],
      ["CLEARED", "stored-cleared"],
    ]);
    const next = prefs({ mapbox: "file-geo", maptiler: "new-mt" }, [
      ["EDITED", "changed"],
      ["OVERRIDE", "file-value"],
      ["CLEARED", ""],
      ["NEW_BLANK", ""],
    ]);

    assert.deepEqual(changedPreferenceCredentials(seeded, next), {
      "project.geocoding.apiKey.maptiler": "new-mt",
      "project.env.EDITED": "changed",
      "project.env.CLEARED": "",
    });
  });

  it("clearing a file override keeps the shared key; clearing the shared key deletes it", () => {
    withStored({
      "project.geocoding.apiKey.mapbox": "shared-geo",
      "project.env.TOKEN": "shared-token",
    });
    const cleared = prefs({ mapbox: "" }, [["TOKEN", ""]]);

    // The opened file carried its own values, so the fields showed those.
    const fromFile = prefs({ mapbox: "file-geo" }, [["TOKEN", "file-token"]]);
    assert.deepEqual(changedPreferenceCredentials(fromFile, cleared), {});

    // The fields showed the shared values, so clearing them is a deletion.
    const fromStore = prefs({ mapbox: "shared-geo" }, [["TOKEN", "shared-token"]]);
    assert.deepEqual(changedPreferenceCredentials(fromStore, cleared), {
      "project.geocoding.apiKey.mapbox": "",
      "project.env.TOKEN": "",
    });
  });
});

describe("resolveProjectHeaderReferences", () => {
  const initialPreferences = useAppStore.getState().preferences;
  after(() => useAppStore.setState({ preferences: initialPreferences }));

  function withRows(enabled: boolean) {
    useAppStore.setState({
      preferences: {
        ...initialPreferences,
        environmentVariables: [{ key: "TILES_TOKEN", value: "", enabled }],
      },
    });
  }

  it("fills a reference from the stored secret of an enabled row", () => {
    withStored({ "project.env.TILES_TOKEN": "stored" });
    withRows(true);
    assert.deepEqual(resolveProjectHeaderReferences({ Authorization: "Bearer ${TILES_TOKEN}" }), {
      Authorization: "Bearer stored",
    });
  });

  it("drops a header whose variable row is disabled", () => {
    withStored({ "project.env.TILES_TOKEN": "stored" });
    withRows(false);
    assert.equal(
      resolveProjectHeaderReferences({ Authorization: "Bearer ${TILES_TOKEN}" }),
      undefined,
    );
  });
});

describe("environment variable redaction", () => {
  it("keeps non-secret rows and ignores empty secret rows", () => {
    const project = createEmptyProject("Redaction");
    project.preferences.environmentVariables = [
      { key: "PUBLIC", value: "https://x", enabled: true, secret: false },
      { key: "EMPTY_SECRET", value: "", enabled: true },
    ];
    const result = redactProjectCredentials(project);
    assert.equal(result.redactedCount, 0);
    assert.deepEqual(result.project.preferences.environmentVariables, [
      { key: "PUBLIC", value: "https://x", enabled: true, secret: false },
    ]);
  });
});
