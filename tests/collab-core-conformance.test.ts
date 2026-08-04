import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeHostAction,
  authorizeSnapshot,
  clearParticipantOverrides,
  MAX_SNAPSHOT_BYTES,
  normalizeMode,
  parseStoredChat,
  participantCanEdit,
  sanitizeColor,
  sanitizeCursor,
  sanitizeDisplayName,
  sanitizeView,
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
    // The message differs from the session-level refusal and is shown to the
    // user by both relays, so pin it: asserting only `ok === false` would let a
    // regression swap in the generic "This session is view-only." text.
    assert.deepEqual(authorizeSnapshot(guest, "co-edit", 20), {
      ok: false,
      code: "forbidden",
      message: "The host has set you to view-only.",
    });
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

    // The Node relay passes its own configured ceiling while the Worker takes
    // the default, so a regression that ignored `maxBytes` would still satisfy
    // the assertions above. Pin the explicit argument too.
    assert.deepEqual(authorizeSnapshot(host, "co-edit", 64, 64), { ok: true });
    const custom = authorizeSnapshot(host, "co-edit", 65, 64);
    assert.equal(custom.ok, false);
    if (!custom.ok) assert.equal(custom.code, "too-large");
  });

  it("drops corrupt entries when reading a persisted chat log", () => {
    // Both relays read chat back out of storage, so this guard belongs to the
    // shared core: a tampered or partially written record must not reach a
    // joiner, where a bad coordinate crashes `coordinate.lat.toFixed`.
    const good = {
      id: "1",
      clientId: "c",
      displayName: "Ada",
      color: "#123456",
      text: "hello",
      ts: 1,
      coordinate: null,
    };
    assert.deepEqual(parseStoredChat(JSON.stringify([good])), [good]);
    assert.deepEqual(parseStoredChat("not json"), []);
    assert.deepEqual(parseStoredChat(JSON.stringify({ not: "an array" })), []);
    assert.deepEqual(parseStoredChat(undefined), []);
    for (const bad of [
      { ...good, color: "red" },
      { ...good, text: "" },
      { ...good, ts: Number.NaN },
      { ...good, coordinate: { lng: "x", lat: 1 } },
      { ...good, id: 7 },
    ]) {
      assert.deepEqual(parseStoredChat(JSON.stringify([bad])), [], JSON.stringify(bad));
    }
    // A corrupt neighbour does not take the valid entries with it.
    assert.deepEqual(parseStoredChat(JSON.stringify([good, { ...good, text: "" }])), [good]);
  });

  it("sanitizes untrusted presence viewports", () => {
    // Both relays run sanitizeView over presence frames, so its contract belongs
    // in the shared suite alongside the permission rules.
    assert.equal(sanitizeView(null), null);
    assert.equal(sanitizeView({ center: "nope" }), null);
    assert.equal(sanitizeView({ center: [Number.NaN, 1] }), null);
    assert.deepEqual(sanitizeView({ center: [1, 2] }), {
      center: [1, 2],
      zoom: 0,
      bearing: 0,
      pitch: 0,
    });
    assert.deepEqual(sanitizeView({ center: [1, 2], bbox: [1, 2, 3, 4] })?.bbox, [1, 2, 3, 4]);
    assert.equal(sanitizeView({ center: [1, 2], bbox: [1, 2, 3] })?.bbox, undefined);
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
    // A whitespace-only name is truthy, so it used to slip past the fallback and
    // reach the roster, every participants broadcast, and every chat author.
    assert.equal(sanitizeDisplayName("   "), "Guest");
    assert.equal(sanitizeDisplayName("  Ada  "), "Ada");
    assert.equal(sanitizeColor("red"), "#888888");
    assert.deepEqual(sanitizeCursor({ lng: -71, lat: 42, extra: "drop" }), {
      lng: -71,
      lat: 42,
    });
    assert.equal(sanitizeCursor({ lng: Number.NaN, lat: 42 }), null);
  });
});
