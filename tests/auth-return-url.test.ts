import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeStashedQuery } from "../apps/geolibre-desktop/src/lib/auth-return-url";

describe("restoring a deep link across a sign-in redirect", () => {
  it("adds the stashed parameters to the callback's own", () => {
    assert.equal(
      mergeStashedQuery("?code=abc&state=xyz", "?locale=fr&theme=dark"),
      "?code=abc&state=xyz&locale=fr&theme=dark",
    );
  });

  it("never lets a stale stash shadow the callback's parameters", () => {
    // A second login started from a URL that still carried an old code/state
    // must not resurrect them — the callback's values are the live ones.
    assert.equal(
      mergeStashedQuery("?code=new&state=fresh", "?code=old&state=stale&locale=fr"),
      "?code=new&state=fresh&locale=fr",
    );
  });

  it("keeps every value of a repeated parameter", () => {
    assert.equal(
      mergeStashedQuery("?code=abc", "?layer=roads&layer=rivers"),
      "?code=abc&layer=roads&layer=rivers",
    );
  });

  it("preserves an encoded value", () => {
    const project = "https%3A%2F%2Fexample.com%2Fa.geolibre.json";
    const merged = new URLSearchParams(mergeStashedQuery("?code=abc", `?project=${project}`));
    assert.equal(merged.get("project"), "https://example.com/a.geolibre.json");
  });

  it("handles an empty stash and an empty callback query", () => {
    assert.equal(mergeStashedQuery("?code=abc", ""), "?code=abc");
    assert.equal(mergeStashedQuery("", "?locale=fr"), "?locale=fr");
    assert.equal(mergeStashedQuery("", ""), "");
  });
});
