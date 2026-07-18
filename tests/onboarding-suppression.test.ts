import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { shouldSuppressOnboarding } from "../apps/geolibre-desktop/src/lib/onboarding-suppression";

const originalWindow = (globalThis as { window?: unknown }).window;

function withSearch(search: string): void {
  (globalThis as { window?: unknown }).window = {
    location: { search },
  };
}

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe("shouldSuppressOnboarding", () => {
  it("shows the wizard with no query params", () => {
    withSearch("");
    assert.equal(shouldSuppressOnboarding(), false);
  });

  it("suppresses the wizard for every deep-link param form", () => {
    const project = "https://example.com/foo.geolibre.json";
    for (const key of ["url", "project", "projectUrl", "project_url"]) {
      withSearch(`?${key}=${encodeURIComponent(project)}`);
      assert.equal(shouldSuppressOnboarding(), true, key);
    }
  });

  it("suppresses the wizard for a bare URL query", () => {
    withSearch(`?${encodeURIComponent("https://example.com/foo.geolibre.json")}`);
    assert.equal(shouldSuppressOnboarding(), true);
  });

  it("suppresses the wizard when a deep-link param key holds an invalid URL", () => {
    // The intent to open a project (a recognized key is present) suppresses
    // onboarding even if the value does not resolve, so the wizard never layers
    // on top of the load error useProjectUrlLoader shows for a bad link.
    for (const search of ["?url=not-a-valid-url", "?project=", "?projectUrl=ftp://x"]) {
      withSearch(search);
      assert.equal(shouldSuppressOnboarding(), true, search);
    }
  });

  it("keeps the wizard for an invalid bare query with no recognized key", () => {
    withSearch("?not-a-url");
    assert.equal(shouldSuppressOnboarding(), false);
  });

  it("suppresses the wizard for an embed page", () => {
    for (const value of ["1", "true"]) {
      withSearch(`?embed=${encodeURIComponent(value)}`);
      assert.equal(shouldSuppressOnboarding(), true, `embed=${value}`);
    }
  });

  it("keeps the wizard for non-embed, empty, or non-canonical embed values", () => {
    // Matches embedHost.ts isEmbedded() exactly: only the literal "1"/"true"
    // count, so an uppercased or padded value does not suppress onboarding (and
    // would not activate the embed bridge either).
    for (const search of [
      "?embed=0",
      "?embed=false",
      "?embed=TRUE",
      "?embed=%201%20",
      "?embed=",
      "?embed",
    ]) {
      withSearch(search);
      assert.equal(shouldSuppressOnboarding(), false, search);
    }
  });

  it("suppresses the wizard for falsy welcome values", () => {
    for (const value of ["0", "false", "off", "no", "FALSE", " off "]) {
      withSearch(`?welcome=${encodeURIComponent(value)}`);
      assert.equal(shouldSuppressOnboarding(), true, `welcome=${value}`);
    }
  });

  it("keeps the wizard for truthy, empty, or bare welcome values", () => {
    // An empty `?welcome=` or a bare `?welcome` flag is a no-op (unlike
    // `?maponly`), so the wizard still shows.
    for (const search of [
      "?welcome=1",
      "?welcome=true",
      "?welcome=on",
      "?welcome=yes",
      "?welcome=",
      "?welcome",
    ]) {
      withSearch(search);
      assert.equal(shouldSuppressOnboarding(), false, search);
    }
  });

  it("shows the wizard when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(shouldSuppressOnboarding(), false);
  });

  it("suppresses the wizard when the build baked in VITE_WELCOME_DISABLED", () => {
    withSearch("");
    for (const value of ["1", "true", "TRUE", " 1 "]) {
      assert.equal(
        shouldSuppressOnboarding({ VITE_WELCOME_DISABLED: value }),
        true,
        `env=${value}`,
      );
    }
  });

  it("keeps the wizard for falsy, empty, or non-string env values", () => {
    withSearch("");
    for (const value of ["0", "false", "off", "", undefined, true, 1]) {
      assert.equal(
        shouldSuppressOnboarding({ VITE_WELCOME_DISABLED: value }),
        false,
        `env=${String(value)}`,
      );
    }
    // No env at all (the node test runtime has no import.meta.env).
    assert.equal(shouldSuppressOnboarding(undefined), false);
  });
});
