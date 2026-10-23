import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commitPendingAttributeDrafts,
  registerPendingAttributeDrafts,
} from "../apps/geolibre-desktop/src/lib/attribute-draft-commit";

describe("commitPendingAttributeDrafts", () => {
  it("reports none when the table holds no drafts for the layer", () => {
    assert.equal(commitPendingAttributeDrafts("no-drafts"), "none");
  });

  it("commits registered drafts once, then reports none", () => {
    let commits = 0;
    registerPendingAttributeDrafts("layer-a", () => {
      commits++;
      return true;
    });
    assert.equal(commitPendingAttributeDrafts("layer-a"), "committed");
    assert.equal(commits, 1);
    // A second write-back must not replay the same drafts.
    assert.equal(commitPendingAttributeDrafts("layer-a"), "none");
    assert.equal(commits, 1);
  });

  it("blocks when the drafts cannot be applied and keeps them registered", () => {
    const unregister = registerPendingAttributeDrafts("layer-b", () => false);
    assert.equal(commitPendingAttributeDrafts("layer-b"), "blocked");
    assert.equal(commitPendingAttributeDrafts("layer-b"), "blocked");
    unregister();
    assert.equal(commitPendingAttributeDrafts("layer-b"), "none");
  });

  it("scopes drafts to their own layer", () => {
    const unregister = registerPendingAttributeDrafts("layer-c", () => true);
    assert.equal(commitPendingAttributeDrafts("layer-d"), "none");
    unregister();
  });

  it("a stale unregister leaves a newer registration in place", () => {
    const stale = registerPendingAttributeDrafts("layer-e", () => false);
    registerPendingAttributeDrafts("layer-e", () => true);
    stale();
    assert.equal(commitPendingAttributeDrafts("layer-e"), "committed");
  });
});
