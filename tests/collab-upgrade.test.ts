import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeSnapshot,
  diffLockedLayers,
  getParticipantKey,
  participantCanEditLayer,
  type SessionParticipant,
} from "../packages/collab-core/src/index.ts";
import { createRelay } from "../workers/collab-node/src/server.ts";
import WebSocket from "ws";

describe("Collaboration Upgrade Proposals", () => {
  it("computes participant keys correctly for anon, invite, and identity users", () => {
    const anon: SessionParticipant = {
      clientId: "c-1",
      displayName: "Anon",
      color: "#000",
      role: "guest",
    };
    assert.equal(getParticipantKey(anon), "anon:c-1");

    const inviteUser: SessionParticipant = {
      clientId: "c-2",
      displayName: "Invited",
      color: "#000",
      role: "guest",
      inviteToken: "tok-123",
    };
    assert.equal(getParticipantKey(inviteUser), "invite:tok-123");

    const signedInUser: SessionParticipant = {
      clientId: "c-3",
      displayName: "User",
      color: "#000",
      role: "guest",
      identity: { provider: "geolibre", userId: "usr-456", username: "User" },
    };
    assert.equal(getParticipantKey(signedInUser), "user:usr-456");
  });

  it("diffs locked layers on inbound project snapshot", () => {
    const stored = {
      layers: [
        { id: "layer-1", name: "Base Layer" },
        { id: "layer-2", name: "Roads" },
      ],
    };
    const validInbound = {
      layers: [
        { id: "layer-1", name: "Base Layer" },
        { id: "layer-2", name: "Roads Modified" },
      ],
    };
    const invalidInbound = {
      layers: [
        { id: "layer-1", name: "Base Layer Tampered" },
        { id: "layer-2", name: "Roads Modified" },
      ],
    };

    // Layer-1 is locked; editing layer-2 is fine, editing layer-1 is blocked
    const lockedLayerIds = ["layer-1"];
    assert.equal(diffLockedLayers(stored, validInbound, lockedLayerIds), null);
    assert.notEqual(diffLockedLayers(stored, invalidInbound, lockedLayerIds), null);
  });

  it("evaluates layer edit permissions with participantCanEditLayer", () => {
    const host: SessionParticipant = { clientId: "h", displayName: "Host", color: "#000", role: "host" };
    const guest: SessionParticipant = { clientId: "g", displayName: "Guest", color: "#000", role: "guest" };

    const lockedLayerIds = ["layer-locked"];

    // Host can edit any layer
    assert.equal(participantCanEditLayer(host, "co-edit", "layer-locked", lockedLayerIds), true);

    // Guest cannot edit locked layer, but can edit unlocked layer
    assert.equal(participantCanEditLayer(guest, "co-edit", "layer-locked", lockedLayerIds), false);
    assert.equal(participantCanEditLayer(guest, "co-edit", "layer-unlocked", lockedLayerIds), true);
  });

  it("authorizes snapshot rejecting layer-locked edits from guests", () => {
    const guest: SessionParticipant = { clientId: "g", displayName: "Guest", color: "#000", role: "guest" };
    const stored = { layers: [{ id: "l1", name: "Old" }] };
    const inbound = { layers: [{ id: "l1", name: "New" }] };

    const auth = authorizeSnapshot(guest, "co-edit", 100, 1_000_000, stored, inbound, ["l1"]);
    assert.equal(auth.ok, false);
    if (!auth.ok) {
      assert.equal(auth.code, "layer-locked");
    }
  });

  it("executes relay end-to-end flow for invites, moderation, and config", async () => {
    const relay = createRelay({ port: 0, dbPath: ":memory:" });
    await new Promise<void>((res) => relay.server.listen(0, "127.0.0.1", () => res()));
    const address = relay.server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsBaseUrl = `ws://127.0.0.1:${address.port}`;

    // Create session
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "co-edit", requireIdentity: false }),
    });
    assert.equal(res.status, 200);
    const sessionInfo = (await res.json()) as { sessionId: string; hostToken: string };

    // Host connects
    const hostWs = new WebSocket(`${wsBaseUrl}/sessions/${sessionInfo.sessionId}/ws`);
    let hostWelcome: any = null;
    await new Promise<void>((res) => {
      hostWs.on("open", () => {
        hostWs.send(JSON.stringify({ type: "join", displayName: "HostUser", color: "#2563eb", hostToken: sessionInfo.hostToken }));
      });
      hostWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "welcome") {
          hostWelcome = msg;
          res();
        }
      });
    });
    assert.equal(hostWelcome.role, "host");

    // Mint invite token
    let inviteToken = "";
    await new Promise<void>((res) => {
      hostWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "invite-created") {
          inviteToken = msg.invite.token;
          res();
        }
      });
      hostWs.send(JSON.stringify({ type: "mint-invite", role: "view-only", maxUses: 1 }));
    });
    assert.ok(inviteToken);

    // Guest joins using invite token
    const guestWs = new WebSocket(`${wsBaseUrl}/sessions/${sessionInfo.sessionId}/ws`);
    let guestWelcome: any = null;
    await new Promise<void>((res) => {
      guestWs.on("open", () => {
        guestWs.send(JSON.stringify({ type: "join", displayName: "GuestUser", color: "#dc2626", inviteToken }));
      });
      guestWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "welcome") {
          guestWelcome = msg;
          res();
        }
      });
    });
    assert.equal(guestWelcome.role, "guest");

    // Host kicks guest
    let guestKicked = false;
    await new Promise<void>((res) => {
      guestWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "kicked") {
          guestKicked = true;
        }
      });
      guestWs.on("close", () => {
        res();
      });
      hostWs.send(JSON.stringify({ type: "kick-participant", clientId: guestWelcome.clientId, reason: "Testing kick" }));
    });
    assert.equal(guestKicked, true);

    hostWs.close();
    await relay.close();
  });
});
