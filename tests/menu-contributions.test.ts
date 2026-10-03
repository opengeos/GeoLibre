import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __resetMenuContributionRegistryForTests,
  getMenuContributionsSnapshot,
  listMenuContributions,
  registerMenuContribution,
  subscribeMenuContributions,
  unregisterMenuContribution,
} from "../packages/plugins/src/menu-contribution-registry";
import type {
  GeoLibreMenuContribution,
  GeoLibreMenuContributionTarget,
} from "../packages/plugins/src/types";
import { groupMenuContributions } from "../apps/geolibre-desktop/src/lib/menu-contributions";

function contribution(
  id: string,
  menu: GeoLibreMenuContributionTarget = "processing",
  itemIds: string[] = ["run"],
): GeoLibreMenuContribution {
  return {
    id,
    menu,
    items: itemIds.map((itemId) => ({ id: itemId, label: itemId, onSelect: () => undefined })),
  };
}

describe("menu-contribution registry", () => {
  afterEach(() => __resetMenuContributionRegistryForTests());

  it("registers, replaces by id, and unregisters", () => {
    registerMenuContribution(contribution("a"), "plugin-a", "Plugin A");
    assert.equal(listMenuContributions().length, 1);
    assert.equal(listMenuContributions()[0].ownerPluginName, "Plugin A");

    const dispose = registerMenuContribution(contribution("a", "controls"), "plugin-a");
    assert.equal(listMenuContributions().length, 1);
    assert.equal(listMenuContributions()[0].contribution.menu, "controls");

    dispose();
    assert.equal(listMenuContributions().length, 0);
  });

  it("does not let a stale disposer evict a newer registration", () => {
    const stale = registerMenuContribution(contribution("a"));
    registerMenuContribution(contribution("a", "addData"));
    stale();
    assert.equal(listMenuContributions().length, 1);
    unregisterMenuContribution("a");
    assert.equal(listMenuContributions().length, 0);
  });

  it("notifies subscribers with a new snapshot on each change", () => {
    let calls = 0;
    const unsubscribe = subscribeMenuContributions(() => {
      calls += 1;
    });
    const before = getMenuContributionsSnapshot();
    registerMenuContribution(contribution("a"));
    const after = getMenuContributionsSnapshot();
    assert.equal(calls, 1);
    assert.notEqual(before, after);
    assert.equal(after.version, before.version + 1);
    // No change, no new snapshot.
    unregisterMenuContribution("missing");
    assert.equal(getMenuContributionsSnapshot(), after);
    unsubscribe();
  });

  it("rejects a malformed contribution", () => {
    assert.throws(() => registerMenuContribution({ ...contribution("a"), id: "" }));
    assert.throws(() =>
      registerMenuContribution({
        ...contribution("a"),
        items: undefined as unknown as GeoLibreMenuContribution["items"],
      }),
    );
  });

  it("ignores an unknown target menu with a single warning instead of throwing", () => {
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const bad = { ...contribution("a"), menu: "vector" } as unknown as GeoLibreMenuContribution;
      const dispose = registerMenuContribution(bad);
      registerMenuContribution(bad);
      dispose();
    } finally {
      console.warn = warn;
    }
    assert.equal(listMenuContributions().length, 0);
    assert.equal(warnings.length, 1);
  });
});

describe("groupMenuContributions", () => {
  afterEach(() => __resetMenuContributionRegistryForTests());

  it("keeps only the target menu and merges one plugin's contributions", () => {
    registerMenuContribution(contribution("a1", "processing", ["x"]), "plugin-a", "Plugin A");
    registerMenuContribution(contribution("b1", "processing", ["y"]), "plugin-b", "Plugin B");
    registerMenuContribution(contribution("a2", "processing", ["z"]), "plugin-a", "Plugin A");
    registerMenuContribution(contribution("a3", "controls", ["w"]), "plugin-a", "Plugin A");

    const groups = groupMenuContributions(listMenuContributions(), "processing");
    assert.deepEqual(
      groups.map((g) => [g.id, g.name, g.sections.map((s) => s.id)]),
      [
        ["plugin-a", "Plugin A", ["a1", "a2"]],
        ["plugin-b", "Plugin B", ["b1"]],
      ],
    );
  });

  it("skips empty contributions and groups unowned ones by their own id", () => {
    registerMenuContribution(contribution("empty", "addData", []), "plugin-a");
    registerMenuContribution(contribution("host-only", "addData"));

    const groups = groupMenuContributions(listMenuContributions(), "addData");
    assert.deepEqual(
      groups.map((g) => [g.key, g.id]),
      [["contribution:host-only", "host-only"]],
    );
  });
});
