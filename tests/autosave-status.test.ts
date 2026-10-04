import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autosavePausedAfter,
  autosavePausedMessage,
  createAutosaveFailureNotice,
  createAutosaveStatusTracker,
  isSizeSkip,
} from "../apps/geolibre-desktop/src/lib/autosave-status";
import { MAX_SNAPSHOT_BYTES } from "../apps/geolibre-desktop/src/lib/project-history-store";
import en from "../apps/geolibre-desktop/src/i18n/locales/en.json";

function tracker() {
  const changes: boolean[] = [];
  return { status: createAutosaveStatusTracker((paused) => changes.push(paused)), changes };
}

describe("autosavePausedAfter", () => {
  it("pauses on either size skip", () => {
    assert.equal(autosavePausedAfter(false, "too-large"), true);
    assert.equal(autosavePausedAfter(false, "unserializable"), true);
  });

  it("resumes once a snapshot is stored or already current", () => {
    assert.equal(autosavePausedAfter(true, "added"), false);
    assert.equal(autosavePausedAfter(true, "duplicate"), false);
  });

  it("leaves the state alone on a failure that is not about size", () => {
    assert.equal(autosavePausedAfter(true, "failed"), true);
    assert.equal(autosavePausedAfter(false, "failed"), false);
  });

  it("classifies only the size outcomes as size skips", () => {
    assert.deepEqual(
      (["added", "duplicate", "too-large", "unserializable", "failed"] as const).filter(isSizeSkip),
      ["too-large", "unserializable"],
    );
  });
});

describe("createAutosaveStatusTracker", () => {
  it("reports a skip, then clears once a later snapshot succeeds", () => {
    const { status, changes } = tracker();
    status.settle(status.begin(), "too-large");
    assert.equal(status.paused(), true);
    status.settle(status.begin(), "added");
    assert.equal(status.paused(), false);
    assert.deepEqual(changes, [true, false]);
  });

  it("only notifies on a change", () => {
    const { status, changes } = tracker();
    status.settle(status.begin(), "too-large");
    status.settle(status.begin(), "too-large");
    status.settle(status.begin(), "failed");
    assert.deepEqual(changes, [true]);
  });

  it("ignores an attempt that a newer one superseded", () => {
    const { status } = tracker();
    const slow = status.begin();
    const fast = status.begin();
    status.settle(fast, "added");
    status.settle(slow, "too-large");
    assert.equal(status.paused(), false);
  });

  it("clears on reset and drops attempts still in flight", () => {
    const { status, changes } = tracker();
    status.settle(status.begin(), "too-large");
    const inFlight = status.begin();
    status.reset();
    status.settle(inFlight, "too-large");
    assert.equal(status.paused(), false);
    assert.deepEqual(changes, [true, false]);
  });

  it("does not flag a project that was saved before the skip landed", () => {
    const { status } = tracker();
    status.settle(status.begin(), "too-large", false);
    assert.equal(status.paused(), false);
    // A success still clears, whatever the dirty state.
    status.settle(status.begin(), "unserializable");
    status.settle(status.begin(), "added", false);
    assert.equal(status.paused(), false);
  });
});

describe("autosavePausedMessage", () => {
  it("quotes the snapshot limit in megabytes", () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const t = ((key: string, options: Record<string, unknown>) => {
      calls.push([key, options]);
      return key;
    }) as unknown as Parameters<typeof autosavePausedMessage>[0];
    autosavePausedMessage(t, "en");
    assert.deepEqual(calls, [
      ["projectHistory.autosavePaused", { limit: String(MAX_SNAPSHOT_BYTES / (1024 * 1024)) }],
    ]);
    assert.match(en.projectHistory.autosavePaused, /\{\{limit\}\} MB/);
    assert.equal(typeof en.statusBar.autosavePaused, "string");
  });
});

describe("createAutosaveFailureNotice", () => {
  it("tells once per run of failures, and again after a stored snapshot", () => {
    let told = 0;
    const notice = createAutosaveFailureNotice(() => told++);
    notice("failed");
    notice("failed");
    // A size skip is the paused indicator's business, not this notice's.
    notice("too-large");
    notice("failed");
    assert.equal(told, 1);
    notice("added");
    notice("failed");
    assert.equal(told, 2);
    notice("duplicate");
    notice("failed");
    assert.equal(told, 3);
  });
});
