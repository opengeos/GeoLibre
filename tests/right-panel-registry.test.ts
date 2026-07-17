import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetRightPanelRegistryForTests,
  closeRightPanel,
  collapseRightPanel,
  getActiveRightPanel,
  getActiveRightPanelDock,
  getRightPanel,
  getRightPanelSnapshot,
  isRightPanelCollapsed,
  listRightPanels,
  moveActiveRightPanelDock,
  openRightPanel,
  registerRightPanel,
  setActiveRightPanelDock,
  subscribeRightPanels,
  unregisterRightPanel,
} from "../packages/plugins/src/right-panel-registry";
import type { GeoLibreRightPanelRegistration } from "../packages/plugins/src/types";

function testPanel(
  patch: Partial<GeoLibreRightPanelRegistration> = {},
): GeoLibreRightPanelRegistration {
  return {
    id: "workbench",
    title: "Workbench",
    render: () => undefined,
    ...patch,
  };
}

afterEach(() => {
  __resetRightPanelRegistryForTests();
});

describe("right-panel registry", () => {
  it("registers a panel without opening it", () => {
    registerRightPanel(testPanel());
    assert.equal(listRightPanels().length, 1);
    assert.equal(getActiveRightPanel(), null);
    assert.equal(getRightPanel("workbench")?.title, "Workbench");
  });

  it("opens, collapses, and closes the active panel and fires hooks", () => {
    const calls: string[] = [];
    registerRightPanel(
      testPanel({
        onOpen: () => calls.push("open"),
        onCollapse: () => calls.push("collapse"),
        onClose: () => calls.push("close"),
      }),
    );

    assert.equal(openRightPanel("workbench"), true);
    assert.equal(getActiveRightPanel(), "workbench");
    assert.equal(isRightPanelCollapsed(), false);

    collapseRightPanel("workbench");
    assert.equal(getActiveRightPanel(), "workbench");
    assert.equal(isRightPanelCollapsed(), true);

    // Re-opening a collapsed panel expands it without re-firing onOpen.
    openRightPanel("workbench");
    assert.equal(isRightPanelCollapsed(), false);

    closeRightPanel("workbench");
    assert.equal(getActiveRightPanel(), null);

    assert.deepEqual(calls, ["open", "collapse", "close"]);
  });

  it("returns false and warns when opening an unregistered id", () => {
    assert.equal(openRightPanel("missing"), false);
    assert.equal(getActiveRightPanel(), null);
  });

  it("closes the active panel when it is unregistered", () => {
    const calls: string[] = [];
    registerRightPanel(testPanel({ onClose: () => calls.push("close") }));
    openRightPanel("workbench");
    unregisterRightPanel("workbench");
    assert.equal(getActiveRightPanel(), null);
    assert.equal(listRightPanels().length, 0);
    assert.deepEqual(calls, ["close"]);
  });

  it("only acts on the active panel for collapse and close", () => {
    registerRightPanel(testPanel({ id: "a", title: "A" }));
    registerRightPanel(testPanel({ id: "b", title: "B" }));
    openRightPanel("a");
    // Collapsing/closing a non-active panel is a no-op.
    collapseRightPanel("b");
    assert.equal(isRightPanelCollapsed(), false);
    closeRightPanel("b");
    assert.equal(getActiveRightPanel(), "a");
  });

  it("fires onClose for the displaced panel when a new panel takes over", () => {
    const calls: string[] = [];
    registerRightPanel(
      testPanel({ id: "a", title: "A", onClose: () => calls.push("a:close") }),
    );
    registerRightPanel(
      testPanel({ id: "b", title: "B", onOpen: () => calls.push("b:open") }),
    );
    openRightPanel("a");
    openRightPanel("b");
    assert.equal(getActiveRightPanel(), "b");
    assert.deepEqual(calls, ["a:close", "b:open"]);
  });

  it("defaults to right-of-style and honors a declared dock", () => {
    registerRightPanel(testPanel({ id: "r", title: "R" }));
    registerRightPanel(
      testPanel({ id: "l", title: "L", dock: "left-of-layers" }),
    );
    openRightPanel("r");
    assert.equal(getActiveRightPanelDock(), "right-of-style");
    assert.equal(getRightPanelSnapshot().dock, "right-of-style");
    openRightPanel("l");
    assert.equal(getActiveRightPanelDock(), "left-of-layers");
  });

  it("sets and steps the dock, resetting on switch and clearing on close", () => {
    registerRightPanel(testPanel({ id: "a", title: "A" }));
    registerRightPanel(testPanel({ id: "b", title: "B" }));
    openRightPanel("a");
    assert.equal(getActiveRightPanelDock(), "right-of-style");

    setActiveRightPanelDock("left-of-style");
    assert.equal(getActiveRightPanelDock(), "left-of-style");
    assert.equal(getRightPanelSnapshot().dock, "left-of-style");

    // Stepping left/right walks the four ordered positions, stopping at the ends.
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), "right-of-layers");
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), "left-of-layers");
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), "left-of-layers");
    moveActiveRightPanelDock("right");
    moveActiveRightPanelDock("right");
    moveActiveRightPanelDock("right");
    assert.equal(getActiveRightPanelDock(), "right-of-style");
    moveActiveRightPanelDock("right");
    assert.equal(getActiveRightPanelDock(), "right-of-style");

    // Opening another panel resets to that panel's declared dock.
    openRightPanel("b");
    assert.equal(getActiveRightPanelDock(), "right-of-style");
    // Closing clears the dock entirely.
    closeRightPanel("b");
    assert.equal(getActiveRightPanelDock(), null);
  });

  it("honors replace-style: settable at runtime but not part of the step order", () => {
    registerRightPanel(testPanel({ dock: "replace-style" }));
    openRightPanel("workbench");
    // A declared replace-style dock survives normalization.
    assert.equal(getActiveRightPanelDock(), "replace-style");
    assert.equal(getRightPanelSnapshot().dock, "replace-style");

    // It is not part of the steppable position order, so the move arrows are a
    // no-op while it is in the shared rail.
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), "replace-style");
    moveActiveRightPanelDock("right");
    assert.equal(getActiveRightPanelDock(), "replace-style");

    // setActiveRightPanelDock can detach it to a positional dock (the move
    // arrows then work)...
    setActiveRightPanelDock("right-of-style");
    assert.equal(getActiveRightPanelDock(), "right-of-style");
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), "left-of-style");

    // ...and can merge it back into the shared rail at runtime.
    setActiveRightPanelDock("replace-style");
    assert.equal(getActiveRightPanelDock(), "replace-style");
  });

  it("supports replace-layers as a runtime shared-rail mode, like replace-style", () => {
    registerRightPanel(testPanel({ dock: "right-of-layers" }));
    openRightPanel("workbench");
    assert.equal(getActiveRightPanelDock(), "right-of-layers");

    // Merge a layers-side panel into the shared Layers rail at runtime.
    setActiveRightPanelDock("replace-layers");
    assert.equal(getActiveRightPanelDock(), "replace-layers");
    // It is not steppable while in the shared rail.
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), "replace-layers");

    // Detach it back to a movable layers-side dock.
    setActiveRightPanelDock("right-of-layers");
    assert.equal(getActiveRightPanelDock(), "right-of-layers");
  });

  it("falls back to right-of-style for an unknown declared dock", () => {
    registerRightPanel(
      testPanel({
        dock: "nonsense" as unknown as GeoLibreRightPanelRegistration["dock"],
      }),
    );
    openRightPanel("workbench");
    assert.equal(getActiveRightPanelDock(), "right-of-style");
  });

  it("ignores dock changes when no panel is active", () => {
    setActiveRightPanelDock("left-of-layers");
    moveActiveRightPanelDock("left");
    assert.equal(getActiveRightPanelDock(), null);
  });

  it("notifies subscribers and exposes a stable snapshot between mutations", () => {
    let notified = 0;
    const unsubscribe = subscribeRightPanels(() => {
      notified += 1;
    });
    const before = getRightPanelSnapshot();
    registerRightPanel(testPanel());
    openRightPanel("workbench");
    const after = getRightPanelSnapshot();

    assert.equal(notified, 2);
    assert.notEqual(before, after);
    // Reading again without a mutation returns the same object identity.
    assert.equal(getRightPanelSnapshot(), after);
    assert.equal(after.activeId, "workbench");

    unsubscribe();
    closeRightPanel("workbench");
    assert.equal(notified, 2);
  });

  it("rejects invalid registrations", () => {
    assert.throws(() =>
      registerRightPanel({
        id: "",
        title: "x",
        render: () => undefined,
      }),
    );
    assert.throws(() =>
      registerRightPanel({ id: "x", title: "", render: () => undefined }),
    );
    assert.throws(() =>
      registerRightPanel({
        id: "x",
        title: "x",
      } as unknown as GeoLibreRightPanelRegistration),
    );
  });

  it("re-registers by id, and a stale disposer does not evict the new panel", () => {
    const disposeFirst = registerRightPanel(testPanel({ title: "First" }));
    registerRightPanel(testPanel({ title: "Second" }));
    assert.equal(listRightPanels().length, 1);
    assert.equal(getRightPanel("workbench")?.title, "Second");
    // The first registration's disposer must not remove the replacement.
    disposeFirst();
    assert.equal(getRightPanel("workbench")?.title, "Second");
  });

  it("notifies once and fires onClose when unregistering an active panel", () => {
    const calls: string[] = [];
    registerRightPanel(testPanel({ onClose: () => calls.push("close") }));
    openRightPanel("workbench");
    let notified = 0;
    const unsubscribe = subscribeRightPanels(() => {
      notified += 1;
    });
    unregisterRightPanel("workbench");
    assert.equal(notified, 1);
    assert.equal(getActiveRightPanel(), null);
    assert.deepEqual(calls, ["close"]);
    unsubscribe();
  });

  it("resolves a getter title live without mutating the registration object", () => {
    // A getter title must re-localize on language change without the host
    // clobbering the function on the caller's own registration object.
    let current = "Workbench (en)";
    const panel = testPanel({ title: () => current });
    registerRightPanel(panel);

    assert.equal(getRightPanel("workbench")?.title, "Workbench (en)");
    assert.equal(typeof panel.title, "function");

    current = "Workbench (zh)";
    assert.equal(getRightPanel("workbench")?.title, "Workbench (zh)");
    assert.equal(typeof panel.title, "function");
  });

  it("re-registering the same object keeps a getter title reactive", () => {
    // Regression: an earlier build resolved panel.title in place, turning the
    // function into a static string, so a re-registration of the same object
    // (a supported pattern) froze the title on its first value.
    let current = "First";
    const panel = testPanel({ title: () => current });
    registerRightPanel(panel);
    assert.equal(getRightPanel("workbench")?.title, "First");

    registerRightPanel(panel);
    assert.equal(typeof panel.title, "function");

    current = "Second";
    assert.equal(getRightPanel("workbench")?.title, "Second");
  });

  it("listRightPanels resolves titles to strings and does not leak getters", () => {
    // getRightPanel resolves titles; listRightPanels must mirror it so every
    // `.title` in the returned list is a string, not a getter function.
    let current = "Workbench (en)";
    registerRightPanel(testPanel({ title: () => current }));

    const listed = listRightPanels();
    assert.equal(listed.length, 1);
    assert.equal(typeof listed[0].title, "string");
    assert.equal(listed[0].title, "Workbench (en)");

    // Resolving must be live and must not mutate the original registration.
    current = "Workbench (zh)";
    assert.equal(listRightPanels()[0].title, "Workbench (zh)");

    // Multiple panels all resolve, including plain-string titles.
    registerRightPanel(testPanel({ id: "extra", title: "Extra" }));
    const byId = Object.fromEntries(listRightPanels().map((p) => [p.id, p.title]));
    assert.deepEqual(byId, { workbench: "Workbench (zh)", extra: "Extra" });
  });

  it("falls back to the panel id when a getter title throws, for both accessors", () => {
    // A throwing title getter must not propagate into the React render tree
    // (getRightPanel/listRightPanels are called directly in component bodies).
    // It degrades to the panel id and logs the error, mirroring runHook/render.
    registerRightPanel(
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
      // getRightPanel must not throw and must fall back to the panel id.
      const byId = getRightPanel("workbench");
      assert.equal(byId?.title, "workbench");
      // listRightPanels must mirror that behavior.
      const listed = listRightPanels();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].title, "workbench");
    } finally {
      console.error = original;
    }

    // The throw is logged once per panel id even though both accessors ran;
    // repeated unmemoized reads don't spam the console.
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Right panel "workbench" title resolver threw/);
  });

  it("falls back to the panel id when a getter title returns an empty string, for both accessors", () => {
    // A resolver that returns "" (e.g. a mistyped i18n key whose value is
    // missing and the library falls back to empty) would otherwise render as a
    // blank header with no signal. Degrade to the id and warn, mirroring the
    // throwing-getter fallback above.
    registerRightPanel(testPanel({ title: () => "" }));

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      // getRightPanel must fall back to the panel id (not "").
      const byId = getRightPanel("workbench");
      assert.equal(byId?.title, "workbench");
      // listRightPanels must mirror that behavior.
      const listed = listRightPanels();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].title, "workbench");
    } finally {
      console.warn = original;
    }

    // The empty result is logged once per panel id even though both
    // accessors ran.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /returned an empty string/);
  });

  it("dedups title warnings across repeated reads and re-enables on re-register", () => {
    // getRightPanel/listRightPanels are called unmemoized on every render and
    // PluginRightPanel mounts up to 4x for the dock slots, so a throwing getter
    // must log once per panel id (not once per read). Re-registering the panel
    // clears the dedup so a later regression surfaces again.
    registerRightPanel(
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
      // Many reads across both accessors produce exactly one log.
      for (let i = 0; i < 5; i++) {
        getRightPanel("workbench");
        listRightPanels();
      }
      assert.equal(errors.length, 1);
    } finally {
      console.error = original;
    }

    // Re-registering clears dedup; a still-throwing getter logs once more.
    registerRightPanel(
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
      getRightPanel("workbench");
      assert.equal(errors2.length, 1);
    } finally {
      console.error = original;
    }
  });
});
