import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROJECT_NAME } from "@geolibre/core";
import {
  announceLiveProjectSession,
  liveProjectSessionTabs,
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
    // A session-shaped array is the case the plain "[1,2]" above cannot catch:
    // its elements pass entry validation, so only rejecting arrays outright
    // stops `Object.entries` turning the indexes into "0", "1", ... tab ids.
    assert.deepEqual(parseProjectSessions(JSON.stringify([{ state: "open", at: stamp(0) }])), {});
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

describe("cross-tab liveness", () => {
  // `currentTabId` reads sessionStorage, which node lacks. Swapping the id the
  // stub returns between the announce and the probe is what makes one process
  // stand in for two tabs.
  function withTabIdentity(): { setTabId: (id: string) => void; restore: () => void } {
    let tabId = "tab";
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: { getItem: () => tabId, setItem: () => {} },
    });
    return {
      setTabId: (id) => {
        tabId = id;
      },
      restore: () => {
        if (original) Object.defineProperty(globalThis, "sessionStorage", original);
        else Reflect.deleteProperty(globalThis, "sessionStorage");
      },
    };
  }

  it("collects the id of a tab that answers the ping", async () => {
    const identity = withTabIdentity();
    identity.setTabId("sibling");
    const stopAnnouncing = announceLiveProjectSession();
    identity.setTabId("self");
    try {
      assert.deepEqual([...(await liveProjectSessionTabs())], ["sibling"]);
    } finally {
      stopAnnouncing();
      identity.restore();
    }
  });

  it("excludes its own answer, so a reload after a crash still recovers", async () => {
    // Reloading the tab a renderer crash killed reuses its sessionStorage tab
    // id, and its own announcer answers its own ping. Counting that answer
    // would discount the crashed entry and swallow the prompt.
    const identity = withTabIdentity();
    identity.setTabId("same-tab");
    const stopAnnouncing = announceLiveProjectSession();
    try {
      assert.deepEqual([...(await liveProjectSessionTabs())], []);
    } finally {
      stopAnnouncing();
      identity.restore();
    }
  });

  it("reports no live tabs where BroadcastChannel is missing", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    Reflect.deleteProperty(globalThis, "BroadcastChannel");
    try {
      assert.equal(announceLiveProjectSession()(), undefined);
      assert.equal((await liveProjectSessionTabs()).size, 0);
    } finally {
      if (original) Object.defineProperty(globalThis, "BroadcastChannel", original);
    }
  });
});

describe("announceLiveProjectSession where storage is blocked", () => {
  it("returns a teardown instead of throwing out of effect setup", () => {
    // A privacy mode that blocks storage must not take the caller down with
    // it: this runs during effect setup, before the heartbeat and `pagehide`
    // listeners are wired up.
    const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("access denied");
      },
    });
    try {
      const stopAnnouncing = announceLiveProjectSession();
      assert.equal(typeof stopAnnouncing, "function");
      stopAnnouncing();
    } finally {
      if (original) Object.defineProperty(globalThis, "sessionStorage", original);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });
});
