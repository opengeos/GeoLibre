import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  folderLabel,
  MAX_PINNED_FOLDERS,
  pinFolder,
  PINNED_FOLDERS_CHANGED_EVENT,
  readPinnedFolders,
  unpinFolder,
} from "../apps/geolibre-desktop/src/lib/browser-folders";

// Minimal localStorage + window stub so the module's browser guards run under
// node --test (mirrors how the app persists pinned folders in the browser).
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

beforeEach(() => {
  const events: unknown[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: new MemoryStorage(),
    dispatchEvent: (e: unknown) => {
      events.push(e);
      return true;
    },
    __events: events,
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("folderLabel", () => {
  it("returns the trailing folder name", () => {
    assert.equal(folderLabel("/home/u/gis"), "gis");
    assert.equal(folderLabel("/home/u/gis/"), "gis");
    assert.equal(folderLabel("C:\\data\\gis"), "gis");
  });
});

describe("pinned folders persistence", () => {
  it("pins to the front, most-recently-added first", () => {
    pinFolder("/a");
    pinFolder("/b");
    assert.deepEqual(readPinnedFolders(), ["/b", "/a"]);
  });

  it("dedupes and moves an existing pin to the front", () => {
    pinFolder("/a");
    pinFolder("/b");
    pinFolder("/a");
    assert.deepEqual(readPinnedFolders(), ["/a", "/b"]);
  });

  it("normalizes trailing separators so a folder isn't pinned twice", () => {
    pinFolder("/data/gis");
    pinFolder("/data/gis/"); // trailing slash — same folder
    assert.deepEqual(readPinnedFolders(), ["/data/gis"]);
    // Unpin with the trailing-slash form still removes it.
    unpinFolder("/data/gis/");
    assert.deepEqual(readPinnedFolders(), []);
  });

  it("preserves a Windows drive root when normalizing", () => {
    pinFolder("C:\\");
    assert.deepEqual(readPinnedFolders(), ["C:\\"]);
  });

  it("normalizes legacy un-normalized stored entries on read", () => {
    // Simulate an older build that stored a trailing-slash path.
    (
      globalThis as unknown as { window: { localStorage: MemoryStorage } }
    ).window.localStorage.setItem(
      "geolibre.browser.pinnedFolders",
      JSON.stringify(["/data/gis/", "/data/gis"]),
    );
    // Both collapse to the normalized form and dedupe to one.
    assert.deepEqual(readPinnedFolders(), ["/data/gis"]);
  });

  it("unpins a folder", () => {
    pinFolder("/a");
    pinFolder("/b");
    unpinFolder("/a");
    assert.deepEqual(readPinnedFolders(), ["/b"]);
  });

  it("caps the list at MAX_PINNED_FOLDERS", () => {
    for (let i = 0; i < MAX_PINNED_FOLDERS + 5; i++) pinFolder(`/f${i}`);
    assert.equal(readPinnedFolders().length, MAX_PINNED_FOLDERS);
  });

  it("dispatches a change event on write", () => {
    pinFolder("/a");
    const events = (globalThis as unknown as { window: { __events: Event[] } }).window.__events;
    assert.ok(events.some((e) => (e as Event).type === PINNED_FOLDERS_CHANGED_EVENT));
  });

  it("ignores blank paths", () => {
    pinFolder("   ");
    assert.deepEqual(readPinnedFolders(), []);
  });
});
