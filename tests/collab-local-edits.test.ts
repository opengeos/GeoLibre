import "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Loaded after the harness: the module imports the app's i18n, which reads Vite globals.
const { viewOnlyLocalChangeAction } =
  await import("../apps/geolibre-desktop/src/lib/collab-local-edits");

const base = { active: true, applyingRemote: false, canEdit: false, noticeShown: false };

describe("viewOnlyLocalChangeAction (#3477)", () => {
  it("tells a view-only participant once that a local change is not shared", () => {
    assert.equal(viewOnlyLocalChangeAction(base), "notify");
    assert.equal(viewOnlyLocalChangeAction({ ...base, noticeShown: true }), "none");
  });

  it("ignores a peer's snapshot and changes outside a live session", () => {
    assert.equal(viewOnlyLocalChangeAction({ ...base, applyingRemote: true }), "none");
    assert.equal(viewOnlyLocalChangeAction({ ...base, active: false }), "none");
  });

  it("re-arms the notice once the participant can edit again", () => {
    assert.equal(viewOnlyLocalChangeAction({ ...base, canEdit: true, noticeShown: true }), "reset");
    assert.equal(viewOnlyLocalChangeAction({ ...base, canEdit: true }), "none");
  });
});
