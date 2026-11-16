import { useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderHook } from "@testing-library/react";

const { useCollaboration } = await import("../apps/geolibre-desktop/src/hooks/useCollaboration");
const { createViewOnlyNotice } =
  await import("../apps/geolibre-desktop/src/lib/collab-local-edits");

function guestSession(lockedLayerIds: string[], mode: "co-edit" | "view-only" = "co-edit") {
  useAppStore.getState().setCollaboration({
    isActive: true,
    role: "guest",
    mode,
    clientId: "guest-1",
    participants: [
      {
        clientId: "guest-1",
        displayName: "Guest",
        color: "#ff0000",
        role: "guest",
        editOverride: null,
      },
    ],
    lockedLayerIds,
  });
}

describe("useCollaboration edit gates (#3477)", () => {
  it("lets anything be edited outside a session", () => {
    const { result, unmount } = renderHook(() => useCollaboration({ current: null }, 0));
    assert.equal(result.current.canEditLayer("historic"), true);
    assert.equal(result.current.canEdit(), false);
    unmount();
  });

  it("blocks a guest from a host-locked layer and from everything when view-only", () => {
    const { result, unmount } = renderHook(() => useCollaboration({ current: null }, 0));
    guestSession(["historic"]);
    assert.equal(result.current.canEditLayer("historic"), false);
    assert.equal(result.current.canEditLayer("worship"), true);
    assert.equal(result.current.canEdit(), true);

    guestSession([], "view-only");
    assert.equal(result.current.canEditLayer("worship"), false);
    assert.equal(result.current.canEdit(), false);
    unmount();
  });
});

describe("createViewOnlyNotice (#3477)", () => {
  it("shows once per view-only stretch and re-arms after edit rights return", () => {
    let shown = 0;
    const notice = createViewOnlyNotice(() => {
      shown += 1;
    });
    const local = { active: true, applyingRemote: false };
    notice.onLocalChange({ ...local, canEdit: false });
    notice.onLocalChange({ ...local, canEdit: false });
    notice.onLocalChange({ ...local, applyingRemote: true, canEdit: false });
    assert.equal(shown, 1);
    notice.onLocalChange({ ...local, canEdit: true });
    notice.onLocalChange({ ...local, canEdit: false });
    assert.equal(shown, 2);
    notice.reset();
    notice.onLocalChange({ ...local, canEdit: false });
    assert.equal(shown, 3);
  });
});
