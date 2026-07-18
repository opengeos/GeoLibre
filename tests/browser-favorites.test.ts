import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addFavorite,
  FAVORITES_CHANGED_EVENT,
  isFavoritableKind,
  MAX_FAVORITES,
  readBrowserFavorites,
  removeFavorite,
  type BrowserFavorite,
} from "../apps/geolibre-desktop/src/lib/browser-favorites";

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

const svc = (id: string): BrowserFavorite => ({
  id: `service:${id}`,
  kind: "service",
  label: id,
  serviceId: id,
  serviceKind: "xyz",
});

describe("isFavoritableKind", () => {
  it("accepts the favoritable kinds and rejects others", () => {
    for (const k of ["service", "folder", "file"]) {
      assert.equal(isFavoritableKind(k), true);
    }
    // "connection" is deliberately not favoritable (credential in the node id).
    for (const k of ["connection", "section", "category", "recent-project", "table", "info"]) {
      assert.equal(isFavoritableKind(k), false);
    }
  });
});

describe("favorites persistence", () => {
  it("adds to the front, most-recent first", () => {
    addFavorite(svc("a"));
    addFavorite(svc("b"));
    assert.deepEqual(
      readBrowserFavorites().map((f) => f.id),
      ["service:b", "service:a"],
    );
  });

  it("dedupes by id, moving an existing favorite to the front", () => {
    addFavorite(svc("a"));
    addFavorite(svc("b"));
    addFavorite(svc("a"));
    assert.deepEqual(
      readBrowserFavorites().map((f) => f.id),
      ["service:a", "service:b"],
    );
  });

  it("removes by id", () => {
    addFavorite(svc("a"));
    assert.equal(readBrowserFavorites().length, 1);
    removeFavorite("service:a");
    assert.deepEqual(readBrowserFavorites(), []);
  });

  it("caps the list at MAX_FAVORITES", () => {
    for (let i = 0; i < MAX_FAVORITES + 5; i++) addFavorite(svc(`s${i}`));
    assert.equal(readBrowserFavorites().length, MAX_FAVORITES);
  });

  it("dispatches a change event on write", () => {
    addFavorite(svc("a"));
    const events = (globalThis as unknown as { window: { __events: Event[] } }).window.__events;
    assert.ok(events.some((e) => (e as Event).type === FAVORITES_CHANGED_EVENT));
  });

  it("drops malformed and kind-incomplete persisted entries", () => {
    (
      globalThis as unknown as { window: { localStorage: MemoryStorage } }
    ).window.localStorage.setItem(
      "geolibre.browser.favorites",
      JSON.stringify([
        { id: "service:a", kind: "service", label: "a", serviceId: "a" },
        { id: "x", kind: "recent-project", label: "bad" }, // not favoritable
        { kind: "service", label: "no id" }, // missing id
        { id: "service:b", kind: "service", label: "no serviceId" }, // missing serviceId
        { id: "folder:/x", kind: "folder", label: "no path" }, // missing path
        "nonsense",
      ]),
    );
    // Only the fully-formed service survives.
    assert.deepEqual(
      readBrowserFavorites().map((f) => f.id),
      ["service:a"],
    );
  });

  it("caps an oversized persisted list on read", () => {
    const many = Array.from({ length: MAX_FAVORITES + 10 }, (_u, i) => ({
      id: `service:s${i}`,
      kind: "service",
      label: `s${i}`,
      serviceId: `s${i}`,
    }));
    (
      globalThis as unknown as { window: { localStorage: MemoryStorage } }
    ).window.localStorage.setItem("geolibre.browser.favorites", JSON.stringify(many));
    assert.equal(readBrowserFavorites().length, MAX_FAVORITES);
  });

  it("round-trips the builtin flag for a favorited preset service", () => {
    addFavorite({ ...svc("osm"), builtin: true });
    assert.equal(readBrowserFavorites()[0].builtin, true);
  });
});
