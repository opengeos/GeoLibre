import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetToolbarMenuRegistryForTests,
  getToolbarMenusSnapshot,
  listToolbarMenus,
  registerToolbarMenu,
  subscribeToolbarMenus,
  unregisterToolbarMenu,
} from "../packages/plugins/src/toolbar-menu-registry";
import {
  __resetFloatingPanelRegistryForTests,
  closeFloatingPanel,
  getFloatingPanelsSnapshot,
  getOpenFloatingPanels,
  isFloatingPanelOpen,
  openFloatingPanel,
  registerFloatingPanel,
  subscribeFloatingPanels,
  unregisterFloatingPanel,
} from "../packages/plugins/src/floating-panel-registry";
import type {
  GeoLibreFloatingPanelRegistration,
  GeoLibreToolbarMenu,
} from "../packages/plugins/src/types";

function testMenu(patch: Partial<GeoLibreToolbarMenu> = {}): GeoLibreToolbarMenu {
  return {
    id: "tools",
    label: "Tools",
    items: [{ id: "open", label: "Open", onSelect: () => undefined }],
    ...patch,
  };
}

function testPanel(
  patch: Partial<GeoLibreFloatingPanelRegistration> = {},
): GeoLibreFloatingPanelRegistration {
  return {
    id: "card",
    title: "Card",
    render: () => undefined,
    ...patch,
  };
}

describe("toolbar-menu registry", () => {
  afterEach(() => __resetToolbarMenuRegistryForTests());

  it("registers, replaces, and unregisters menus", () => {
    registerToolbarMenu(testMenu());
    assert.equal(listToolbarMenus().length, 1);
    // Re-registering the same id replaces it rather than duplicating.
    const unregisterSecond = registerToolbarMenu(testMenu({ label: "Tools 2" }));
    assert.equal(listToolbarMenus().length, 1);
    assert.equal(listToolbarMenus()[0].label, "Tools 2");
    unregisterSecond();
    assert.equal(listToolbarMenus().length, 0);
  });

  it("notifies subscribers and keeps a stable snapshot between mutations", () => {
    let notified = 0;
    const unsubscribe = subscribeToolbarMenus(() => {
      notified += 1;
    });
    const before = getToolbarMenusSnapshot();
    registerToolbarMenu(testMenu());
    const after = getToolbarMenusSnapshot();
    assert.equal(notified, 1);
    assert.notEqual(before, after);
    assert.equal(getToolbarMenusSnapshot(), after);
    unsubscribe();
  });

  it("rejects menus without an id, label, or items array", () => {
    assert.throws(() => registerToolbarMenu(testMenu({ id: "" })));
    assert.throws(() => registerToolbarMenu(testMenu({ label: "" })));
    assert.throws(() =>
      registerToolbarMenu({
        id: "x",
        label: "x",
      } as unknown as GeoLibreToolbarMenu),
    );
  });

  it("does not let a stale disposer evict a re-registered menu", () => {
    const disposeFirst = registerToolbarMenu(testMenu({ label: "First" }));
    registerToolbarMenu(testMenu({ label: "Second" }));
    disposeFirst();
    assert.equal(listToolbarMenus().length, 1);
    assert.equal(listToolbarMenus()[0].label, "Second");
  });

  it("records the owning plugin id on the snapshot entry", () => {
    registerToolbarMenu(testMenu({ id: "builtin-menu" }));
    registerToolbarMenu(testMenu({ id: "external-menu" }), "acme.plugin");
    const { entries } = getToolbarMenusSnapshot();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].menu.id, "builtin-menu");
    assert.equal(entries[0].ownerPluginId, undefined);
    assert.equal(entries[1].menu.id, "external-menu");
    assert.equal(entries[1].ownerPluginId, "acme.plugin");
  });
});

describe("floating-panel registry", () => {
  afterEach(() => __resetFloatingPanelRegistryForTests());

  it("opens and closes panels and fires hooks", () => {
    const calls: string[] = [];
    registerFloatingPanel(
      testPanel({
        onOpen: () => calls.push("open"),
        onClose: () => calls.push("close"),
      }),
    );
    assert.equal(openFloatingPanel("card"), true);
    assert.equal(isFloatingPanelOpen("card"), true);
    assert.deepEqual(getOpenFloatingPanels(), ["card"]);
    closeFloatingPanel("card");
    assert.equal(isFloatingPanelOpen("card"), false);
    assert.deepEqual(calls, ["open", "close"]);
  });

  it("supports several open panels and brings re-opened ones to the front", () => {
    registerFloatingPanel(testPanel({ id: "a", title: "A" }));
    registerFloatingPanel(testPanel({ id: "b", title: "B" }));
    openFloatingPanel("a");
    openFloatingPanel("b");
    assert.deepEqual(getOpenFloatingPanels(), ["a", "b"]);
    // Re-opening "a" moves it to the front (end) without re-firing onOpen.
    openFloatingPanel("a");
    assert.deepEqual(getOpenFloatingPanels(), ["b", "a"]);
  });

  it("returns false and warns when opening an unregistered id", () => {
    assert.equal(openFloatingPanel("missing"), false);
  });

  it("closes an open panel when it is unregistered", () => {
    const calls: string[] = [];
    registerFloatingPanel(testPanel({ onClose: () => calls.push("close") }));
    openFloatingPanel("card");
    unregisterFloatingPanel("card");
    assert.equal(isFloatingPanelOpen("card"), false);
    assert.deepEqual(calls, ["close"]);
  });

  it("notifies once when unregistering an open panel", () => {
    const calls: string[] = [];
    registerFloatingPanel(testPanel({ onClose: () => calls.push("close") }));
    openFloatingPanel("card");
    let notified = 0;
    const unsubscribe = subscribeFloatingPanels(() => {
      notified += 1;
    });
    unregisterFloatingPanel("card");
    assert.equal(notified, 1);
    assert.equal(isFloatingPanelOpen("card"), false);
    assert.deepEqual(calls, ["close"]);
    unsubscribe();
  });

  it("notifies subscribers and keeps a stable snapshot between mutations", () => {
    let notified = 0;
    const unsubscribe = subscribeFloatingPanels(() => {
      notified += 1;
    });
    const before = getFloatingPanelsSnapshot();
    registerFloatingPanel(testPanel());
    openFloatingPanel("card");
    const after = getFloatingPanelsSnapshot();
    assert.equal(notified, 2);
    assert.notEqual(before, after);
    assert.equal(getFloatingPanelsSnapshot(), after);
    unsubscribe();
  });
});
