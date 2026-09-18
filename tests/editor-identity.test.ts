import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  currentEditorIdentity,
  readStoredAuthorName,
  setStoredAuthorName,
} from "../packages/core/src/editor-identity";
import { DEFAULT_EDITOR_IDENTITY } from "../packages/core/src/editor-tracking";
import { useAppStore } from "../packages/core/src/store";

/** A minimal `localStorage`, installed on the global the way a browser does. */
function installStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  return data;
}

/** A `localStorage` that throws on every access, as a partitioned context does. */
function installHostileStorage() {
  (globalThis as { localStorage?: unknown }).localStorage = {
    get getItem(): never {
      throw new Error("storage blocked");
    },
    get setItem(): never {
      throw new Error("storage blocked");
    },
  };
}

function clearStorage() {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

afterEach(() => {
  clearStorage();
  useAppStore.setState((state) => ({
    collaboration: { ...state.collaboration, isActive: false, selfName: "" },
  }));
});

describe("readStoredAuthorName", () => {
  it("reads and trims the stored name", () => {
    installStorage({ geolibre_author_name: "  Ada  " });
    assert.equal(readStoredAuthorName(), "Ada");
  });

  it("reports no name when storage is absent", () => {
    clearStorage();
    assert.equal(readStoredAuthorName(), "");
  });

  it("reports no name rather than throwing when storage is blocked", () => {
    // Safari private browsing and third-party iframes throw on access; an
    // editor whose browser refuses storage must still be able to edit.
    installHostileStorage();
    assert.equal(readStoredAuthorName(), "");
  });
});

describe("setStoredAuthorName", () => {
  it("persists a trimmed name", () => {
    const data = installStorage();
    setStoredAuthorName("  Ada  ");
    assert.equal(data.get("geolibre_author_name"), "Ada");
  });

  it("clears the name when given a blank one", () => {
    const data = installStorage({ geolibre_author_name: "Ada" });
    setStoredAuthorName("   ");
    assert.equal(data.has("geolibre_author_name"), false);
  });

  it("does not throw when storage is blocked", () => {
    installHostileStorage();
    assert.doesNotThrow(() => setStoredAuthorName("Ada"));
  });
});

describe("currentEditorIdentity", () => {
  it("uses the collaboration session's name while one is active", () => {
    installStorage({ geolibre_author_name: "Ada" });
    useAppStore.setState((state) => ({
      collaboration: { ...state.collaboration, isActive: true, selfName: "Ada (session)" },
    }));
    assert.equal(currentEditorIdentity(), "Ada (session)");
  });

  it("ignores a stale session name once the session ends", () => {
    installStorage({ geolibre_author_name: "Ada" });
    useAppStore.setState((state) => ({
      collaboration: { ...state.collaboration, isActive: false, selfName: "Ada (session)" },
    }));
    assert.equal(currentEditorIdentity(), "Ada");
  });

  it("falls back to the anonymous default with no name anywhere", () => {
    clearStorage();
    assert.equal(currentEditorIdentity(), DEFAULT_EDITOR_IDENTITY);
  });
});
