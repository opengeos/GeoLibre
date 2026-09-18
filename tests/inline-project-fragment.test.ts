import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject } from "@geolibre/core";
import {
  consumeInlineProjectFragment,
  encodeInlineProjectFragment,
  INLINE_PROJECT_FRAGMENT_KEY,
  INLINE_VIEWER_FRAGMENT_KEY,
  parseInlineProjectFragment,
} from "../apps/geolibre-desktop/src/lib/inline-project-fragment";

describe("inline project URL fragment", () => {
  it("compresses and round-trips a valid project", () => {
    const project = createEmptyProject("Direct file");
    const encoded = encodeInlineProjectFragment(project);
    assert.ok(!/[+/=]/.test(encoded));
    const parsed = parseInlineProjectFragment(`#${INLINE_PROJECT_FRAGMENT_KEY}=${encoded}`);
    assert.equal(parsed?.name, project.name);
    assert.deepEqual(parsed?.mapView, project.mapView);
    assert.deepEqual(parsed?.layers, project.layers);
  });

  it("ignores ordinary fragments", () => {
    assert.equal(parseInlineProjectFragment("#/map"), null);
  });

  it("erases the payload before returning the project", () => {
    const encoded = encodeInlineProjectFragment(createEmptyProject("One shot"));
    const calls: unknown[][] = [];
    const parsed = consumeInlineProjectFragment(
      { hash: `#${INLINE_PROJECT_FRAGMENT_KEY}=${encoded}`, pathname: "/", search: "?embed=1" },
      { replaceState: (...args: unknown[]) => calls.push(args) },
    );
    assert.equal(parsed?.name, "One shot");
    assert.deepEqual(calls, [[null, "", "/?embed=1"]]);
  });

  it("restores a viewer hash route after consuming the payload", () => {
    const encoded = encodeInlineProjectFragment(createEmptyProject("Hash route"));
    const calls: unknown[][] = [];
    const parsed = consumeInlineProjectFragment(
      {
        hash: `#${INLINE_PROJECT_FRAGMENT_KEY}=${encoded}&${INLINE_VIEWER_FRAGMENT_KEY}=${encodeURIComponent("#/view")}`,
        pathname: "/app",
        search: "?embed=1",
      },
      { replaceState: (...args: unknown[]) => calls.push(args) },
    );
    assert.equal(parsed?.name, "Hash route");
    assert.deepEqual(calls, [[null, "", "/app?embed=1#/view"]]);
  });

  it("also erases malformed encoded input", () => {
    const calls: unknown[][] = [];
    assert.throws(() =>
      consumeInlineProjectFragment(
        { hash: `#${INLINE_PROJECT_FRAGMENT_KEY}=bad`, pathname: "/", search: "" },
        { replaceState: (...args: unknown[]) => calls.push(args) },
      ),
    );
    assert.equal(calls.length, 1);
  });
});
