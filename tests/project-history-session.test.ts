import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROJECT_NAME } from "../packages/core/src/index";
import {
  parseProjectSessions,
  projectSessionState,
  pruneStaleProjectSessions,
  SESSION_HEARTBEAT_MS,
  shouldOfferProjectRecovery,
  type ProjectRecoveryCandidate,
} from "../apps/geolibre-desktop/src/lib/project-history-session";

const NOW = Date.parse("2026-01-02T12:00:00.000Z");
const stamp = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function candidate(over: Partial<ProjectRecoveryCandidate> = {}): ProjectRecoveryCandidate {
  return {
    createdAt: "2026-01-02T00:00:00.000Z",
    name: "Watershed study",
    projectKey: "unsaved:Watershed study",
    ...over,
  };
}

describe("shouldOfferProjectRecovery", () => {
  it("offers recovery for a renamed project after an unclean close", () => {
    assert.equal(shouldOfferProjectRecovery(candidate(), "open", null), true);
  });

  it("skips a still-default-named, never-saved project", () => {
    assert.equal(
      shouldOfferProjectRecovery(
        candidate({
          name: DEFAULT_PROJECT_NAME,
          projectKey: `unsaved:${DEFAULT_PROJECT_NAME}`,
        }),
        "open",
        null,
      ),
      false,
    );
  });

  it("still offers recovery for a saved project that kept the default name", () => {
    assert.equal(
      shouldOfferProjectRecovery(
        candidate({
          name: DEFAULT_PROJECT_NAME,
          projectKey: "path:/tmp/site.geolibre.json",
        }),
        "open",
        null,
      ),
      true,
    );
  });

  it("skips when the previous session closed cleanly", () => {
    assert.equal(shouldOfferProjectRecovery(candidate(), "closed", null), false);
    assert.equal(shouldOfferProjectRecovery(candidate(), null, null), false);
  });

  it("skips when there is no snapshot", () => {
    assert.equal(shouldOfferProjectRecovery(undefined, "open", null), false);
  });

  it("skips a snapshot that is not newer than the last explicit save", () => {
    assert.equal(
      shouldOfferProjectRecovery(candidate(), "open", "2026-01-02T00:00:00.000Z"),
      false,
    );
    assert.equal(
      shouldOfferProjectRecovery(candidate(), "open", "2026-01-03T00:00:00.000Z"),
      false,
    );
    assert.equal(shouldOfferProjectRecovery(candidate(), "open", "2026-01-01T00:00:00.000Z"), true);
  });
});

describe("parseProjectSessions", () => {
  it("keeps well-formed timestamped entries", () => {
    const stored = JSON.stringify({ tab: { state: "open", at: stamp(0) } });
    assert.deepEqual(parseProjectSessions(stored), { tab: { state: "open", at: stamp(0) } });
  });

  it("drops entries from before sessions carried a timestamp", () => {
    assert.deepEqual(parseProjectSessions("open"), {});
    assert.deepEqual(parseProjectSessions(JSON.stringify({ tab: "open" })), {});
    assert.deepEqual(parseProjectSessions(JSON.stringify({ tab: { state: "open" } })), {});
  });

  it("survives missing, malformed, and non-object storage", () => {
    assert.deepEqual(parseProjectSessions(null), {});
    assert.deepEqual(parseProjectSessions("{not json"), {});
    assert.deepEqual(parseProjectSessions("[1,2]"), {});
    assert.deepEqual(parseProjectSessions(JSON.stringify({ tab: { state: "gone", at: "" } })), {});
  });
});

describe("pruneStaleProjectSessions", () => {
  it("keeps an entry a live tab restamped within the window", () => {
    const sessions = { tab: { state: "open" as const, at: stamp(SESSION_HEARTBEAT_MS) } };
    assert.deepEqual(pruneStaleProjectSessions(sessions, NOW), sessions);
  });

  it("drops an entry nobody restamped, and unparseable or future stamps", () => {
    assert.deepEqual(
      pruneStaleProjectSessions(
        {
          dead: { state: "open", at: stamp(10 * 60_000) },
          garbage: { state: "open", at: "not a date" },
          skewed: { state: "open", at: stamp(-60_000) },
        },
        NOW,
      ),
      {},
    );
  });
});

describe("projectSessionState", () => {
  it("reports open when a recent tab never closed cleanly", () => {
    const sessions = {
      gone: { state: "closed" as const, at: stamp(60_000) },
      crashed: { state: "open" as const, at: stamp(60_000) },
    };
    assert.equal(projectSessionState(sessions, NOW), "open");
  });

  it("reports closed once the crashed tab's entry has expired", () => {
    // The regression this expiry fixes: one tab killed without `pagehide` used
    // to make every later visit look like it followed a crash, forever.
    const sessions = { crashed: { state: "open" as const, at: stamp(60 * 60_000) } };
    assert.equal(projectSessionState(sessions, NOW), "closed");
  });

  it("reports closed for an empty record", () => {
    assert.equal(projectSessionState({}, NOW), "closed");
  });
});

describe("projectSessionState with live tabs", () => {
  it("discounts a sibling tab that answered the liveness ping", () => {
    // Opening a second window is not a crash: the sibling's heartbeat is fresh
    // and open, and only its answer tells the two cases apart.
    const sessions = { sibling: { state: "open" as const, at: stamp(0) } };
    assert.equal(projectSessionState(sessions, NOW, new Set(["sibling"])), "closed");
  });

  it("still reports open when a different entry went unanswered", () => {
    const sessions = {
      sibling: { state: "open" as const, at: stamp(0) },
      crashed: { state: "open" as const, at: stamp(90_000) },
    };
    assert.equal(projectSessionState(sessions, NOW, new Set(["sibling"])), "open");
  });
});
