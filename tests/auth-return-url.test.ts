import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSignInCallback,
  mergeStashedQuery,
  stripCallbackParams,
} from "../apps/geolibre-desktop/src/lib/auth-return-url";

describe("keeping one login attempt out of the next", () => {
  it("drops Auth0's parameters, keeping the app's", () => {
    assert.equal(
      stripCallbackParams("?code=abc&state=xyz&project=p1&locale=fr"),
      "?project=p1&locale=fr",
    );
  });

  it("drops the parameters a refusal leaves behind", () => {
    // The error screen keeps these: auth0-react cleans the URL only after a
    // callback it accepted. Signing in again from there must not carry them.
    assert.equal(
      stripCallbackParams("?error=access_denied&error_description=Nope&state=xyz&locale=fr"),
      "?locale=fr",
    );
  });

  it("returns an empty string when only Auth0's parameters were present", () => {
    assert.equal(stripCallbackParams("?code=abc&state=xyz"), "");
    assert.equal(stripCallbackParams(""), "");
  });

  it("survives a retry round trip without re-arming the error", () => {
    // Deep link → refused → "Try again" stashes the error screen's URL → a
    // successful callback merges it back. `error` must not reappear, or the SDK
    // rejects the login that just succeeded and every retry does it again.
    const deepLink = "?project=p1&locale=fr";
    const refused = mergeStashedQuery(
      "?error=access_denied&error_description=Nope&state=s1",
      stripCallbackParams(deepLink),
    );
    const retryStash = stripCallbackParams(refused);
    const accepted = mergeStashedQuery("?code=c2&state=s2", retryStash);
    const params = new URLSearchParams(accepted);
    assert.equal(params.has("error"), false, accepted);
    assert.equal(params.has("error_description"), false, accepted);
    assert.equal(params.get("code"), "c2");
    assert.equal(params.get("state"), "s2");
    assert.equal(params.get("project"), "p1");
    assert.equal(params.get("locale"), "fr");
  });
});

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
