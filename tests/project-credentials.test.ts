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
  project.preferences.geocoding.forwardEndpoint =
    "https://geocode.example.com/search?key=endpoint-secret";
  project.basemapStyleUrl = "https://styles.example.com/map.json?access_token=basemap-secret";
  project.layers = [
    {
      id: "auth",
      name: "Authenticated layer",
      type: "3d-tiles",
      source: {
        url: "https://user:password@example.com/tiles?token=url-secret&subscription%2Dkey=encoded-secret&style=day",
        nested: { headers: { Authorization: "Bearer header-secret" } },
      },
      visible: true,
      opacity: 1,
      style: {},
      metadata: {
        endpoint: "https://example.com/data?%58-Amz-Signature=signed-secret&format=json",
        brokerRef: "credential-broker://tiles/auth",
      },
    },
  ];
  project.plugins = {
    manifestUrls: ["https://example.com/plugin.json?api-key=manifest-secret"],
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
      "endpoint-secret",
      "basemap-secret",
      "password",
      "url-secret",
      "encoded-secret",
      "header-secret",
      "signed-secret",
      "plugin-secret",
      "manifest-secret",
    ]) {
      assert.ok(!serialized.includes(secret), `redacted ${secret}`);
    }
    assert.match(serialized, /credential-broker:\/\/tiles\/auth/);
    assert.match(serialized, /style=day/);
    assert.deepEqual(project.plugins?.settings, {});
    assert.ok(redactedPaths.includes("plugins.settings"));
    assert.equal(redactedPaths.includes("basemapStyleUrl"), true);
    assert.equal(redactProjectCredentials(original).redactedCount, 9);
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

  it("returns detached inline GeoJSON", () => {
    const original = credentialProject();
    original.layers[0].source = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: null, properties: { name: "original" } }],
    };
    const safe = redactCredentials(original);
    const safeSource = safe.layers[0].source as {
      features: Array<{ properties: { name: string } }>;
    };
    safeSource.features[0].properties.name = "changed";
    assert.equal(
      (
        original.layers[0].source as {
          features: Array<{ properties: { name: string } }>;
        }
      ).features[0].properties.name,
      "original",
    );
  });

  it("removes credential-named configuration fields in every spelling", () => {
    const project = credentialProject();
    project.layers[0].source = {
      sasToken: "sas-secret",
      bearer: "bearer-secret",
      auth: { user: "u", pass: "auth-secret" },
      "subscription-key": "subscription-secret",
      api_key: "underscore-secret",
      pwd: "pwd-secret",
      // Azure SAS positional parameters are credentials only inside a query
      // string; as configuration field names they are ordinary state.
      sr: 4326,
      key: "layer-identifier",
    };

    const { project: safe } = redactProjectCredentials(project);
    const serialized = serializeProject(safe);
    for (const secret of [
      "sas-secret",
      "bearer-secret",
      "auth-secret",
      "subscription-secret",
      "underscore-secret",
      "pwd-secret",
    ]) {
      assert.ok(!serialized.includes(secret), `redacted ${secret}`);
    }
    assert.deepEqual(safe.layers[0].source, { sr: 4326, key: "layer-identifier" });
  });

  it("fails closed when configuration exceeds the traversal depth", () => {
    let nested: Record<string, unknown> = { arbitrary: "too-deep-secret" };
    for (let index = 0; index < 12; index += 1) nested = { child: nested };
    const project = credentialProject();
    project.layers[0].source = nested;

    const result = redactProjectCredentials(project);
    assert.ok(!serializeProject(result.project).includes("too-deep-secret"));
    assert.ok(result.redactedPaths.includes(`layers[0].source${".child".repeat(12)}`));
  });
});
