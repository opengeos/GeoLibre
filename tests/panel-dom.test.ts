import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  el,
  SELECT_CHEVRON_CLASS,
  setDisabled,
  withSelectChevron,
} from "../packages/plugins/src/panel-dom";
import { readFileSync } from "node:fs";

/**
 * Plugin panels are built by hand against the ambient `document`, so these run
 * against a real DOM rather than a stub: `setDisabled` writes inline style
 * properties, and the point of the helper is how those interact with the
 * `style.cssText` the panels assign.
 */

let restoreGlobals: () => void;

beforeEach(() => {
  const { document, window } = parseHTML("<html><body></body></html>");
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { document, window });
  restoreGlobals = () => {
    Object.assign(globalThis, { document: previousDocument, window: previousWindow });
  };
});

afterEach(() => restoreGlobals());

describe("el", () => {
  it("creates an element and sets text only when given", () => {
    const withText = el("button", "Add");
    assert.equal(withText.tagName.toLowerCase(), "button");
    assert.equal(withText.textContent, "Add");
    assert.equal(el("div").textContent, "");
  });
});

describe("setDisabled", () => {
  /**
   * GeoLibre#1970: the STAC panel styles its buttons with inline
   * background/color/cursor, which overrides the browser's own disabled
   * rendering. Setting `.disabled` alone left a disabled Add button looking
   * exactly like the enabled Zoom and Download buttons beside it, so the
   * disabled state has to carry its own visual treatment.
   */
  it("gives a disabled button a visual treatment an enabled one does not have", () => {
    const button = el("button", "Add");
    setDisabled(button, true);

    assert.equal(button.disabled, true);
    assert.equal(button.style.opacity, "0.5");
    assert.equal(button.style.cursor, "not-allowed");
  });

  it("restores the enabled look, so a re-enabled button is not left dimmed", () => {
    const button = el("button", "Clear results");
    setDisabled(button, true);
    setDisabled(button, false);

    assert.equal(button.disabled, false);
    assert.equal(button.style.opacity, "1");
    assert.equal(button.style.cursor, "pointer");
  });

  it("leaves the disabled and enabled looks distinguishable in both directions", () => {
    const enabled = el("button", "Zoom");
    const disabled = el("button", "Add");
    setDisabled(enabled, false);
    setDisabled(disabled, true);

    assert.notEqual(enabled.style.opacity, disabled.style.opacity);
    assert.notEqual(enabled.style.cursor, disabled.style.cursor);
  });

  // The panels set `style.cssText` to a shared button style, which replaces the
  // whole inline declaration. Calling the helper first would leave no trace, so
  // the ordering the doc comment requires is pinned here rather than left to a
  // reader to rediscover.
  it("is overwritten by a later cssText assignment, the ordering the panels rely on", () => {
    const button = el("button", "Add");
    setDisabled(button, true);
    button.style.cssText = "background:red;cursor:pointer;";

    assert.equal(button.style.opacity, "");
    assert.equal(button.disabled, true, "the property survives; only the styling is wiped");

    // Applied in the supported order, the treatment sticks.
    setDisabled(button, true);
    assert.equal(button.style.opacity, "0.5");
    assert.equal(button.style.cursor, "not-allowed");
  });
});

describe("withSelectChevron", () => {
  it("tags the select and returns it, keeping its other classes", () => {
    const select = document.createElement("select");
    select.className = "panel-field";
    assert.equal(withSelectChevron(select), select);
    assert.ok(select.classList.contains(SELECT_CHEVRON_CLASS));
    assert.ok(select.classList.contains("panel-field"));
  });

  it("survives a later style.cssText assignment", () => {
    const select = withSelectChevron(document.createElement("select"));
    select.style.cssText = "padding:6px;background:hsl(var(--background));";
    assert.ok(select.classList.contains(SELECT_CHEVRON_CLASS));
  });

  it("has a matching rule in the app stylesheet that beats inline styles", () => {
    const css = readFileSync(
      new URL("../apps/geolibre-desktop/src/index.css", import.meta.url),
      "utf8",
    );
    const rule = new RegExp(
      `select\\.${SELECT_CHEVRON_CLASS}:not\\(\\[multiple\\]\\):not\\(\\[size\\]\\) \\{([^}]*)\\}`,
    ).exec(css)?.[1];
    assert.ok(rule, "index.css has the chevron rule");
    for (const prop of ["appearance", "background-image", "padding-inline-end"]) {
      assert.match(rule, new RegExp(`${prop}: [^;]+!important;`), prop);
    }
    assert.match(css, new RegExp(`\\[dir="rtl"\\] select\\.${SELECT_CHEVRON_CLASS}`));
    assert.match(css, new RegExp(`\\.dark select\\.${SELECT_CHEVRON_CLASS}`));
  });
});
