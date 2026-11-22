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
import {
  createActionRow,
  createButton,
  createModalDialog,
  createSelectField,
  saveBinaryFileWithHost,
} from "../packages/plugins/src/panel-dom";
import { Window } from "happy-dom";

describe("@geolibre/collab-core shared handlers", () => {
  it("validates allowed origins consistently for both relays", () => {
    assert.equal(isAllowedOrigin(null), true);
    assert.equal(isAllowedOrigin("https://geolibre.app"), true);
    assert.equal(isAllowedOrigin("https://pr-42.geolibre-preview.pages.dev"), true);
    assert.equal(isAllowedOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedOrigin("https://evil.example"), false);
    assert.equal(isAllowedOrigin("https://custom.example", "https://custom.example"), true);
    assert.equal(isAllowedOrigin("https://geolibre.app", "https://custom.example"), false);
    // Opaque custom schemes must not match each other via `"null" === "null"`.
    assert.equal(isAllowedOrigin("tauri://localhost", "tauri://localhost"), true);
    assert.equal(isAllowedOrigin("evil://other", "tauri://localhost"), false);
    assert.equal(isAllowedOrigin("tauri://other", "tauri://localhost"), false);
  });

  it("closes invite claim TOCTOU and distinguishes successful vs lost claims", async () => {
    const invite: CollabInvite = {
      token: "one-shot",
      role: "co-edit",
      createdAt: 1,
      maxUses: 1,
      useCount: 0,
      revoked: false,
    };
    const claimedTokens: string[] = [];
    const lost = await resolveJoin({
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
      claimInvite: (token) => {
        claimedTokens.push(token);
        return null;
      },
      getDurableOverride: (key) => (key === "invite:one-shot" ? true : undefined),
    });
    assert.deepEqual(claimedTokens, ["one-shot"]);
    assert.equal(lost.status, "ok");
    assert.equal(lost.participant.inviteToken, undefined);
    assert.equal(lost.participant.editOverride, undefined);

    const won = await resolveJoin({
      message: {
        type: "join",
        clientId: "",
        displayName: "First Guest",
        color: "#112233",
        inviteToken: "one-shot",
      },
      storedHostToken: "secret-host",
      requireIdentity: false,
      identitySecret: undefined,
      generateClientId: () => "client-2",
      getInvites: () => [invite],
      isBlockedKey: () => false,
      claimInvite: (token) => (token === "one-shot" ? { ...invite, useCount: 1 } : null),
      getDurableOverride: () => undefined,
    });
    assert.equal(won.status, "ok");
    assert.equal(won.participant.inviteToken, "one-shot");
    assert.equal(won.participant.editOverride, true);
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

    // Count-only cap with generous byte budget.
    const countTrimmed = appendBoundedChatHistory(
      [
        { ...prepared.chatMessage, id: "c1", text: "one" },
        { ...prepared.chatMessage, id: "c2", text: "two" },
        { ...prepared.chatMessage, id: "c3", text: "three" },
      ],
      { ...prepared.chatMessage, id: "c4", text: "four" },
      2,
      100_000,
    );
    assert.deepEqual(
      countTrimmed.history.map((m) => m.id),
      ["c3", "c4"],
    );
    assert.deepEqual(JSON.parse(countTrimmed.serialized), countTrimmed.history);

    // Byte-only cap with multibyte UTF-8 text (3 bytes per CJK character).
    const utf8Encoder = new TextEncoder();
    const byteTrimmed = appendBoundedChatHistory(
      [
        { ...prepared.chatMessage, id: "old-1", text: "春".repeat(100) },
        { ...prepared.chatMessage, id: "old-2", text: "夏".repeat(100) },
      ],
      { ...prepared.chatMessage, id: "new-3", text: "秋".repeat(40) },
      50,
      400,
    );
    assert.deepEqual(
      byteTrimmed.history.map((m) => m.id),
      ["new-3"],
    );
    assert.ok(utf8Encoder.encode(byteTrimmed.serialized).length <= 400);
    assert.deepEqual(JSON.parse(byteTrimmed.serialized), byteTrimmed.history);
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

describe("plugin panel-dom UI helpers", () => {
  it("builds buttons, select fields, action rows, and traps focus in modals", () => {
    const win = new Window();
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevHTMLElement = globalThis.HTMLElement;
    const prevKeyboardEvent = globalThis.KeyboardEvent;
    const prevEvent = globalThis.Event;
    Object.assign(globalThis, {
      window: win,
      document: win.document,
      HTMLElement: win.HTMLElement,
      KeyboardEvent: win.KeyboardEvent,
      Event: win.Event,
    });
    try {
      const trigger = createButton("Open", { variant: "primary", title: "Open dialog" });
      document.body.appendChild(trigger);
      trigger.focus();

      let selected = "";
      const { wrapper, select } = createSelectField({
        label: "Format",
        options: [
          { value: "geojson", label: "GeoJSON" },
          { value: "gpkg", label: "GeoPackage", disabled: true },
        ],
        value: "geojson",
        onChange: (value) => {
          selected = value;
        },
      });
      assert.equal(select.value, "geojson");
      select.value = "gpkg";
      select.dispatchEvent(new Event("change"));
      assert.equal(selected, "gpkg");

      const okButton = createButton("Confirm", { variant: "primary" });
      const row = createActionRow([okButton], "between");
      assert.equal(row.children.length, 1);

      let closedCount = 0;
      const modal = createModalDialog({
        title: "Export Options",
        body: wrapper,
        actions: [okButton],
        closeLabel: "Dismiss",
        onClose: () => {
          closedCount += 1;
        },
      });
      // Mark interactive controls as visible under happy-dom (which has no layout engine).
      for (const el of modal.dialog.querySelectorAll<HTMLElement>("button, select")) {
        Object.defineProperty(el, "offsetParent", { value: modal.dialog, configurable: true });
      }
      const closeBtn = modal.dialog.querySelector<HTMLButtonElement>(
        'button[aria-label="Dismiss"]',
      )!;
      assert.ok(closeBtn);
      assert.equal(
        modal.dialog.getAttribute("aria-labelledby"),
        modal.dialog.querySelector("h3")?.id,
      );

      // Focus on the dialog container itself must still wrap into the first/last control on Tab.
      modal.dialog.focus();
      assert.equal(document.activeElement, modal.dialog);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
      assert.equal(document.activeElement, closeBtn);

      // Shift+Tab from first focusable element wraps to last focusable element (Confirm).
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true }),
      );
      assert.equal(document.activeElement, okButton);

      // Dragging from inside the dialog and releasing on the overlay must NOT close the modal.
      modal.dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      modal.overlay.dispatchEvent(new Event("click", { bubbles: true }));
      assert.equal(closedCount, 0);

      // Escape closes the modal and restores focus to the trigger.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      assert.equal(closedCount, 1);
      assert.equal(document.activeElement, trigger);
    } finally {
      Object.assign(globalThis, {
        window: prevWindow,
        document: prevDocument,
        HTMLElement: prevHTMLElement,
        KeyboardEvent: prevKeyboardEvent,
        Event: prevEvent,
      });
      win.close();
    }
  });
});

describe("Cloudflare Worker observability and rate-limiting config", () => {
  const expectedBindings: ReadonlyArray<{ worker: string; binding: string }> = [
    { worker: "collab", binding: "COLLAB_RATE_LIMITER" },
    { worker: "tiles", binding: "TILES_RATE_LIMITER" },
    { worker: "viewer", binding: "VIEWER_RATE_LIMITER" },
  ];
  for (const { worker, binding } of expectedBindings) {
    it(`workers/${worker}/wrangler.toml configures observability and ${binding}`, () => {
      const toml = readFileSync(
        new URL(`../workers/${worker}/wrangler.toml`, import.meta.url),
        "utf8",
      );
      const source = readFileSync(
        new URL(`../workers/${worker}/src/index.ts`, import.meta.url),
        "utf8",
      );
      assert.match(toml, /\[observability\]/);
      assert.match(toml, /\[\[ratelimits\]\]/);
      assert.match(toml, new RegExp(`name\\s*=\\s*"${binding}"`));
      assert.ok(source.includes(binding), `workers/${worker}/src/index.ts must read ${binding}`);
    });
  }
});
