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

  it("suppresses the wizard for falsy welcome values", () => {
    for (const value of ["0", "false", "off", "no", "FALSE", " off "]) {
      withSearch(`?welcome=${encodeURIComponent(value)}`);
      assert.equal(shouldSuppressOnboarding(), true, `welcome=${value}`);
    }
  });

  it("keeps the wizard for truthy or absent welcome values", () => {
    for (const value of ["1", "true", "on", "yes"]) {
      withSearch(`?welcome=${value}`);
      assert.equal(shouldSuppressOnboarding(), false, `welcome=${value}`);
    }
  });

  it("shows the wizard when window is undefined (SSR)", () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(shouldSuppressOnboarding(), false);
  });
});
