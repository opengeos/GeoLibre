import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetRightPanelRegistryForTests,
  closeRightPanel,
  collapseRightPanel,
  getActiveRightPanel,
  getRightPanel,
  getRightPanelSnapshot,
  isRightPanelCollapsed,
  listRightPanels,
  openRightPanel,
  registerRightPanel,
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
      registerRightPanel({
        id: "x",
        title: "x",
      } as unknown as GeoLibreRightPanelRegistration),
    );
  });
});
