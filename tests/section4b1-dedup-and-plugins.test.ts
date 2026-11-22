import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  appendBoundedChatHistory,
  isAllowedOrigin,
  prepareChatMessage,
  resolveJoin,
  type CollabInvite,
  type SessionParticipant,
} from "@geolibre/collab-core";
import { saveBinaryFileWithHost } from "../packages/plugins/src/panel-dom";

describe("@geolibre/collab-core shared handlers", () => {
  it("validates allowed origins consistently for both relays", () => {
    assert.equal(isAllowedOrigin(null), true);
    assert.equal(isAllowedOrigin("https://geolibre.app"), true);
    assert.equal(isAllowedOrigin("https://pr-42.geolibre-preview.pages.dev"), true);
    assert.equal(isAllowedOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedOrigin("https://evil.example"), false);
    assert.equal(isAllowedOrigin("https://custom.example", "https://custom.example"), true);
    assert.equal(isAllowedOrigin("https://geolibre.app", "https://custom.example"), false);
  });

  it("closes invite claim TOCTOU and prevents claim losers from inheriting invite overrides", async () => {
    const invite: CollabInvite = {
      token: "one-shot",
      role: "co-edit",
      createdAt: 1,
      maxUses: 1,
      useCount: 0,
      revoked: false,
    };
    const result = await resolveJoin({
      message: {
        type: "join",
        clientId: "",
        displayName: "Late Guest",
        color: "#112233",
        inviteToken: "one-shot",
      },
      storedHostToken: "secret-host",
      requireIdentity: false,
      identitySecret: undefined,
      generateClientId: () => "client-1",
      getInvites: () => [invite],
      isBlockedKey: () => false,
      // Simulate another join claiming the invite during async identity verification.
      claimInvite: () => null,
      getDurableOverride: (key) => (key === "invite:one-shot" ? true : undefined),
    });
    assert.equal(result.status, "ok");
    assert.equal(result.participant.inviteToken, undefined);
    assert.equal(result.participant.editOverride, undefined);
  });

  it("enforces requireIdentity and block list in resolveJoin", async () => {
    const blocked = await resolveJoin({
      message: { type: "join", clientId: "", displayName: "Blocked", color: "#112233" },
      storedHostToken: "host-tok",
      requireIdentity: false,
      identitySecret: undefined,
      generateClientId: () => "c-blocked",
      getInvites: () => [],
      isBlockedKey: (key) => key === "anon:c-blocked",
      claimInvite: () => null,
      getDurableOverride: () => undefined,
    });
    assert.equal(blocked.status, "error");
    assert.equal(blocked.code, "forbidden");

    const needsId = await resolveJoin({
      message: { type: "join", clientId: "", displayName: "Anon", color: "#112233" },
      storedHostToken: "host-tok",
      requireIdentity: true,
      identitySecret: undefined,
      generateClientId: () => "c-anon",
      getInvites: () => [],
      isBlockedKey: () => false,
      claimInvite: () => null,
      getDurableOverride: () => undefined,
    });
    assert.equal(needsId.status, "error");
    assert.equal(needsId.code, "identity-required");
  });

  it("rate-limits chat messages and bounds persisted history by count and byte size", () => {
    const participant: SessionParticipant = {
      clientId: "c1",
      displayName: "Alice",
      color: "#112233",
      role: "guest",
      lastChatTs: 1000,
    };
    assert.equal(
      prepareChatMessage({
        participant,
        message: { type: "chat", text: "   " },
        now: 2000,
        generateId: () => "m0",
      }),
      null,
    );
    assert.equal(
      prepareChatMessage({
        participant,
        message: { type: "chat", text: "too fast" },
        now: 1100,
        generateId: () => "m1",
      }),
      null,
    );
    const prepared = prepareChatMessage({
      participant,
      message: { type: "chat", text: "hello", coordinate: { lng: 10, lat: 20 } },
      now: 1500,
      generateId: () => "m2",
    });
    assert.ok(prepared);
    assert.equal(prepared.chatMessage.text, "hello");
    assert.deepEqual(prepared.chatMessage.coordinate, { lng: 10, lat: 20 });

    const { history } = appendBoundedChatHistory(
      [
        { ...prepared.chatMessage, id: "old-1", text: "x".repeat(300) },
        { ...prepared.chatMessage, id: "old-2", text: "y".repeat(300) },
      ],
      { ...prepared.chatMessage, id: "new-3", text: "z".repeat(100) },
      50,
      400,
    );
    assert.equal(history.length, 1);
    assert.equal(history[0].id, "new-3");
  });
});

describe("plugin host binary file saver", () => {
  it("delegates to app.saveBinaryFile and maps null cancellation to false", async () => {
    const calls: unknown[] = [];
    const saved = await saveBinaryFileWithHost(
      {
        saveBinaryFile: async (filename, data, options) => {
          calls.push([filename, data instanceof Uint8Array, options?.mimeType]);
          return "/tmp/out.bin";
        },
      },
      "out.bin",
      new Uint8Array([1, 2, 3]),
      { mimeType: "application/octet-stream" },
    );
    assert.equal(saved, true);
    assert.deepEqual(calls, [["out.bin", true, "application/octet-stream"]]);

    const cancelled = await saveBinaryFileWithHost(
      { saveBinaryFile: async () => null },
      "out.bin",
      new Uint8Array([1]),
    );
    assert.equal(cancelled, false);
  });
});

describe("Cloudflare Worker observability and rate-limiting config", () => {
  for (const worker of ["collab", "tiles", "viewer"]) {
    it(`workers/${worker}/wrangler.toml configures observability and ratelimits`, () => {
      const toml = readFileSync(
        new URL(`../workers/${worker}/wrangler.toml`, import.meta.url),
        "utf8",
      );
      assert.match(toml, /\[observability\]/);
      assert.match(toml, /\[\[ratelimits\]\]/);
    });
  }
});
