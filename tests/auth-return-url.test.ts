import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSignInCallback,
  mergeStashedQuery,
} from "../apps/geolibre-desktop/src/lib/auth-return-url";

describe("recognizing a return from Auth0", () => {
  it("matches a successful login", () => {
    assert.equal(isSignInCallback("?code=abc&state=xyz"), true);
  });

  it("matches a refused login, which carries no code", () => {
    // An Action calling api.access.deny() returns error + state and no code.
    // This is the screen that most needs the visitor's own language.
    assert.equal(
      isSignInCallback("?error=access_denied&error_description=Not%20approved&state=xyz"),
      true,
    );
  });

  it("ignores a load that is not a return from Auth0", () => {
    for (const search of ["", "?project=https%3A%2F%2Fexample.com%2Fa.json", "?theme=dark"]) {
      assert.equal(isSignInCallback(search), false, search);
    }
  });

  it("requires the CSRF state, so a bare code or error does not qualify", () => {
    assert.equal(isSignInCallback("?code=abc"), false);
    assert.equal(isSignInCallback("?error=access_denied"), false);
  });
});

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
