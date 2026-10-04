import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  clearDiagnostics,
  getDiagnosticsSnapshot,
} from "../apps/geolibre-desktop/src/lib/diagnostics";
import {
  clearNotifications,
  DEFAULT_DURATIONS_MS,
  dismissNotification,
  MAX_VISIBLE_NOTIFICATIONS,
  notify,
  setNotificationsPaused,
  useNotificationStore,
} from "../apps/geolibre-desktop/src/lib/notify";

const visible = () => useNotificationStore.getState().notifications;

describe("notify", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    clearNotifications();
    clearDiagnostics();
  });
  afterEach(() => {
    setNotificationsPaused(false);
    clearNotifications();
    mock.timers.reset();
  });

  it("auto-dismisses success, info and warning after their default durations", () => {
    notify.success("saved");
    notify.info("hello");
    notify.warning("careful");
    assert.equal(visible().length, 3);

    mock.timers.tick(DEFAULT_DURATIONS_MS.success as number);
    assert.deepEqual(
      visible().map((item) => item.kind),
      ["info", "warning"],
    );
    mock.timers.tick(
      (DEFAULT_DURATIONS_MS.info as number) - (DEFAULT_DURATIONS_MS.success as number),
    );
    assert.deepEqual(
      visible().map((item) => item.kind),
      ["warning"],
    );
    mock.timers.tick(DEFAULT_DURATIONS_MS.warning as number);
    assert.equal(visible().length, 0);
  });

  it("keeps errors until they are dismissed", () => {
    const id = notify.error("broke");
    mock.timers.tick(10 * 60 * 1000);
    assert.equal(visible().length, 1);
    dismissNotification(id);
    assert.equal(visible().length, 0);
  });

  it("honors an explicit duration, including null for a persistent toast", () => {
    notify.info("quick", { durationMs: 100 });
    notify.info("sticky", { durationMs: null });
    mock.timers.tick(100);
    assert.deepEqual(
      visible().map((item) => item.message),
      ["sticky"],
    );
  });

  it("collapses duplicates into one toast with a repeat count and restarts its timer", () => {
    const first = notify.info("same");
    mock.timers.tick(4000);
    const second = notify.info("same");
    assert.equal(first, second);
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].count, 2);
    assert.equal(visible()[0].revision, 1);
    // The repeat restarted the 5 s timer, so 4 s later it is still up.
    mock.timers.tick(4000);
    assert.equal(visible().length, 1);
    mock.timers.tick(1000);
    assert.equal(visible().length, 0);
  });

  it("dedupes on an explicit key even when the text differs", () => {
    notify.warning("layer A failed", { dedupeKey: "layer:1" });
    notify.warning("layer A failed again", { dedupeKey: "layer:1" });
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].message, "layer A failed again");
    assert.equal(visible()[0].count, 2);
  });

  it("renders a repeat that escalates severity as the new kind", () => {
    notify.warning("retrying", { dedupeKey: "job" });
    notify.error("gave up", { dedupeKey: "job" });
    assert.equal(visible().length, 1);
    assert.equal(visible()[0].kind, "error");
    assert.equal(visible()[0].durationMs, null);
    mock.timers.tick(60_000);
    assert.equal(visible().length, 1, "the escalated toast persists like an error");
  });

  it("drops the report record when a repeat de-escalates to a non-error", () => {
    notify.error("failed", { dedupeKey: "job" });
    assert.ok(visible()[0].diagnostic);
    notify.warning("retrying", { dedupeKey: "job" });
    assert.equal(visible()[0].kind, "warning");
    assert.equal(visible()[0].diagnostic, undefined);
  });

  it("caps the visible count, evicting the oldest non-error first", () => {
    notify.error("first error");
    for (let index = 0; index < MAX_VISIBLE_NOTIFICATIONS; index += 1) {
      notify.info(`info ${index}`);
    }
    const messages = visible().map((item) => item.message);
    assert.equal(messages.length, MAX_VISIBLE_NOTIFICATIONS);
    assert.ok(messages.includes("first error"), "the unread error survives the burst");
    assert.ok(!messages.includes("info 0"), "the oldest info is evicted");
  });

  it("evicts the oldest error once only errors remain", () => {
    for (let index = 0; index <= MAX_VISIBLE_NOTIFICATIONS; index += 1) {
      notify.error(`error ${index}`);
    }
    const messages = visible().map((item) => item.message);
    assert.equal(messages.length, MAX_VISIBLE_NOTIFICATIONS);
    assert.ok(!messages.includes("error 0"));
  });

  it("pauses timers while the region is being read and restarts them on resume", () => {
    notify.success("saved");
    setNotificationsPaused(true);
    mock.timers.tick(60_000);
    assert.equal(visible().length, 1);
    setNotificationsPaused(false);
    mock.timers.tick((DEFAULT_DURATIONS_MS.success as number) - 1);
    assert.equal(visible().length, 1);
    mock.timers.tick(1);
    assert.equal(visible().length, 0);
  });

  it("records errors in Diagnostics and links the toast to the record", () => {
    notify.error("Export failed", {
      description: "Disk full",
      error: new Error("ENOSPC"),
    });
    const [record] = getDiagnosticsSnapshot().records;
    assert.equal(record.category, "app");
    assert.equal(record.level, "error");
    assert.equal(record.message, "Export failed");
    assert.match(record.detail ?? "", /Disk full/);
    assert.match(record.detail ?? "", /ENOSPC/);
    assert.equal(visible()[0].diagnostic?.id, record.id);
  });

  it("does not record non-error notifications", () => {
    notify.warning("heads up");
    notify.info("fyi");
    assert.equal(getDiagnosticsSnapshot().totalCount, 0);
  });

  it("reuses a supplied Diagnostics record instead of writing a second one", () => {
    notify.error("first");
    const [existing] = getDiagnosticsSnapshot().records;
    clearNotifications();
    notify.error("Layer failed", { diagnostic: existing });
    assert.equal(getDiagnosticsSnapshot().totalCount, 1);
    assert.equal(visible()[0].diagnostic, existing);
  });
});
