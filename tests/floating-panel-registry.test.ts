import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetFloatingPanelRegistryForTests,
  closeFloatingPanel,
  focusFloatingPanel,
  getFloatingPanel,
  getFloatingPanelsSnapshot,
  getOpenFloatingPanels,
  isFloatingPanelOpen,
  openFloatingPanel,
  registerFloatingPanel,
  subscribeFloatingPanels,
  unregisterFloatingPanel,
} from "../packages/plugins/src/floating-panel-registry";
import type { GeoLibreFloatingPanelRegistration } from "../packages/plugins/src/types";

function testPanel(
  patch: Partial<GeoLibreFloatingPanelRegistration> = {},
): GeoLibreFloatingPanelRegistration {
  return {
    id: "viewer",
    title: "Viewer",
    render: () => undefined,
    ...patch,
  };
}

afterEach(() => {
  __resetFloatingPanelRegistryForTests();
});

describe("floating-panel registry", () => {
  it("registers a panel without opening it", () => {
    registerFloatingPanel(testPanel());
    assert.equal(getOpenFloatingPanels().length, 0);
    assert.equal(isFloatingPanelOpen("viewer"), false);
    assert.equal(getFloatingPanel("viewer")?.title, "Viewer");
  });

  it("opens, refocuses, and closes a panel and fires hooks once", () => {
    const calls: string[] = [];
    registerFloatingPanel(
      testPanel({
        onOpen: () => calls.push("open"),
        onClose: () => calls.push("close"),
      }),
    );

    assert.equal(openFloatingPanel("viewer"), true);
    assert.equal(isFloatingPanelOpen("viewer"), true);
    assert.deepEqual(getOpenFloatingPanels(), ["viewer"]);

    // Re-opening an already-open panel just raises it without re-firing onOpen.
    assert.equal(openFloatingPanel("viewer"), true);
    assert.deepEqual(getOpenFloatingPanels(), ["viewer"]);

    closeFloatingPanel("viewer");
    assert.equal(isFloatingPanelOpen("viewer"), false);
    assert.deepEqual(getOpenFloatingPanels(), []);

    assert.deepEqual(calls, ["open", "close"]);
  });

  it("stacks multiple panels and reorders on open/focus", () => {
    registerFloatingPanel(testPanel({ id: "a", title: "A" }));
    registerFloatingPanel(testPanel({ id: "b", title: "B" }));
    openFloatingPanel("a");
    openFloatingPanel("b");
    // b opened last sits at the front (end of the array).
    assert.deepEqual(getOpenFloatingPanels(), ["a", "b"]);

    // Re-opening a brings it back to the front.
    openFloatingPanel("a");
    assert.deepEqual(getOpenFloatingPanels(), ["b", "a"]);

    // focusFloatingPanel raises without opening hooks.
    focusFloatingPanel("b");
    assert.deepEqual(getOpenFloatingPanels(), ["a", "b"]);

    // No reorder when the panel is already front-most.
    focusFloatingPanel("b");
    assert.deepEqual(getOpenFloatingPanels(), ["a", "b"]);
  });

  it("returns false and warns when opening an unregistered id", () => {
    assert.equal(openFloatingPanel("missing"), false);
    assert.equal(isFloatingPanelOpen("missing"), false);
  });

  it("closes the panel when it is unregistered, firing onClose once", () => {
    const calls: string[] = [];
    registerFloatingPanel(testPanel({ onClose: () => calls.push("close") }));
    openFloatingPanel("viewer");
    unregisterFloatingPanel("viewer");
    assert.equal(isFloatingPanelOpen("viewer"), false);
    assert.equal(getFloatingPanel("viewer"), undefined);
    assert.deepEqual(calls, ["close"]);
  });

  it("re-registers by id, and a stale disposer does not evict the new panel", () => {
    const disposeFirst = registerFloatingPanel(testPanel({ title: "First" }));
    registerFloatingPanel(testPanel({ title: "Second" }));
    assert.equal(getFloatingPanel("viewer")?.title, "Second");
    // The first registration's disposer must not remove the replacement.
    disposeFirst();
    assert.equal(getFloatingPanel("viewer")?.title, "Second");
  });

  it("notifies subscribers and exposes a stable snapshot between mutations", () => {
    let notified = 0;
    const unsubscribe = subscribeFloatingPanels(() => {
      notified += 1;
    });
    const before = getFloatingPanelsSnapshot();
    registerFloatingPanel(testPanel());
    openFloatingPanel("viewer");
    const after = getFloatingPanelsSnapshot();

    assert.equal(notified, 2);
    assert.notEqual(before, after);
    // Reading again without a mutation returns the same object identity.
    assert.equal(getFloatingPanelsSnapshot(), after);
    assert.deepEqual(after.openIds, ["viewer"]);

    unsubscribe();
    closeFloatingPanel("viewer");
    assert.equal(notified, 2);
  });

  it("notifies once and fires onClose when unregistering an open panel", () => {
    const calls: string[] = [];
    registerFloatingPanel(testPanel({ onClose: () => calls.push("close") }));
    openFloatingPanel("viewer");
    let notified = 0;
    const unsubscribe = subscribeFloatingPanels(() => {
      notified += 1;
    });
    unregisterFloatingPanel("viewer");
    assert.equal(notified, 1);
    assert.equal(isFloatingPanelOpen("viewer"), false);
    assert.deepEqual(calls, ["close"]);
    unsubscribe();
  });

  it("rejects invalid registrations", () => {
    assert.throws(() =>
      registerFloatingPanel({
        id: "",
        title: "x",
        render: () => undefined,
      }),
    );
    assert.throws(() =>
      registerFloatingPanel({ id: "x", title: "", render: () => undefined }),
    );
    assert.throws(() =>
      registerFloatingPanel({
        id: "x",
        title: "x",
      } as unknown as GeoLibreFloatingPanelRegistration),
    );
  });

  it("resolves a getter title live without mutating the registration object", () => {
    // A getter title must re-localize on language change without the host
    // clobbering the function on the caller's own registration object.
    let current = "Viewer (en)";
    const panel = testPanel({ title: () => current });
    registerFloatingPanel(panel);

    assert.equal(getFloatingPanel("viewer")?.title, "Viewer (en)");
    assert.equal(typeof panel.title, "function");

    current = "Viewer (zh)";
    assert.equal(getFloatingPanel("viewer")?.title, "Viewer (zh)");
    assert.equal(typeof panel.title, "function");
  });

  it("re-registering the same object keeps a getter title reactive", () => {
    // Regression: an earlier build resolved panel.title in place, turning the
    // function into a static string, so a re-registration of the same object
    // (a supported pattern) froze the title on its first value.
    let current = "First";
    const panel = testPanel({ title: () => current });
    registerFloatingPanel(panel);
    assert.equal(getFloatingPanel("viewer")?.title, "First");

    registerFloatingPanel(panel);
    assert.equal(typeof panel.title, "function");

    current = "Second";
    assert.equal(getFloatingPanel("viewer")?.title, "Second");
  });

  it("returns a fresh shallow clone per call and never exposes the getter", () => {
    // Every accessor returns its own shallow clone whose .title is already a
    // string, never the original getter, so consumers can read it directly and
    // key render-effects on panel.render without effect-thrashing.
    registerFloatingPanel(testPanel({ title: () => "Dynamic" }));
    const a = getFloatingPanel("viewer");
    const b = getFloatingPanel("viewer");
    assert.notEqual(a, b);
    assert.equal(typeof a?.title, "string");
    assert.equal(typeof b?.title, "string");
    assert.equal(a?.title, "Dynamic");
    assert.equal(b?.title, "Dynamic");
  });

  it("falls back to the panel id when a getter title throws", () => {
    // A throwing title getter must not propagate into the React render tree
    // (getFloatingPanel is called directly in FloatingPanelCard's render body).
    // It degrades to the panel id and logs the error, mirroring runHook/render.
    registerFloatingPanel(
      testPanel({
        title: () => {
          throw new Error("bad i18n key");
        },
      }),
    );

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(String(args[0]));
    };
    try {
      // Many reads (as happen during a drag, which re-renders every
      // pointermove) log exactly once, not once per read.
      for (let i = 0; i < 5; i++) {
        const panel = getFloatingPanel("viewer");
        assert.equal(panel?.title, "viewer");
      }
    } finally {
      console.error = original;
    }

    assert.equal(errors.length, 1);
    assert.match(errors[0], /Floating panel "viewer" title resolver threw/);
  });

  it("falls back to the panel id when a getter title returns an empty string", () => {
    // A resolver that returns "" (e.g. a mistyped i18n key whose value is
    // missing and the library falls back to empty) would otherwise render as a
    // blank title bar with no signal. Degrade to the id and warn, mirroring the
    // throwing-getter fallback above.
    registerFloatingPanel(testPanel({ title: () => "" }));

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      // Repeated reads during a drag log exactly once.
      for (let i = 0; i < 5; i++) {
        const panel = getFloatingPanel("viewer");
        assert.equal(panel?.title, "viewer");
      }
    } finally {
      console.warn = original;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /returned an empty string/);
  });

  it("dedups title warnings across repeated reads and re-enables on re-register", () => {
    // getFloatingPanel is called unmemoized in FloatingPanelCard's render body,
    // which re-renders on every pointermove while the card is dragged or
    // resized. A throwing getter must log once per panel id (not once per
    // read), otherwise the console floods on every frame of a drag. Mirrors the
    // same guard in the right-panel registry. Re-registering clears the dedup
    // so a later regression surfaces again; unregistering clears it too.
    registerFloatingPanel(
      testPanel({
        title: () => {
          throw new Error("bad i18n key");
        },
      }),
    );

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(String(args[0]));
    };
    try {
      for (let i = 0; i < 5; i++) {
        getFloatingPanel("viewer");
      }
      assert.equal(errors.length, 1);
    } finally {
      console.error = original;
    }

    // Re-registering the same id clears dedup; a still-throwing getter logs
    // once more.
    registerFloatingPanel(
      testPanel({
        title: () => {
          throw new Error("bad i18n key");
        },
      }),
    );
    const errors2: string[] = [];
    console.error = (...args: unknown[]) => {
      errors2.push(String(args[0]));
    };
    try {
      getFloatingPanel("viewer");
      assert.equal(errors2.length, 1);
    } finally {
      console.error = original;
    }

    // Unregistering also clears dedup: a re-registered panel under the same id
    // logs fresh.
    unregisterFloatingPanel("viewer");
    registerFloatingPanel(
      testPanel({
        title: () => {
          throw new Error("bad i18n key");
        },
      }),
    );
    const errors3: string[] = [];
    console.error = (...args: unknown[]) => {
      errors3.push(String(args[0]));
    };
    try {
      getFloatingPanel("viewer");
      assert.equal(errors3.length, 1);
    } finally {
      console.error = original;
    }
  });
});
