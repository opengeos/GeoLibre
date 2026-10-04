import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { clearDiagnostics } from "../apps/geolibre-desktop/src/lib/diagnostics";
import {
  createDropStatusNotifier,
  DROP_MESSAGE_CLEAR_MS,
} from "../apps/geolibre-desktop/src/lib/drop-status-notifier";
import {
  clearNotifications,
  dismissNotification,
  useNotificationStore,
} from "../apps/geolibre-desktop/src/lib/notify";

const visible = () =>
  useNotificationStore.getState().notifications.map(({ kind, message }) => ({ kind, message }));

describe("createDropStatusNotifier", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    clearNotifications();
    clearDiagnostics();
  });
  afterEach(() => {
    clearNotifications();
    mock.timers.reset();
  });

  it("keeps one status toast that each message replaces, cleared later", () => {
    const status = createDropStatusNotifier();
    status.setDropMessage("Importing data...");
    status.setDropMessage("Parsing roads.geojson…");
    assert.deepEqual(visible(), [{ kind: "info", message: "Parsing roads.geojson…" }]);
    status.setDropMessage("Added 1 layer");
    status.clearDropMessageLater();
    mock.timers.tick(DROP_MESSAGE_CLEAR_MS - 1);
    assert.equal(visible().length, 1);
    mock.timers.tick(1);
    assert.deepEqual(visible(), []);
  });

  it("shows an import error as a warning that supersedes the status", () => {
    const status = createDropStatusNotifier();
    status.setDropMessage("Importing data...");
    status.setDropError("bad.geojson: Unexpected end of JSON input");
    assert.deepEqual(visible(), [
      { kind: "warning", message: "bad.geojson: Unexpected end of JSON input" },
    ]);
    // A new drop resets the error first.
    status.setDropError(null);
    assert.deepEqual(visible(), []);
  });

  it("does not auto-clear the error with the status", () => {
    const status = createDropStatusNotifier();
    status.setDropError("Could not import files.");
    status.clearDropMessageLater();
    mock.timers.tick(DROP_MESSAGE_CLEAR_MS);
    assert.deepEqual(visible(), [{ kind: "warning", message: "Could not import files." }]);
  });

  it("keeps the CRS warning until it is dismissed or cleared", () => {
    const status = createDropStatusNotifier();
    status.setCrsWarning("Layer sits far from its data");
    mock.timers.tick(60_000);
    assert.deepEqual(visible(), [{ kind: "warning", message: "Layer sits far from its data" }]);
    status.setCrsWarning(null);
    assert.deepEqual(visible(), []);
  });

  it("shows the same message again after the user dismissed it", () => {
    const status = createDropStatusNotifier();
    status.setDropError("Same failure");
    dismissNotification(useNotificationStore.getState().notifications[0].id);
    status.setDropError("Same failure");
    assert.deepEqual(visible(), [{ kind: "warning", message: "Same failure" }]);
  });

  it("accepts React-style updater functions", () => {
    const status = createDropStatusNotifier();
    status.setDropMessage("one");
    status.setDropMessage((current) => `${current} two`);
    assert.deepEqual(visible(), [{ kind: "info", message: "one two" }]);
  });
});
