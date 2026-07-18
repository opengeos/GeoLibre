import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  postgisBaselineKeys,
  prunePostgisConnections,
  registerPostgisConnection,
  resolvePostgisConnection,
  unregisterPostgisConnection,
} from "../apps/geolibre-desktop/src/lib/postgis-connections";
import { savedPostgresConnectionLabel } from "../apps/geolibre-desktop/src/components/layout/add-data/helpers";

const CONNECTION = "postgresql://alice:hunter2@db.example.com:5432/gis";

function postgisLayer(id: string, metadata: Record<string, unknown> = {}): GeoLibreLayer {
  return {
    id,
    name: "cities",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {},
    metadata: {
      sourceKind: "postgis-table",
      postgisTable: "cities",
      postgisPrimaryKey: "gid",
      ...metadata,
    },
  };
}

// The fallback path reads saved connections from window.localStorage; emulate
// just enough of it for Node's test runner.
function withSavedConnections(connections: string[], run: () => void): void {
  const store = new Map<string, string>([
    ["geolibre.postgres.connectionStrings", JSON.stringify(connections)],
  ]);
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
  try {
    run();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
}

describe("postgis connection registry", () => {
  afterEach(() => {
    unregisterPostgisConnection("layer-a");
  });

  it("resolves a registered connection for the layer", () => {
    registerPostgisConnection("layer-a", CONNECTION);
    assert.equal(resolvePostgisConnection(postgisLayer("layer-a")), CONNECTION);
  });

  it("returns null when nothing is registered and no label matches", () => {
    assert.equal(resolvePostgisConnection(postgisLayer("layer-b")), null);
  });

  it("forgets a connection on unregister", () => {
    registerPostgisConnection("layer-a", CONNECTION);
    unregisterPostgisConnection("layer-a");
    assert.equal(resolvePostgisConnection(postgisLayer("layer-a")), null);
  });

  it("falls back to the saved connection matching the masked label", () => {
    const label = savedPostgresConnectionLabel(CONNECTION);
    assert.ok(!label.includes("hunter2"), "label must mask the password");
    withSavedConnections(["postgresql://other@x/db", CONNECTION], () => {
      const layer = postgisLayer("layer-c", { postgisConnectionLabel: label });
      assert.equal(resolvePostgisConnection(layer), CONNECTION);
    });
  });

  it("does not fall back when the layer has no connection label", () => {
    withSavedConnections([CONNECTION], () => {
      assert.equal(resolvePostgisConnection(postgisLayer("layer-d")), null);
    });
  });

  it("refuses an ambiguous label match (same connection, rotated password)", () => {
    const label = savedPostgresConnectionLabel(CONNECTION);
    const rotated = "postgresql://alice:newpass99@db.example.com:5432/gis";
    assert.equal(savedPostgresConnectionLabel(rotated), label);
    withSavedConnections([rotated, CONNECTION], () => {
      const layer = postgisLayer("layer-amb", {
        postgisConnectionLabel: label,
      });
      assert.equal(resolvePostgisConnection(layer), null);
    });
  });

  it("prunes registered connections when their layer leaves the store", () => {
    registerPostgisConnection("layer-gone", CONNECTION);
    registerPostgisConnection("layer-kept", CONNECTION);
    // Simulates the store subscription firing after any removal path
    // (scripting, assistant, New Project): only live layer ids survive.
    prunePostgisConnections(["layer-kept"]);
    assert.equal(resolvePostgisConnection(postgisLayer("layer-gone")), null);
    assert.equal(resolvePostgisConnection(postgisLayer("layer-kept")), CONNECTION);
    unregisterPostgisConnection("layer-kept");
  });

  it("reads baseline keys from layer metadata, dropping junk entries", () => {
    const layer = postgisLayer("layer-e", {
      postgisBaselineKeys: [1, "two", null, { bad: true }, 3],
    });
    assert.deepEqual(postgisBaselineKeys(layer), [1, "two", 3]);
    assert.equal(postgisBaselineKeys(postgisLayer("layer-f")), undefined);
  });
});
