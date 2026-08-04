import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROJECT_CREDENTIAL_FIELDS,
  createEmptyProject,
  redactCredentials,
  redactProjectCredentials,
  serializeProject,
} from "@geolibre/core";

function credentialProject() {
  const project = createEmptyProject("Credential fixture");
  project.preferences.environmentVariables = [
    { key: "SERVICE_TOKEN", value: "environment-secret", enabled: true },
  ];
  project.preferences.geocoding.apiKeys = { mapbox: "geocoder-secret" };
  project.layers = [
    {
      id: "auth",
      name: "Authenticated layer",
      type: "3d-tiles",
      source: {
        url: "https://user:password@example.com/tiles?token=url-secret&style=day",
        nested: { headers: { Authorization: "Bearer header-secret" } },
      },
      visible: true,
      opacity: 1,
      style: {},
      metadata: {
        endpoint: "https://example.com/data?X-Amz-Signature=signed-secret&format=json",
        brokerRef: "credential-broker://tiles/auth",
      },
    },
  ];
  project.plugins = {
    manifestUrls: ["https://example.com/plugin.json"],
    activePluginIds: ["external"],
    mapControlPositions: {},
    settings: { external: { arbitraryName: "plugin-secret" } },
  };
  return project;
}

describe("project credential redaction", () => {
  it("removes every marked credential while preserving broker references", () => {
    const original = credentialProject();
    const { project, redactedPaths } = redactProjectCredentials(original);
    const serialized = serializeProject(project);

    for (const secret of [
      "environment-secret",
      "geocoder-secret",
      "password",
      "url-secret",
      "header-secret",
      "signed-secret",
      "plugin-secret",
    ]) {
      assert.ok(!serialized.includes(secret), `redacted ${secret}`);
    }
    assert.match(serialized, /credential-broker:\/\/tiles\/auth/);
    assert.match(serialized, /style=day/);
    assert.deepEqual(project.plugins?.settings, {});
    assert.ok(redactedPaths.includes("plugins.settings"));
    assert.equal(original.plugins?.settings.external.arbitraryName, "plugin-secret");
  });

  it("provides a stable schema-level credential decision registry", () => {
    assert.deepEqual(PROJECT_CREDENTIAL_FIELDS.preferences, [
      "environmentVariables",
      "geocoding.apiKeys",
    ]);
    assert.ok(PROJECT_CREDENTIAL_FIELDS.layerConfiguration.includes("requestHeaders"));
    assert.deepEqual(PROJECT_CREDENTIAL_FIELDS.pluginState, ["plugins.settings"]);
  });

  it("is idempotent", () => {
    const once = redactCredentials(credentialProject());
    assert.deepEqual(redactCredentials(once), once);
  });

  it("fails closed when configuration exceeds the traversal depth", () => {
    let nested: Record<string, unknown> = { arbitrary: "too-deep-secret" };
    for (let index = 0; index < 20; index += 1) nested = { child: nested };
    const project = credentialProject();
    project.layers[0].source = nested;

    const result = redactProjectCredentials(project);
    assert.ok(!serializeProject(result.project).includes("too-deep-secret"));
    assert.ok(result.redactedPaths.some((path) => path.includes(".child")));
  });
});
