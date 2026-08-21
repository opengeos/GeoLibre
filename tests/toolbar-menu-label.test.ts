import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  isToolbarLabel,
  resetToolbarLabelWarnings,
  resolveToolbarLabel,
} from "../packages/plugins/src/toolbar-menu-label";

/** Run `fn` with console.error/warn captured, returning what it logged. */
function captureConsole(fn: () => void): { errors: number; warnings: number } {
  const realError = console.error;
  const realWarn = console.warn;
  let errors = 0;
  let warnings = 0;
  console.error = () => {
    errors += 1;
  };
  console.warn = () => {
    warnings += 1;
  };
  try {
    fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
  return { errors, warnings };
}

describe("resolveToolbarLabel", () => {
  beforeEach(() => {
    resetToolbarLabelWarnings();
  });

  it("passes a literal string through", () => {
    assert.equal(resolveToolbarLabel("Bookmarks", "demo"), "Bookmarks");
  });

  it("invokes a getter on every read so it follows the app language", () => {
    // The whole point of the getter form: a plugin registers its menu once, and
    // the label tracks `languageChanged` without re-registration (GeoLibre#2021).
    let locale = "en";
    const label = () => (locale === "zh" ? "书签" : "Bookmarks");
    assert.equal(resolveToolbarLabel(label, "demo"), "Bookmarks");
    locale = "zh";
    assert.equal(resolveToolbarLabel(label, "demo"), "书签");
  });

  it("degrades a throwing getter to the label path and warns once", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    const logged = captureConsole(() => {
      assert.equal(resolveToolbarLabel(throwing, "demo.item"), "demo.item");
      assert.equal(resolveToolbarLabel(throwing, "demo.item"), "demo.item");
    });
    // Menus re-render on every open and every language change, so a repeated
    // failure must not flood the console.
    assert.equal(logged.errors, 1);
  });

  it("degrades an empty or non-string getter result and warns once per path", () => {
    const logged = captureConsole(() => {
      assert.equal(
        resolveToolbarLabel(() => "", "demo.empty"),
        "demo.empty",
      );
      assert.equal(
        resolveToolbarLabel(() => "", "demo.empty"),
        "demo.empty",
      );
      assert.equal(
        resolveToolbarLabel(() => 42 as unknown as string, "demo.number"),
        "demo.number",
      );
    });
    assert.equal(logged.warnings, 2);
  });

  it("warns again for a distinct label path", () => {
    const throwing = () => {
      throw new Error("boom");
    };
    const logged = captureConsole(() => {
      resolveToolbarLabel(throwing, "menu.a");
      resolveToolbarLabel(throwing, "menu.b");
    });
    assert.equal(logged.errors, 2);
  });
});

describe("isToolbarLabel", () => {
  it("accepts non-empty strings and getters", () => {
    assert.equal(isToolbarLabel("Tools"), true);
    assert.equal(
      isToolbarLabel(() => "Tools"),
      true,
    );
  });

  it("rejects an empty string and non-label values", () => {
    assert.equal(isToolbarLabel(""), false);
    assert.equal(isToolbarLabel(undefined), false);
    assert.equal(isToolbarLabel(7), false);
  });
});
