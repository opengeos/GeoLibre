import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getInitialThemeMode } from "../apps/geolibre-desktop/src/hooks/useThemeMode";

const originalWindow = (globalThis as { window?: unknown }).window;

/** Mock `window` with a search string and an OS dark-mode preference. */
function withWindow(search: string, prefersDark: boolean): void {
  (globalThis as { window?: unknown }).window = {
    location: { search },
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
    }),
  };
}

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("getInitialThemeMode", () => {
  it("falls back to the OS preference without a theme param", () => {
    withWindow("", true);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("", false);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("honors ?theme=dark and ?theme=light over the OS preference", () => {
    withWindow("?theme=dark", false);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("?theme=light", true);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    withWindow("?theme=DARK", false);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("?theme=%20Light%20", true);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("ignores an unrecognized or empty theme value and uses the OS preference", () => {
    withWindow("?theme=neon", true);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("?theme=neon", false);
    assert.equal(getInitialThemeMode(), "light");
    // A bare `?theme=` yields "" and should also fall back to the OS preference.
    withWindow("?theme=", true);
    assert.equal(getInitialThemeMode(), "dark");
    withWindow("?theme=", false);
    assert.equal(getInitialThemeMode(), "light");
  });

  it("returns light when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(getInitialThemeMode(), "light");
  });
});
