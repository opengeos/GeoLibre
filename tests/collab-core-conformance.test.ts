import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeHostAction,
  authorizeSnapshot,
  clearParticipantOverrides,
  MAX_SNAPSHOT_BYTES,
  normalizeMode,
  participantCanEdit,
  sanitizeColor,
  sanitizeCursor,
  sanitizeDisplayName,
  setParticipantOverride,
  toWireParticipant,
  type SessionParticipant,
} from "../packages/collab-core/src/index";

function participant(role: "host" | "guest", clientId = role): SessionParticipant {
  return {
    clientId,
    displayName: role,
    color: "#123456",
    role,
  };
}

/**
 * Transport implementations run these policy-level assertions against the
 * shared core. Adapter-specific suites may reuse the same scenarios over real
 * sockets; keeping the decisions here makes Cloudflare and Node relays agree.
 */
describe("collaboration relay conformance", () => {
  it("rejects a guest snapshot in a view-only session", () => {
    assert.deepEqual(authorizeSnapshot(participant("guest"), "view-only", 20), {
      ok: false,
      code: "forbidden",
      message: "This session is view-only.",
    });
  });

  it("applies participant overrides ahead of the session mode", () => {
    const guest = participant("guest");
    guest.editOverride = true;
    assert.equal(participantCanEdit(guest, "view-only"), true);
    assert.deepEqual(authorizeSnapshot(guest, "view-only", 20), { ok: true });

    guest.editOverride = false;
    assert.equal(participantCanEdit(guest, "co-edit"), false);
    assert.equal(authorizeSnapshot(guest, "co-edit", 20).ok, false);
  });

  it("gates set-mode and set-participant-mode to the host", () => {
    const guest = participant("guest");
    const host = participant("host");
    assert.equal(
      authorizeHostAction(guest, "session mode"),
      "Only the host can change session mode.",
    );
    assert.equal(
      authorizeHostAction(guest, "participant permissions"),
      "Only the host can change participant permissions.",
    );
    assert.equal(authorizeHostAction(host, "session mode"), null);

    const target = participant("guest", "target");
    assert.equal(setParticipantOverride(guest, [target], "target", true), false);
    assert.equal(target.editOverride, undefined);
    assert.equal(setParticipantOverride(host, [target], "target", true), true);
    assert.equal(target.editOverride, true);
    assert.equal(setParticipantOverride(host, [host], "host", false), false);
  });

  it("rejects snapshots over the UTF-8 byte ceiling", () => {
    const host = participant("host");
    assert.deepEqual(authorizeSnapshot(host, "co-edit", MAX_SNAPSHOT_BYTES), { ok: true });
    const decision = authorizeSnapshot(host, "co-edit", MAX_SNAPSHOT_BYTES + 1);
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, "too-large");
  });

  it("clears sticky overrides when the host changes the session mode", () => {
    const host = participant("host");
    const guest = participant("guest");
    guest.editOverride = true;
    assert.equal(clearParticipantOverrides([host, guest]), true);
    assert.equal(guest.editOverride, undefined);
    assert.equal(clearParticipantOverrides([host, guest]), false);
    assert.equal(normalizeMode("invalid"), "co-edit");
    assert.equal(normalizeMode("view-only"), "view-only");
  });

  it("normalizes participants and sanitizes untrusted join/presence fields", () => {
    const guest = participant("guest");
    assert.equal(toWireParticipant(guest).editOverride, null);
    assert.equal(sanitizeDisplayName(42), "Guest");
    assert.equal(sanitizeColor("red"), "#888888");
    assert.deepEqual(sanitizeCursor({ lng: -71, lat: 42, extra: "drop" }), {
      lng: -71,
      lat: 42,
    });
    assert.equal(sanitizeCursor({ lng: Number.NaN, lat: 42 }), null);
  });
});
