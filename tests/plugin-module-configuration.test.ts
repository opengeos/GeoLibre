import assert from "node:assert/strict";
import { it } from "node:test";
import { loadBuiltInPluginModule } from "../packages/plugins/src/builtin-plugins";
import { configureHostPluginModule } from "../apps/geolibre-desktop/src/lib/configure-plugin-module";
import {
  clearDiagnostics,
  getDiagnosticsSnapshot,
} from "../apps/geolibre-desktop/src/lib/diagnostics";

it("reports failed live host setup without throwing into UI and recovers after replacement", async () => {
  clearDiagnostics();
  await loadBuiltInPluginModule("sun");
  try {
    assert.doesNotThrow(() =>
      configureHostPluginModule("sun", {
        "test:host": () => {
          throw new Error("Host setup rejected");
        },
      }),
    );
    assert.ok(
      getDiagnosticsSnapshot().records.some(
        (record) =>
          record.source === "plugin-module:sun" && record.message.includes("Host setup rejected"),
      ),
    );
    // A failure must not let activation consume a partially configured module.
    await assert.rejects(loadBuiltInPluginModule("sun"), /Host setup rejected/);
    let restored = false;
    configureHostPluginModule("sun", {
      "test:host": () => {
        restored = true;
      },
    });
    await loadBuiltInPluginModule("sun");
    assert.equal(restored, true);
  } finally {
    configureHostPluginModule("sun", { "test:host": () => {} });
    clearDiagnostics();
  }
});
