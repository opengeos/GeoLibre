import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { initializeNativeShareAuth } from "../apps/geolibre-desktop/src/lib/native-share-auth";
import {
  cancelShareSignIn,
  configureShareOAuthReadiness,
  ShareOAuthError,
  signInToShare,
  useShareOAuthStore,
} from "../apps/geolibre-desktop/src/lib/share-oauth";

describe("abandoned desktop consent", () => {
  it("cancels the native waiter and permits another sign-in immediately", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { crypto, setTimeout, clearTimeout },
    });
    let opened = Promise.withResolvers<void>();
    let opens = 0;
    mockIPC(
      (command) => {
        if (command === "plugin:deep-link|get_current") return null;
        if (command === "plugin:opener|open_url") {
          opens += 1;
          opened.resolve();
          return null;
        }
        throw new Error(`Unexpected Tauri command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    try {
      await initializeNativeShareAuth(() => {});
      configureShareOAuthReadiness(Promise.resolve());
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const signIn = signInToShare("https://share.geolibre.app");
        await opened.promise;
        assert.equal(useShareOAuthStore.getState().pending, true);
        cancelShareSignIn();
        await assert.rejects(
          signIn,
          (error: unknown) => error instanceof ShareOAuthError && error.code === "cancelled",
        );
        assert.equal(useShareOAuthStore.getState().pending, false);
        opened = Promise.withResolvers<void>();
      }
      assert.equal(opens, 2);
    } finally {
      clearMocks();
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
